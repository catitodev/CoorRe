import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const css = readFileSync(path.join(root, "style.css"), "utf8");
const app = readFileSync(path.join(root, "app.js"), "utf8");

const workflow = readFileSync(path.join(root, "..", "..", ".github", "workflows", "pages.yml"), "utf8");

function localModules(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.startsWith("pkg/") || !existsSync(path.join(root, file))) return;
    const source = readFileSync(path.join(root, file), "utf8");
    for (const m of source.matchAll(/(?:from|import)\s*\(?\s*"\.\/([^"]+)"/g)) visit(path.posix.join(path.posix.dirname(file), m[1]));
  }
  visit(entry);
  return seen;
}

function jobs(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const blocks = {};
  let name = null;
  for (const line of body.split("\n")) {
    const head = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (head) {
      name = head[1];
      blocks[name] = "\n";
    } else if (name) blocks[name] += `${line}\n`;
  }
  return blocks;
}

const local = (value) => !/^(https?:|data:|#|mailto:)/.test(value);

test("every file referenced by index.html exists", () => {
  const references = [...html.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g)].map((m) => m[1]).filter(local);
  assert.ok(references.length >= 5, references.join(", "));
  for (const reference of references) {
    assert.ok(existsSync(path.join(root, reference)), `missing ${reference}`);
  }
});

test("every module the page loads exists after the wasm build, following imports transitively", () => {
  const modules = localModules("app.js");
  for (const file of ["verify-core.js", "views.js", "charts.js", "live.js", "i18n.js", "pkg/coorre_verify.js"]) assert.ok(modules.has(file), file);
  for (const file of modules) assert.ok(existsSync(path.join(root, file)), `missing ${file}`);
});

test("the content security policy is exactly the reviewed one", () => {
  const policies = [...html.matchAll(/Content-Security-Policy" content="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(policies, ["default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https:; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'"]);
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
  const published = [...localModules("app.js")].filter((f) => !f.startsWith("pkg/"));
  for (const file of [...published, "site-data.json", "style.css", "favicon.svg", "favicon-32.png"]) {
    assert.ok(workflow.includes(`web/verifier/${file}`), `pages.yml does not copy ${file}`);
  }
  for (const dir of ["pkg", "samples", "brand", "fonts"]) assert.ok(workflow.includes(`web/verifier/${dir}`), `pages.yml does not copy ${dir}`);
  const shipped = readdirSync(root).filter((f) => /\.js$/.test(f));
  for (const file of shipped) assert.ok(published.includes(file), `${file} is not loaded by the page; remove it or import it`);
});

test("the pages workflow builds with read access and deploys from main only", () => {
  const blocks = jobs(workflow);
  assert.deepEqual(Object.keys(blocks), ["build", "deploy"]);
  const top = workflow.slice(0, workflow.indexOf("\njobs:\n"));
  assert.match(top, /\npermissions:\n {2}contents: read\n/);
  assert.doesNotMatch(top, /pages:|id-token:/);
  assert.match(blocks.build, /\n {4}permissions:\n {6}contents: read\n/);
  assert.doesNotMatch(blocks.build, /pages: write|id-token|deploy-pages|configure-pages/);
  assert.match(blocks.build, /actions\/upload-pages-artifact@/);
  assert.match(blocks.deploy, /\n {4}needs: build\n/);
  assert.match(blocks.deploy, /\n {4}if: github\.ref == 'refs\/heads\/main'\n/);
  assert.match(blocks.deploy, /\n {4}permissions:\n {6}pages: write\n {6}id-token: write\n/);
  assert.doesNotMatch(blocks.deploy, /actions\/checkout@|run:/);
  assert.equal((workflow.match(/id-token/g) ?? []).length, 1);
  for (const m of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, m[1]);
});

test("the file drop area is not a focus stop without an action, and files can be cleared", () => {
  assert.match(html, /<div id="dropzone" class="dropzone">/);
  assert.match(html, /<button type="button" id="clear-files">Clear files<\/button>/);
  assert.match(app, /\$\("clear-files"\)\.addEventListener\("click", clearFiles\)/);
  assert.match(app, /function clearFiles\(\) \{\n {2}selected\.clear\(\);\n {2}\$\("file-input"\)\.value = "";\n {2}renderFileList\(\);/);
  for (const m of html.matchAll(/<(div|span|section|article|li|p)\b[^>]*\stabindex="0"[^>]*>/g)) assert.match(m[0], /\srole="/, m[0]);
});

test("spacing follows the 4 px scale", () => {
  const off = [];
  for (const m of css.matchAll(/((?:margin|padding)(?:-[a-z]+)?|gap|row-gap|column-gap):\s*([^;]+);/g)) {
    for (const v of m[2].matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const n = Math.abs(Number(v[1]));
      if (n % 4 !== 0 && n !== 1 && n !== 2) off.push(`${m[1]}: ${m[2]}`);
    }
  }
  assert.deepEqual(off, []);
});

test("changing the RPC address reads the chain again from the new address", () => {
  assert.match(app, /\$\("rpc-url"\)\.addEventListener\("change", refresh\)/);
  assert.match(app, /function refresh\(\) \{\n {2}rendered\.clear\(\);/);
});
