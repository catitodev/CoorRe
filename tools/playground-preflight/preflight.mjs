#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RAW = "https://raw.githubusercontent.com/solana-playground/solana-playground/master/";

export const SOURCES = {
  jsRuntime: "client/src/utils/js-runtime/js-runtime.ts",
  supportedPackages: "supported-packages.json",
  clientPackage: "client/package.json",
  legacyTemplate: "server/src/templates/legacy.rs",
  templatesMod: "server/src/templates/mod.rs",
  legacyManifest: "server/templates/legacy/programs/program/Cargo.toml",
  legacyLock: "server/templates/legacy/Cargo.lock",
};

export function parseStringArray(source, constName) {
  const match = new RegExp(`const ${constName} = \\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`${constName} not found`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function parseTranspileOptions(source) {
  const match = /code = transpile\(code, \{([^}]*)\}/.exec(source);
  if (!match) throw new Error("transpile call not found");
  const target = /target:\s*ScriptTarget\.(\w+)/.exec(match[1])?.[1];
  const removeComments = /removeComments:\s*true/.test(match[1]);
  if (!target) throw new Error("transpile target not found");
  return { target, removeComments };
}

export function parseMochaGlobals(source) {
  const start = source.indexOf("// Set mocha globals");
  if (start < 0) throw new Error("mocha globals block not found");
  const block = source.slice(start, source.indexOf(");", start));
  return [...block.matchAll(/\["(\w+)",/g)].map((m) => m[1]).filter((name) => name !== "_run");
}

export function parseBaseGlobals(source) {
  return ["console", "Uint8Array", "sleep", "pg"].filter((name) => source.includes(`["${name}",`));
}

export function parseWrapper(source) {
  const match = /code = `\(async \(\) => \{([\s\S]*?)\}\)\(\)`;/.exec(source);
  if (!match) throw new Error("code wrapper not found");
  return `(async () => {${match[1].replace(/\\n/g, "\n")}})()`;
}

export function parsePackageGlobals(supportedPackagesJson) {
  const globals = JSON.parse(supportedPackagesJson).global ?? {};
  return Object.values(globals)
    .map((style) => style.as ?? style.named ?? style.default)
    .sort();
}

export function parseLegacyTemplate(source) {
  const rustVersion = /rust_version:\s*"([^"]+)"/.exec(source)?.[1];
  const solanaVersion = /solana_version:\s*"([^"]+)"/.exec(source)?.[1];
  if (!rustVersion || !solanaVersion) throw new Error("legacy template versions not found");
  return { rustVersion, solanaVersion };
}

export function parseAnchorLangLine(manifest) {
  const line = manifest.split("\n").find((l) => l.startsWith("anchor-lang"));
  if (!line) throw new Error("anchor-lang dependency not found");
  return line.trim();
}

export function lockVersions(lock, crate) {
  return [...lock.matchAll(new RegExp(`name = "${crate}"\\nversion = "([^"]+)"`, "g"))].map((m) => m[1]);
}

