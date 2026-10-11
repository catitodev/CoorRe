import init, * as wasm from "./pkg/coorre_verify.js";
import { verifyBundle, explorerUrl, isAccountSnapshot } from "./verify-core.js";
import { actorKindLabel, autonomyLabel, renderCaseDetail, renderCaseList, renderOnchain, renderOverview, renderRules, sol } from "./views.js";
import { chooseLanguage, language, LANGUAGES, setLanguage, staticText, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const BUNDLE_FORMAT = "coorre-audit-bundle/1";
const CHECK_PURPOSE = {
  1: () => t("Each document matches the hash its evidence declares."),
  2: () => t("Each signed step hashes to the value that was anchored, and its rule is included."),
  3: () => t("Each step carries a valid Ed25519 signature."),
  4: () => t("The key that signed each step holds that role on-chain."),
  5: () => t("The steps form one unbroken chain from the case to its final state."),
  6: () => t("The accounts belong to the CoorRe program and hold exactly the recomputed values."),
  7: () => t("Re-running the rule on the documents gives the recorded decision."),
};
export const CHECK_NAMES = {
  1: { name: "Artifact digests match", text: () => [t("Artifact digests match"), t("Artifact digests")] },
  2: { name: "Evidence hash recomputed (JCS + SHA-256)", text: () => [t("Evidence hash recomputed (JCS + SHA-256)"), t("Evidence hash")] },
  3: { name: "Ed25519 eddsa-jcs-2022 proof valid", text: () => [t("Ed25519 eddsa-jcs-2022 proof valid"), t("Ed25519 eddsa-jcs-2022")] },
  4: { name: "Signer bound to the on-chain role key", text: () => [t("Signer bound to the on-chain role key"), t("Signer bound")] },
  5: { name: "Hash chain continuous from genesis", text: () => [t("Hash chain continuous from genesis"), t("Hash chain")] },
  6: { name: "On-chain match (owner, discriminator, content)", text: () => [t("On-chain match (owner, discriminator, content)"), t("On-chain match")] },
  7: { name: "Automated decisions reproduced from the rule", text: () => [t("Automated decisions reproduced from the rule"), t("Automated decisions")] },
};
const RECOMMENDATIONS = {
  auto_approve: () => t("auto-approve"),
  escalate: () => t("escalate"),
};
const selected = new Map();
const buttons = ["sample-sup-001", "sample-sup-002", "sample-agt-002", "sample-pes-002", "verify-files"];

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function link(text, url) {
  if (!url) return document.createTextNode(text);
  const a = el("a", null, text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function short(value) {
  if (typeof value !== "string") return "";
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

let lastStatus = null;
let lastResult = null;

function setStatus(message, isError = false) {
  lastStatus = { message, isError };
  const status = $("status");
  status.textContent = message();
  status.classList.toggle("error", isError);
}

function checkTitle(c) {
  const known = CHECK_NAMES[c.id];
  if (language() !== "en" && known && known.name === c.name) return known.text();
  return [c.name, c.name.split(" ").slice(0, 2).join(" ")];
}

function setBusy(busy) {
  for (const id of buttons) $(id).disabled = busy;
  $("trail").hidden = !busy;
}

function decisionText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  if (typeof payload.decision === "string") parts.push(payload.decision);
  if (typeof payload.recommendation === "string") {
    const recommendation = language() !== "en" && RECOMMENDATIONS[payload.recommendation] ? RECOMMENDATIONS[payload.recommendation]() : payload.recommendation.replace("_", "-");
    parts.push(t("recommends {recommendation}", { recommendation }));
  }
  if (Array.isArray(payload.documents)) parts.push(t("{count} documents submitted", { count: payload.documents.length }));
  if (Array.isArray(payload.reasons) && payload.reasons.length) parts.push(payload.reasons.join("; "));
  if (Array.isArray(payload.findings) && payload.findings.length) parts.push(payload.findings.join("; "));
  if (typeof payload.justification === "string") parts.push(`“${payload.justification}”`);
  return parts.join(" · ");
}

function render(result, expected) {
  lastResult = { result, expected };
  const { report } = result;
  const passed = report.checks.every((c) => c.status === "PASS");
  const count = report.checks.filter((c) => c.status === "PASS").length;
  const network = expected.networkId;

  const verdict = $("verdict");
  const notes = [
    result.tamperedName ? ` · ${t("one byte of {name} was changed on purpose", { name: result.tamperedName })}` : "",
    result.missing.length ? ` · ${t("missing files: {names}", { names: result.missing.join(", ") })}` : "",
    result.bundleProgramId !== expected.programId ? ` · ${t("the bundle names program {program}", { program: result.bundleProgramId })}` : "",
    result.source === "snapshot" ? ` · ${t("accounts from the recorded devnet snapshot, slot {slot}", { slot: result.slot })}` : "",
  ].filter(Boolean);
  verdict.replaceChildren(
    el("strong", null, passed ? t("{passed}/{total} checks passed", { passed: count, total: report.checks.length }) : t("Verification failed: {passed}/{total} checks passed", { passed: count, total: report.checks.length })),
    ...notes.map((note) => el("span", null, note))
  );
  verdict.className = `verdict ${passed ? "pass" : "fail"}`;

  const s = report.summary;
  const rows = [
    [t("Case"), document.createTextNode(s.case_ref)],
    [t("Program"), link(s.program_id, explorerUrl("address", s.program_id, network))],
    [t("Case record"), link(s.case_record, explorerUrl("address", s.case_record, network))],
    [t("Final state"), document.createTextNode(s.final_state ?? t("unknown"))],
    [t("Amount"), document.createTextNode(sol(s.amount_lamports))],
    [t("Automation limit"), document.createTextNode(sol(s.autonomy_limit_lamports))],
    [t("Creator"), link(s.creator ?? "", explorerUrl("address", s.creator, network))],
    [t("Payee key"), link(s.submitter ?? "", explorerUrl("address", s.submitter, network))],
    [t("AI agent key"), link(s.agent ?? "", explorerUrl("address", s.agent, network))],
    [t("Rule engine key"), link(s.rule_engine ?? "", explorerUrl("address", s.rule_engine, network))],
    [t("Approver key"), link(s.approver ?? "", explorerUrl("address", s.approver, network))],
  ];
  $("summary").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", null, term), el("dd", null, value)]));

  const body = $("timeline").querySelector("tbody");
  body.replaceChildren(
    ...report.timeline.map((step) => {
      const onchain = el("td", null);
      onchain.append(link(`${t("anchor")} ${short(step.anchor_account)}`, explorerUrl("address", step.anchor_account, network)));
      if (step.anchor_slot) onchain.append(el("span", "muted", ` ${t("slot")} ${step.anchor_slot}`));
      if (step.tx_signature) onchain.append(el("br"), link(`tx ${short(step.tx_signature)}`, explorerUrl("tx", step.tx_signature, network)));
      return el(
        "tr",
        null,
        el("td", null, `${step.from_state} → ${step.to_state}`),
        el("td", null, language() === "en" ? `${step.actor_kind} · ${step.autonomy}` : `${actorKindLabel(step.actor_kind)} · ${autonomyLabel(step.autonomy)}`, el("br"), el("span", "muted", short(step.actor_did))),
        el("td", null, decisionText(step.payload)),
        el("td", null, step.valid_from),
        onchain
      );
    })
  );

  $("check-chain").replaceChildren(
    ...report.checks.map((c, i) => {
      const [name, shortName] = checkTitle(c);
      const item = el("li", c.status === "PASS" ? "pass" : "fail", el("span", "pin", String(c.id)), el("span", "name", shortName));
      item.style.setProperty("--i", String(i));
      item.title = `${c.id}. ${name}: ${c.status}`;
      return item;
    })
  );

  $("checks").replaceChildren(
    ...report.checks.map((c, i) => {
      const pass = c.status === "PASS";
      const details = el("details", null);
      details.open = !pass;
      details.append(
        el(
          "summary",
          null,
          el("span", "check-num", String(c.id)),
          el("span", "check-text", el("strong", null, checkTitle(c)[0]), el("span", "check-purpose", CHECK_PURPOSE[c.id] ? CHECK_PURPOSE[c.id]() : "")),
          el("span", "badge", pass ? t("Pass") : t("Fail"))
        ),
        el("ul", null, ...c.details.map((d) => el("li", null, d)))
      );
      const item = el("li", `check ${pass ? "pass" : "fail"}`, details);
      item.style.setProperty("--i", String(i));
      return item;
    })
  );
  $("result").hidden = false;
}

async function run(bundleText, files, snapshot = null) {
  setBusy(true);
  setStatus(() => t("Checking…"));
  const expected = {
    programId: $("program-id").value.trim(),
    networkId: $("network-id").value.trim(),
  };
  try {
    const result = await verifyBundle({
      wasm,
      bundleText,
      files,
      rpcUrl: $("rpc-url").value.trim(),
      programId: expected.programId,
      networkId: expected.networkId,
      tamper: $("tamper").checked,
      snapshot,
    });
    render(result, expected);
    setStatus(() =>
      result.source === "snapshot"
        ? t("Accounts read from the recorded devnet snapshot (slot {slot}); no network request was made. Everything was computed in this browser.", { slot: result.slot })
        : t("Accounts read from the RPC at slot {slot}. Everything else was computed in this browser.", { slot: result.slot })
    );
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("result").hidden = true;
    lastResult = null;
    setStatus(() => t("Could not verify: {error}", { error: error.message ?? error }), true);
  } finally {
    setBusy(false);
  }
}

async function runSample(id) {
  try {
    const bundleText = await (await fetch(`samples/${id}/bundle.json`)).text();
    const names = JSON.parse(bundleText).artifacts.map((a) => a.name);
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        bytes: new Uint8Array(await (await fetch(`samples/${id}/artifacts/${encodeURIComponent(name)}`)).arrayBuffer()),
      }))
    );
    const snapshot = $("use-snapshot").checked ? await (await fetch("samples/devnet-snapshot.json")).json() : null;
    await run(bundleText, files, snapshot);
  } catch (error) {
    setStatus(() => t("Could not load the sample: {error}", { error: error.message ?? error }), true);
  }
}

