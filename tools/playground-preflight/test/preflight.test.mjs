import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkTestSource,
  countTestCallSites,
  diffReference,
  parseLegacyTemplate,
  parseMochaGlobals,
  parseStringArray,
  parseTranspileOptions,
  parseWrapper,
  programDependencyVersion,
} from "../preflight.mjs";

const reference = JSON.parse(readFileSync(new URL("../reference.json", import.meta.url), "utf8"));
const lock = readFileSync(new URL("../playground-legacy.Cargo.lock", import.meta.url), "utf8");

const suite = (body) => `describe("suite", () => {\n${body}\n});\n`;

test("a clean test file passes and every test registers", async () => {
  const source = suite(`
    const values: number[] = [1, 2, 3];
    it("one", async () => { assert.equal(values.length, 3); });
    it("two", async () => { await sleep(1); });
    describe("nested", () => { it("three", () => {}); });`);
  const result = await checkTestSource(source, reference);
  assert.deepEqual(result.problems, []);
  assert.equal(result.registered.length, 3);
});

test("catches tests lost by a for...of over an iterator under ES5 (2026-10-08 bug)", async () => {
  const source = suite(`
    it("first", () => {});
    for (const [i, s] of [1, 2, 3].entries()) {
      it("state " + s, () => {});
    }`);
  const { problems, registered } = await checkTestSource(source, reference);
  assert.equal(registered.length, 1, "ES5 turns the loop into zero iterations");
  assert.ok(problems.some((p) => p.includes("2 it()/specify() call sites but 1 tests register")), problems.join("\n"));
});

test("catches blocked words inside other words, strings and comments (2026-10-08 bugs)", async () => {
  for (const [snippet, word] of [
    ['it("documents the rule", () => {});', "document"],
    ['it("opens (or tops up) the vault", () => {});', "top"],
    ['// at each stop the target must fail\nit("x", () => {});', "top"],
    ['it("x", () => { const allocation = 1; });', "location"],
  ]) {
    const { problems } = await checkTestSource(suite(snippet), reference);
    assert.ok(problems.some((p) => p.includes(`blocked word "${word}"`)), `${snippet}\n${problems.join("\n")}`);
  }
});

test("requires describe", async () => {
  const { problems } = await checkTestSource('it("x", () => {});\n', reference);
  assert.ok(problems.some((p) => p.includes('no "describe"')));
});

test("catches names Playground does not provide", async () => {
  const { problems } = await checkTestSource(suite('it("x", () => { const k = process.env.KEY; require("fs"); });'), reference);
  assert.ok(problems.some((p) => p.includes("process")), problems.join("\n"));
  assert.ok(problems.some((p) => p.includes("require")), problems.join("\n"));
});

test("accepts every global Playground does provide", async () => {
  const source = suite(`
    it("globals", async () => {
      const key = web3.Keypair.generate().publicKey;
      const parser = new anchor.EventParser(pg.program.programId, new anchor.BorshCoder(pg.program.idl));
      const n = new BN(1);
      assert.ok(Buffer.from([1]).length === 1 && key && parser && n && borsh && BufferLayout && mocha);
      console.log(new Uint8Array(2), setTimeout);
      await sleep(1);
    });`);
  assert.deepEqual((await checkTestSource(source, reference)).problems, []);
});

test("catches syntax errors and errors thrown while registering", async () => {
  const broken = await checkTestSource(suite('it("x", () => { const = 1; });'), reference);
  assert.ok(broken.problems.some((p) => p.startsWith("ES5 transpile error")), broken.problems.join("\n"));
  const throwing = await checkTestSource(suite('const bad: any = undefined;\nbad.property;\nit("x", () => {});'), reference);
  assert.ok(throwing.problems.some((p) => p.startsWith("error while registering tests")), throwing.problems.join("\n"));
});

test("counts it/specify call sites and flags skipped tests", async () => {
  assert.deepEqual(countTestCallSites('it("a",()=>{}); specify("b",()=>{}); xit("c",()=>{});'), { active: 2, skipped: 1 });
  const { problems } = await checkTestSource(suite('it("a", () => {});\nxit("b", () => {});'), reference);
  assert.ok(problems.some((p) => p.includes("skipped")));
});