export function programDependencyVersion(lock, crate) {
  const block = lock.split("[[package]]").find((b) => /\nname = "program"\n/.test(b));
  if (!block) throw new Error("template program package not found in lockfile");
  const entry = [...block.matchAll(/^ "([^"]+)",?$/gm)].map((m) => m[1]).find((d) => d === crate || d.startsWith(`${crate} `));
  if (!entry) throw new Error(`template program does not depend on ${crate}`);
  const pinned = entry.split(" ")[1];
  if (pinned) return pinned;
  const versions = lockVersions(lock, crate);
  if (versions.length !== 1) throw new Error(`ambiguous ${crate} version`);
  return versions[0];
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function fetchText(file) {
  const response = await fetch(RAW + file, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.text();
}

export function buildReference(files) {
  const js = files.jsRuntime;
  return {
    jsRuntime: {
      transpile: parseTranspileOptions(js),
      wrapper: parseWrapper(js),
      blacklistedGlobals: parseStringArray(js, "BLACKLISTED_GLOBALS"),
      undefinedGlobals: parseStringArray(js, "UNDEFINED_GLOBALS"),
      requiresDescribe: js.includes('!code.includes("describe")'),
      baseGlobals: parseBaseGlobals(js),
      mochaGlobals: parseMochaGlobals(js),
      packageGlobals: parsePackageGlobals(files.supportedPackages),
    },
    typescriptVersion: JSON.parse(files.clientPackage).dependencies?.typescript?.replace(/^=/, ""),
    legacyTemplate: {
      isDefault: /find\(\|t\| t\.name == legacy\.name\)/.test(files.templatesMod),
      ...parseLegacyTemplate(files.legacyTemplate),
      anchorLangDependency: parseAnchorLangLine(files.legacyManifest),
      programAnchorLang: programDependencyVersion(files.legacyLock, "anchor-lang"),
      programSolanaProgram: programDependencyVersion(files.legacyLock, "solana-program"),
      cargoLockSha256: sha256(files.legacyLock),
    },
  };
}

export async function fetchLiveReference() {
  const files = {};
  for (const [key, file] of Object.entries(SOURCES)) files[key] = await fetchText(file);
  return { reference: buildReference(files), lock: files.legacyLock };
}

export function diffReference(pinned, live, prefix = "") {
  const keys = new Set([...Object.keys(pinned ?? {}), ...Object.keys(live ?? {})].filter((k) => !k.startsWith("_")));
  const out = [];
  for (const key of keys) {
    const a = pinned?.[key];
    const b = live?.[key];
    const here = prefix ? `${prefix}.${key}` : key;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      out.push(...diffReference(a, b, here));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${here}: pinned ${JSON.stringify(a)} != live ${JSON.stringify(b)}`);
    }
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function countTestCallSites(source) {
  const file = ts.createSourceFile("t.ts", source, ts.ScriptTarget.Latest, true);
  const counts = { it: 0, specify: 0, xit: 0, xspecify: 0 };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in counts) {
      counts[node.expression.text] += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { active: counts.it + counts.specify, skipped: counts.xit + counts.xspecify };
}

export function undefinedNames(source, reference) {
  const r = reference.jsRuntime;
  const declared = [...r.baseGlobals, ...r.mochaGlobals, ...r.packageGlobals, "_run"];
  const ambient = declared
    .map((name) => (name === "sleep" ? "declare function sleep(ms: number): Promise<void>;" : `declare const ${name}: any;`))
    .join("\n");
  const options = { target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts", "lib.dom.d.ts"], noEmit: true, types: [], skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const virtual = { "/virtual/test.ts": source, "/virtual/globals.d.ts": ambient };
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    name in virtual ? ts.createSourceFile(name, virtual[name], version) : getSourceFile(name, version);
  host.fileExists = ((exists) => (name) => name in virtual || exists(name))(host.fileExists.bind(host));
  host.readFile = ((read) => (name) => virtual[name] ?? read(name))(host.readFile.bind(host));
  const program = ts.createProgram(Object.keys(virtual), options, host);
  const file = program.getSourceFile("/virtual/test.ts");
  const codes = new Set([2304, 2552, 2580, 2582, 2583, 2584, 2591, 2592, 2593]);
  return program
    .getSemanticDiagnostics(file)
    .filter((d) => codes.has(d.code))
    .map((d) => `line ${lineOf(source, d.start)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

export async function registeredTests(source, reference) {
  const r = reference.jsRuntime;
  let code = source;
  for (const keyword of r.undefinedGlobals) code = `${keyword} = undefined;` + code;
  const wrapped = r.wrapper.replace("${code}", () => code).replace("${endCode}", () => "_run()");
  const output = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget[r.transpile.target], removeComments: r.transpile.removeComments },
    reportDiagnostics: true,
  });
  const syntax = (output.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
  if (syntax.length) return { syntax, registered: [], uncaught: [] };

  const inert = new Proxy(function () {}, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => 0 : key === Symbol.iterator || key === "then" ? undefined : inert),
    apply: () => inert,
    construct: () => inert,
  });
  const registered = [];
  const uncaught = [];
  const stack = [];
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  const suite = (name, fn) => {
    stack.push(name);
    try {
      fn?.();
    } finally {
      stack.pop();
    }
  };
  const register = (name) => registered.push([...stack, name].join(" > "));
  const sandbox = {
    console: { log: (...args) => args[0] === "Uncaught error:" && uncaught.push(String(args[1])), error: () => {}, warn: () => {} },
    Uint8Array,
    Buffer,
    sleep: async () => {},
    _run: () => finished(),
    describe: suite,
    context: suite,
    xdescribe: () => {},
    xcontext: () => {},
    it: register,
    specify: register,
    xit: () => {},
    xspecify: () => {},
    before: () => {},
    after: () => {},
    beforeEach: () => {},
    afterEach: () => {},
  };
  for (const name of [...r.packageGlobals, "pg"]) if (!(name in sandbox)) sandbox[name] = inert;
  vm.runInNewContext(output.outputText, sandbox, { timeout: 10_000 });
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  return { syntax, registered, uncaught };
}

export async function checkTestSource(source, reference) {
  const problems = [];
  for (const keyword of reference.jsRuntime.blacklistedGlobals) {
    let index = source.indexOf(keyword);
    while (index >= 0) {
      problems.push(`blocked word "${keyword}" at line ${lineOf(source, index)} (Playground rejects it anywhere, even inside words or comments)`);
      index = source.indexOf(keyword, index + 1);
    }
  }
  if (reference.jsRuntime.requiresDescribe && !source.includes("describe")) {
    problems.push(`no "describe": Playground refuses to run it as a test`);
  }
  for (const issue of undefinedNames(source, reference)) problems.push(`not available in Playground: ${issue}`);

  const callSites = countTestCallSites(source);
  const { syntax, registered, uncaught } = await registeredTests(source, reference);
  for (const message of syntax) problems.push(`ES5 transpile error: ${message}`);
  for (const message of uncaught) problems.push(`error while registering tests: ${message}`);
  if (!syntax.length && registered.length !== callSites.active) {
    problems.push(
      `${callSites.active} it()/specify() call sites but ${registered.length} tests register after ES5 transpile ` +
        `(a loop or condition around a test is not doing what it looks like)`
    );
  }
  if (callSites.skipped) problems.push(`${callSites.skipped} skipped test(s) (xit/xspecify)`);
  return { problems, registered, callSites };
}

function findRustup() {
  const candidates = ["rustup", path.join(homedir(), ".cargo", "bin", "rustup")];
  return candidates.find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
}

export function checkProgram(name, sourceFile, reference, lockFile) {
  const rustup = findRustup();
  if (!rustup) return { ok: false, detail: "rustup not found" };
  const toolchain = reference.legacyTemplate.rustVersion;
  if (spawnSync(rustup, ["run", toolchain, "rustc", "--version"], { stdio: "ignore" }).status !== 0) {
    return { ok: false, detail: `Rust ${toolchain} missing; install it with: rustup toolchain install ${toolchain} --profile minimal` };
  }
  const work = path.join(ROOT, "target", "playground-preflight", name);
  mkdirSync(path.join(work, "src"), { recursive: true });
  writeFileSync(
    path.join(work, "Cargo.toml"),
    [
      "[package]",
      'name = "program"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[lib]",
      'crate-type = ["cdylib", "lib"]',
      "",
      "[dependencies]",
      reference.legacyTemplate.anchorLangDependency,
      "",
    ].join("\n")
  );
  copyFileSync(lockFile, path.join(work, "Cargo.lock"));
  copyFileSync(sourceFile, path.join(work, "src", "lib.rs"));
  const result = spawnSync(rustup, ["run", toolchain, "cargo", "check", "--quiet", "--message-format", "short"], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(ROOT, "target", "playground-preflight", "target"),
      CARGO_REGISTRIES_CRATES_IO_PROTOCOL: "sparse",
      RUSTFLAGS: "-D warnings",
    },
  });
  const lock = readFileSync(path.join(work, "Cargo.lock"), "utf8");
  const resolved = { "anchor-lang": lockVersions(lock, "anchor-lang"), "solana-program": lockVersions(lock, "solana-program") };
  const expected = {
    "anchor-lang": [reference.legacyTemplate.programAnchorLang],
    "solana-program": [reference.legacyTemplate.programSolanaProgram],
  };
  if (JSON.stringify(resolved) !== JSON.stringify(expected)) {
    return { ok: false, detail: `resolved ${JSON.stringify(resolved)} but Playground uses ${JSON.stringify(expected)}` };
  }
  if (result.status !== 0) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-25).join("\n");
    return { ok: false, detail: `cargo check failed with Rust ${toolchain}:\n${tail}` };
  }
  return { ok: true, detail: `Rust ${toolchain}, anchor-lang ${expected["anchor-lang"][0]}, solana-program ${expected["solana-program"][0]}, no warnings` };
}