function renderFileList() {
  $("file-list").replaceChildren(
    ...[...selected.entries()].map(([name, bytes]) => el("li", null, t("{name} ({count} bytes)", { name, count: bytes.length })))
  );
}

async function addFiles(fileList) {
  for (const file of fileList) selected.set(file.name, new Uint8Array(await file.arrayBuffer()));
  renderFileList();
}

function parsedJson(name, bytes) {
  if (!name.endsWith(".json")) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function findBundle() {
  for (const [name, bytes] of selected) {
    const value = parsedJson(name, bytes);
    if (value?.format === BUNDLE_FORMAT) return { name, text: new TextDecoder().decode(bytes) };
  }
  return null;
}

function findSnapshot() {
  for (const [name, bytes] of selected) {
    const value = parsedJson(name, bytes);
    if (isAccountSnapshot(value)) return { name, value };
  }
  return null;
}

async function verifySelected() {
  const bundle = findBundle();
  if (!bundle) {
    setStatus(() => t("No audit bundle found among the files (a JSON file with format coorre-audit-bundle/1)."), true);
    return;
  }
  const snapshot = findSnapshot();
  const files = [...selected.entries()].filter(([name]) => name !== bundle.name && name !== snapshot?.name).map(([name, bytes]) => ({ name, bytes }));
  await run(bundle.text, files, snapshot?.value ?? null);
}

const ROUTES = ["overview", "verify", "cases", "rules", "onchain", "security"];
const SAMPLES = ["SUP-001", "SUP-002", "AGT-002", "PES-002"];
const rendered = new Set();
let siteData = null;

function rpcUrl() {
  return $("rpc-url").value.trim();
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  for (const source of document.querySelectorAll("picture source[srcset*='_dark']")) {
    source.media = dark ? "all" : "not all";
    const img = source.parentElement.querySelector("img");
    img.src = img.getAttribute("src");
  }
  themeLabel();
}

function themeLabel() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  $("theme-label").textContent = dark ? t("Light") : t("Dark");
}

