import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wasm from "../pkg/coorre_verify.js";
import { verifyBundle } from "../verify-core.js";
import { chooseLanguage, PORTUGUESE, setLanguage, staticText, t, UNCHANGED } from "../i18n.js";

wasm.initSync({ module: readFileSync(new URL("../pkg/coorre_verify_bg.wasm", import.meta.url)) });

const read = (path) => readFileSync(new URL(path, import.meta.url)).toString("utf8");
const data = JSON.parse(read("../site-data.json"));
const placeholders = (text) => (text.match(/\{\w+\}/g) ?? []).sort();

function inPortuguese(run) {
  setLanguage("pt");
  try {
    return run();
  } finally {
    setLanguage("en");
  }
}

function staticTexts(html) {
  const body = html.slice(html.indexOf("<body"));
  const skipTags = new Set(["script", "style", "svg"]);
  const voids = new Set(["input", "br", "img", "source", "meta", "link"]);
  const managed = (token) => /\sid="theme-label"/.test(token) || /\sclass="[^"]*\blang-switch\b/.test(token);
  const stack = [];
  const texts = [];
  const skipping = () => stack.some((e) => e.skip);
  for (const token of body.split(/(<[^>]+>)/)) {
    if (!token) continue;
    if (token.startsWith("</")) {
      const tag = token.slice(2, -1).trim().toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
    } else if (token.startsWith("<") && !token.startsWith("<!")) {
      const tag = /^<([a-zA-Z0-9-]+)/.exec(token)[1].toLowerCase();
      const skip = skipTags.has(tag) || managed(token);
      const selfClosing = token.endsWith("/>") || voids.has(tag);
      if (!selfClosing) stack.push({ tag, skip });
      if (!skip && !skipping()) {
        for (const m of token.matchAll(/\s(?:aria-label|alt|title|placeholder)="([^"]+)"/g)) texts.push(m[1]);
      }
    } else if (token.trim() && !skipping()) {
      texts.push(token.trim().replace(/\s+/g, " "));
    }
  }
  return texts;
}

function scriptTexts() {
  const keys = [];
  for (const file of ["../app.js", "../views.js", "../charts.js"]) {
    for (const m of read(file).matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.push(JSON.parse(`"${m[1]}"`));
  }
  return keys;
}

test("every English text of the page has a Portuguese version, and none is left over", () => {
  const needed = new Set([...staticTexts(read("../index.html")), ...scriptTexts()]);
  assert.ok(needed.size > 300, String(needed.size));
  const missing = [...needed].filter((text) => !(text in PORTUGUESE) && !UNCHANGED.has(text));
  assert.deepEqual(missing, []);
  const unused = Object.keys(PORTUGUESE).filter((text) => !needed.has(text));
  assert.deepEqual(unused, []);
});

test("each Portuguese text keeps the placeholders and the edge spaces of its English text", () => {
  for (const [english, portuguese] of Object.entries(PORTUGUESE)) {
    assert.ok(portuguese.trim(), english);
    assert.deepEqual(placeholders(portuguese), placeholders(english), english);
    assert.equal(/^\s/.test(portuguese), /^\s/.test(english), english);
    assert.equal(/\s$/.test(portuguese), /\s$/.test(english), english);
  }
});

test("English stays exactly as written and Portuguese replaces it", () => {
  assert.equal(t("The creator put {amount} in escrow", { amount: "0.2 SOL" }), "The creator put 0.2 SOL in escrow");
  assert.equal(staticText("  Verify a recorded case\n"), "  Verify a recorded case\n");
  inPortuguese(() => {
    assert.equal(t("The creator put {amount} in escrow", { amount: "0,2 SOL" }), "O criador colocou 0,2 SOL em custódia");
    assert.equal(staticText("  Verify a recorded case\n"), "  Verificar um caso gravado\n");
    assert.equal(staticText("Provable decisions for AI agents."), "Provable decisions for AI agents.");
  });
});

test("the page opens in English unless a language was chosen", () => {
  assert.equal(chooseLanguage({ query: null, stored: null }), "en");
  assert.equal(chooseLanguage({ query: null, stored: "pt" }), "pt");
  assert.equal(chooseLanguage({ query: "en", stored: "pt" }), "en");
  assert.equal(chooseLanguage({ query: "pt", stored: null }), "pt");
  assert.equal(chooseLanguage({ query: "fr", stored: "xx" }), "en");
});

test("every case reads as a complete story in Portuguese, with amounts in Brazilian format", async () => {
  const { caseSteps, sol, stepStory } = await import("../views.js");
  assert.equal(sol(200000000), "0.2 SOL");
  inPortuguese(() => {
    assert.equal(sol(200000000), "0,2 SOL");
    for (const c of data.cases) {
      for (const row of caseSteps(c).filter((r) => r.kind === "step")) {
        const story = stepStory(c, row.step);
        for (const text of [story.title, story.body]) {
          assert.ok(!/\b(undefined|null|NaN)\b|\{\w+\}/.test(text), `${c.id} ${row.step.to}: ${text}`);
        }
        assert.ok(!/\b(The|escrow)\b/.test(story.title), `${c.id} ${row.step.to}: ${story.title}`);
      }
    }
  });
});

test("Portuguese follows the project glossary and avoids the words the narrative rules out", () => {
  for (const text of Object.values(PORTUGUESE)) {
    const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (let i = 1; i < words.length; i += 1) {
      assert.ok(!(["a", "da", "na", "pela"].includes(words[i - 1]) && words[i] === "coorre"), text);
    }
    for (const word of ["escrow", "piloto", "mvp", "regenerativ", "cliente"]) assert.ok(!text.toLowerCase().includes(word), `${word}: ${text}`);
  }
});

test("the Portuguese check names cover the names the WebAssembly verifier reports", async () => {
  const source = read("../app.js");
  const known = Object.fromEntries([...source.matchAll(/(\d): \{ name: "([^"]+)"/g)].map((m) => [Number(m[1]), m[2]]));
  const bundleText = read("../samples/SUP-002/bundle.json");
  const files = JSON.parse(bundleText).artifacts.map((a) => ({ name: a.name, bytes: new Uint8Array(readFileSync(new URL(`../samples/SUP-002/artifacts/${a.name}`, import.meta.url))) }));
  const { report } = await verifyBundle({
    wasm,
    bundleText,
    files,
    rpcUrl: "https://api.devnet.solana.com",
    programId: "9esN1A8K1SASLg17ob81dbSdB4VX8ozc6tBLmJ247Wv",
    networkId: "solana:devnet",
    tamper: false,
    snapshot: JSON.parse(read("../samples/devnet-snapshot.json")),
    fetchImpl: async () => {
      throw new Error("no network request is allowed");
    },
  });
  assert.equal(report.checks.length, 7);
  for (const c of report.checks) {
    assert.equal(known[c.id], c.name, `check ${c.id}`);
    assert.ok(PORTUGUESE[c.name], c.name);
  }
});