function listFiles(dir, predicate) {
  const full = path.join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter(predicate)
    .map((f) => path.join(dir, f));
}

async function main(argv) {
  const offline = argv.includes("--offline");
  const skipPrograms = argv.includes("--skip-programs");
  if (argv.includes("--print-live")) {
    const { reference } = await fetchLiveReference();
    process.stdout.write(`${JSON.stringify(reference, null, 2)}\n`);
    return 0;
  }
  const pinned = JSON.parse(readFileSync(path.join(HERE, "reference.json"), "utf8"));
  const pinnedLock = path.join(HERE, "playground-legacy.Cargo.lock");
  const results = [];
  const report = (status, check, detail = "") => results.push({ status, check, detail });

  if (sha256(readFileSync(pinnedLock, "utf8")) !== pinned.legacyTemplate.cargoLockSha256) {
    report("FAIL", "pinned Playground lockfile", "playground-legacy.Cargo.lock does not match reference.json");
  }
  if (offline) {
    report("WARN", "official Playground reference", "skipped (--offline); results rely on the pinned reference");
  } else {
    try {
      const { reference: live } = await fetchLiveReference();
      const changes = diffReference(pinned, live);
      if (changes.length) {
        report("FAIL", "official Playground reference", `Playground changed since the pinned reference:\n  ${changes.join("\n  ")}`);
      } else {
        report("PASS", "official Playground reference", "matches github.com/solana-playground/solana-playground (master)");
      }
    } catch (err) {
      report("FAIL", "official Playground reference", `could not fetch (${err.message}); use --offline to skip deliberately`);
    }
  }

  const testFiles = [
    ...listFiles("onchain/tests", (f) => f.endsWith(".ts")),
    ...listFiles("spike", (f) => f.endsWith(".test.ts")),
  ];
  for (const file of testFiles) {
    const { problems, registered, callSites } = await checkTestSource(readFileSync(path.join(ROOT, file), "utf8"), pinned);
    if (problems.length) report("FAIL", file, problems.join("\n  "));
    else report("PASS", file, `${registered.length} of ${callSites.active} tests register under ${pinned.jsRuntime.transpile.target}`);
  }

  if (skipPrograms) {
    report("WARN", "programs", "skipped (--skip-programs)");
  } else {
    const programs = [
      ...listFiles("onchain/programs", () => true).map((d) => [path.basename(d), path.join(d, "src", "lib.rs")]),
      ...listFiles("spike", (f) => f.endsWith(".rs")).map((f) => [path.basename(f, ".rs"), f]),
    ].filter(([, file]) => existsSync(path.join(ROOT, file)));
    for (const [name, file] of programs) {
      const { ok, detail } = checkProgram(name, path.join(ROOT, file), pinned, pinnedLock);
      report(ok ? "PASS" : "FAIL", file, detail);
    }
  }

  for (const { status, check, detail } of results) {
    process.stdout.write(`${status.padEnd(4)}  ${check}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}\n`);
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  process.stdout.write(failed ? `\n${failed} check(s) failed: do not paste into Playground yet.\n` : "\nAll checks passed: safe to paste into Playground.\n");
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err) => {
      process.stderr.write(`preflight crashed: ${err.stack ?? err}\n`);
      process.exitCode = 2;
    }
  );
}