const staticNodes = [];

function collectStatic() {
  const skip = "script, style, svg, #theme-label, .lang-switch";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.trim() && !node.parentElement.closest(skip)) staticNodes.push({ node, original: node.nodeValue });
  }
  for (const element of document.body.querySelectorAll("[aria-label], [alt], [title], [placeholder]")) {
    if (element.closest(skip)) continue;
    for (const attribute of ["aria-label", "alt", "title", "placeholder"]) {
      if (element.hasAttribute(attribute)) staticNodes.push({ element, attribute, original: element.getAttribute(attribute) });
    }
  }
}

function translateStatic() {
  for (const entry of staticNodes) {
    const value = staticText(entry.original);
    if (entry.node) entry.node.nodeValue = value;
    else entry.element.setAttribute(entry.attribute, value);
  }
}

function languageButtons() {
  const other = LANGUAGES[language() === "en" ? "pt" : "en"];
  for (const button of document.querySelectorAll(".lang-switch")) {
    button.lang = other.tag;
    button.setAttribute("aria-label", other.switchLabel);
    button.querySelector(".lang-code").textContent = other.code;
    button.querySelector(".lang-name").textContent = other.name;
  }
}

function applyLanguage(lang) {
  setLanguage(lang);
  document.documentElement.lang = LANGUAGES[language()].tag;
  translateStatic();
  languageButtons();
  themeLabel();
}

