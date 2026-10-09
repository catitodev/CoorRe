import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const css = readFileSync(path.join(root, "style.css"), "utf8");
const app = readFileSync(path.join(root, "app.js"), "utf8");

const local = (value) => !/^(https?:|data:|#|mailto:)/.test(value);

test("every file referenced by index.html exists", () => {
  const references = [...html.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g)].map((m) => m[1]).filter(local);
  assert.ok(references.length >= 5, references.join(", "));
  for (const reference of references) {
    assert.ok(existsSync(path.join(root, reference)), `missing ${reference}`);
  }
});

test("every module imported by app.js exists after the wasm build", () => {
  const imports = [...app.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(imports.includes("./verify-core.js"));
  for (const file of imports) assert.ok(existsSync(path.join(root, file)), `missing ${file}`);
});

test("the content security policy stays strict", () => {
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(policy, /img-src 'self'(;|$)/);
  assert.match(policy, /style-src 'self'(;|$)/);
  assert.ok(!/'unsafe-(inline|eval)'|data:/.test(policy), policy);
  assert.ok(!/\sstyle="/.test(html), "inline style attribute");
  assert.ok(!/<style[\s>]/.test(html), "inline style element");
  assert.ok(!/url\(\s*["']?data:/.test(css), "data URI in css");
});

function mediaBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} not found`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return { start, end: i + 1, text: source.slice(start, i + 1) };
  }
  throw new Error("unbalanced braces");
}

test("motion is limited to the trail and respects reduced motion", () => {
  const block = mediaBlock(css, "@media (prefers-reduced-motion: no-preference)");
  const outside = css.slice(0, block.start) + css.slice(block.end);
  assert.ok(!/animation|@keyframes|transition/.test(outside), "motion outside the reduced-motion media query");
  const declared = [...block.text.matchAll(/([a-z-]+):\s*[^;{]+;/g)].map((m) => m[1]);
  const allowed = ["opacity", "transform", "animation", "animation-delay"];
  for (const property of declared) assert.ok(allowed.includes(property), `unexpected property in the motion block: ${property}`);
  assert.ok(declared.includes("animation"));
});

test("the brand tokens are the ones taken from the logo", () => {
  for (const token of ["#10161A", "#E9EEF0", "#1F7A68", "#3FB39B"]) {
    assert.ok(css.toLowerCase().includes(token.toLowerCase()), token);
  }
  assert.ok(!/#E8531F/i.test(css), "orange is reserved for the signature and is not a UI colour");
});
