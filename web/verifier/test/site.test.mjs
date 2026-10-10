import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  assert.match(policy, /font-src 'self'(;|$)/);
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
  assert.equal((css.match(/#E8531F/gi) ?? []).length, 1, "orange is defined once, as the signal token");
  assert.match(css, /--signal: #E8531F;/);
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const uses = body.split(";").filter((decl) => /var\(--(signal|series-human)\)/.test(decl));
    if (!uses.length) continue;
    const onlyToken = uses.every((decl) => /^\s*--series-human:\s*var\(--signal\)/.test(decl));
    assert.ok(onlyToken || /human|blocked|sig/.test(selector), `orange used outside the signature: ${selector.trim()}`);
  }
});

test("every view has a menu entry and every menu entry has a view", () => {
  const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  const routes = [...html.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...views].sort(), [...routes].sort());
  assert.deepEqual(views, ["overview", "verify", "cases", "rules", "onchain", "security"]);
  for (const route of routes) assert.match(html, new RegExp(`data-route="${route}" aria-label="[^"]+"`));
});

test("the intro draws the logo from the brand geometry, not from a font", () => {
  const lockup = readFileSync(path.join(root, "brand", "coorre_lockup_A_light.svg"), "utf8");
  for (const d of [...lockup.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])) assert.ok(html.includes(d), d.slice(0, 30));
});

test("the rail logo is framed so no part of the mark is cut", () => {
  const svg = /<svg class="rail-logo" viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/.exec(html);
  assert.ok(svg, "rail logo not found");
  const [x0, y0, w, h] = svg[1].split(/\s+/).map(Number);
  const stroke = Number(/\.mark-arc \{[^}]*stroke-width: (\d+)/.exec(css)[1]);
  const arc = /d="M ([\d.]+) ([\d.]+) A ([\d.]+) [\d.]+ 0 1 0 ([\d.]+) ([\d.]+)"/.exec(svg[2]).slice(1).map(Number);
  const [ax, ay1, r, , ay2] = arc;
  const half = (ay2 - ay1) / 2;
  const cx = ax - Math.sqrt(r * r - half * half);
  const cy = ay1 + half;
  const extents = [[cx - r - stroke / 2, cy - r - stroke / 2, cx + r, cy + r + stroke / 2]];
  for (const m of svg[2].matchAll(/<circle[^>]*cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)) {
    const [x, y, cr] = m.slice(1).map(Number);
    extents.push([x - cr, y - cr, x + cr, y + cr]);
  }
  for (const [left, top, right, bottom] of extents) {
    assert.ok(left >= x0 && top >= y0 && right <= x0 + w && bottom <= y0 + h, `${[left, top, right, bottom]} outside ${svg[1]}`);
  }
});

test("every font is self-hosted, published and licensed", () => {
  const workflow = readFileSync(path.join(root, "..", "..", ".github", "workflows", "pages.yml"), "utf8");
  const fonts = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(fonts.length >= 5, fonts.join(", "));
  for (const font of fonts) {
    assert.match(font, /^fonts\/[A-Za-z0-9-]+\.woff2$/);
    assert.ok(existsSync(path.join(root, font)), `missing ${font}`);
  }
  assert.ok(workflow.includes("web/verifier/fonts"), "pages.yml does not copy the fonts");
  assert.match(readFileSync(path.join(root, "fonts", "OFL.txt"), "utf8"), /SIL Open Font License, Version 1\.1/);
  assert.ok(!/font-weight: (?!400|500|600)\d+/.test(css), "a weight without a loaded font file");
});

test("the pages workflow publishes every file the page loads", () => {
  const workflow = readFileSync(path.join(root, "..", "..", ".github", "workflows", "pages.yml"), "utf8");
  const modules = new Set([...app.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith("pkg/")));
  for (const file of fs_list(root)) {
    if (/\.(js|json)$/.test(file) && !["package.json"].includes(file) && (modules.has(file) || file === "site-data.json" || file === "app.js")) {
      assert.ok(workflow.includes(`web/verifier/${file}`), `pages.yml does not copy ${file}`);
    }
  }
});

function fs_list(dir) {
  return readdirSync(dir).filter((f) => !f.startsWith("."));
}