function storedLanguage() {
  try {
    return localStorage.getItem("coorre-lang");
  } catch {
    return null;
  }
}

function storeLanguage(lang) {
  try {
    localStorage.setItem("coorre-lang", lang);
  } catch {
    return;
  }
}

function setupLanguage() {
  collectStatic();
  applyLanguage(chooseLanguage({ query: new URLSearchParams(location.search).get("lang"), stored: storedLanguage() }));
  const toggle = () => {
    const next = language() === "en" ? "pt" : "en";
    applyLanguage(next);
    storeLanguage(next);
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", next);
      history.replaceState(null, "", url);
    }
    refresh();
  };
  for (const button of document.querySelectorAll(".lang-switch")) button.addEventListener("click", toggle);
}

function setupTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem("coorre-theme");
  } catch {
    stored = null;
  }
  applyTheme(stored === "dark" || stored === "light" ? stored : null);
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("coorre-theme", next);
    } catch {
      return;
    }
  });
}

function show(route, arg, sub, refreshing = false) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.dataset.view !== route;
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.route === route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `CoorRe · ${document.querySelector(`.nav a[data-route="${route}"]`).getAttribute("aria-label")}`;
  document.querySelectorAll(`[data-view="${route}"] .card, [data-view="${route}"] .panel`).forEach((card, i) => card.style.setProperty("--i", String(Math.min(i, 8))));
  if (siteData) {
    if (route === "overview" && !rendered.has(route)) renderOverview(siteData, rpcUrl());
    if (route === "rules" && !rendered.has(route)) renderRules(siteData);
    if (route === "onchain" && !rendered.has(route)) renderOnchain(siteData, rpcUrl());
    if (route === "cases") {
      $("cases-list").hidden = Boolean(arg);
      $("case-detail").hidden = !arg;
      if (arg) renderCaseDetail(siteData, arg, rpcUrl(), sub);
      else if (!rendered.has(route)) renderCaseList(siteData);
    }
    if (route !== "cases" || !arg) rendered.add(route);
  }
  if (refreshing) return;
  if (route === "verify" && arg && SAMPLES.includes(arg)) runSample(arg);
  window.scrollTo(0, 0);
}

function parseRoute() {
  const [name, arg, sub] = location.hash.replace(/^#/, "").split("/");
  return [ROUTES.includes(name) ? name : "overview", arg ? decodeURIComponent(arg) : undefined, sub && /^step-\d+$/.test(sub) ? sub : undefined];
}

function refresh() {
  rendered.clear();
  const [name, arg] = parseRoute();
  show(name, arg, undefined, true);
  if (lastResult) render(lastResult.result, lastResult.expected);
  if (lastStatus) setStatus(lastStatus.message, lastStatus.isError);
  if (selected.size) renderFileList();
}

function route(event) {
  show(...parseRoute());
  if (event) $("main").focus({ preventScroll: true, focusVisible: false });
}

function intro() {
  const node = $("intro");
  let seen = false;
  try {
    seen = sessionStorage.getItem("coorre-intro") === "seen";
    sessionStorage.setItem("coorre-intro", "seen");
  } catch {
    seen = false;
  }
  if (seen || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  node.hidden = false;
  const close = () => {
    node.hidden = true;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  node.addEventListener("click", close);
  $("intro-skip").addEventListener("click", close);
  setTimeout(close, 2950);
}

async function main() {
  setupLanguage();
  intro();
  setupTheme();
  await init();
  $("program-id").value = wasm.defaultProgramId();
  $("network-id").value = wasm.defaultNetworkId();
  $("footer-program").textContent = wasm.defaultProgramId();
  $("sample-sup-001").addEventListener("click", () => runSample("SUP-001"));
  $("sample-sup-002").addEventListener("click", () => runSample("SUP-002"));
  $("sample-agt-002").addEventListener("click", () => runSample("AGT-002"));
  $("sample-pes-002").addEventListener("click", () => runSample("PES-002"));
  $("verify-files").addEventListener("click", verifySelected);
  $("file-input").addEventListener("change", (event) => addFiles(event.target.files));
  const zone = $("dropzone");
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    addFiles(event.dataTransfer.files);
  });
  setStatus(() => t("Ready."));
  try {
    siteData = await (await fetch("site-data.json")).json();
  } catch (error) {
    setStatus(() => t("Could not load the dashboard data: {error}", { error: error.message ?? error }), true);
  }
  window.addEventListener("hashchange", route);
  route();
}

main().catch((error) => setStatus(() => t("Could not start the verifier: {error}", { error: error.message ?? error }), true));