test("the repository's Playground test files pass", async () => {
  for (const file of ["../../../onchain/tests/coorre_anchor.test.ts", "../../../spike/playground_spike.test.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const { problems, registered, callSites } = await checkTestSource(source, reference);
    assert.deepEqual(problems, [], file);
    assert.equal(registered.length, callSites.active, file);
  }
});

test("parsers read the official js-runtime format", () => {
  const source = `
const BLACKLISTED_GLOBALS = [
  "window",
  "top",
];
      // Set mocha globals
      globals.push(
        ["describe", describe],
        ["it", it],
        ["_run", mocha.run]
      );
        code = \`(async () => {
  class __Pg { async __run() {\\n\${code}\\n} }
  finally { \${endCode} }
})()\`;
        code = transpile(code, {
          target: ScriptTarget.ES5,
          removeComments: true,
        });`;
  assert.deepEqual(parseStringArray(source, "BLACKLISTED_GLOBALS"), ["window", "top"]);
  assert.deepEqual(parseMochaGlobals(source), ["describe", "it"]);
  assert.deepEqual(parseTranspileOptions(source), { target: "ES5", removeComments: true });
  assert.ok(parseWrapper(source).includes("async __run() {\n${code}\n}"));
});

test("reads the legacy template in the upstream form of 2026-10-15", () => {
  const source = `
pub const fn legacy() -> Template {
    Template {
        name: "legacy",
        rust_version: "1.68.0",
        solana_version: Some("1.17.25"),
        cargo_build_sbf_version: None,
        installation_command: Some(anchor_installation_command!("0.29.0")),
        initial_build_command: "cargo-build-sbf -- --locked",
    }
}`;
  assert.deepEqual(parseLegacyTemplate(source), {
    rustVersion: "1.68.0",
    solanaVersion: "1.17.25",
    cargoBuildSbfVersion: null,
    anchorInstallVersion: "0.29.0",
  });
});

test("reads the legacy template in the earlier plain-string form", () => {
  const source = `rust_version: "1.68.0",\n solana_version: "1.17.25",\n cargo_build_sbf_version: "2.1.0",\n installation_command: None,`;
  assert.deepEqual(parseLegacyTemplate(source), {
    rustVersion: "1.68.0",
    solanaVersion: "1.17.25",
    cargoBuildSbfVersion: "2.1.0",
    anchorInstallVersion: null,
  });
});

test("refuses a legacy template in an unknown form", () => {
  const base = `rust_version: "1.68.0",\n cargo_build_sbf_version: None,\n installation_command: None,`;
  assert.throws(() => parseLegacyTemplate(`${base}\n solana_version: version("1.17.25"),`), /solana_version not found/);
  assert.throws(() => parseLegacyTemplate(`${base}\n solana_version: None,`), /neither solana_version nor cargo_build_sbf_version/);
  assert.throws(() => parseLegacyTemplate(`rust_version: "1.68.0",\n solana_version: "1.17.25",\n cargo_build_sbf_version: None,\n installation_command: Some(custom()),`), /installation_command/);
  assert.throws(() => parseLegacyTemplate(`rust_version: None,\n solana_version: "1.17.25",\n cargo_build_sbf_version: None,\n installation_command: None,`), /rust_version not found/);
});

test("reads the template program's own dependency versions from the lockfile", () => {
  assert.equal(programDependencyVersion(lock, "anchor-lang"), reference.legacyTemplate.programAnchorLang);
  assert.equal(programDependencyVersion(lock, "solana-program"), reference.legacyTemplate.programSolanaProgram);
});

test("reports any change in the official Playground facts", () => {
  const live = structuredClone(reference);
  live.jsRuntime.blacklistedGlobals.push("navigator");
  live.legacyTemplate.rustVersion = "1.75.0";
  live._checked = { date: "later" };
  const changes = diffReference(reference, live);
  assert.equal(changes.length, 2, changes.join("\n"));
  assert.ok(changes.some((c) => c.startsWith("jsRuntime.blacklistedGlobals")));
  assert.ok(changes.some((c) => c.startsWith("legacyTemplate.rustVersion")));
  assert.deepEqual(diffReference(reference, structuredClone(reference)), []);
});
