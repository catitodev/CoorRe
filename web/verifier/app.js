import init, * as wasm from "./pkg/coorre_verify.js";
import { verifyBundle, explorerUrl, isAccountSnapshot } from "./verify-core.js";
import { renderCaseDetail, renderCaseList, renderOnchain, renderOverview, renderRules, sol } from "./views.js";

const $ = (id) => document.getElementById(id);
const BUNDLE_FORMAT = "coorre-audit-bundle/1";
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

function setStatus(text, isError = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  for (const id of buttons) $(id).disabled = busy;
  $("trail").hidden = !busy;
}

function decisionText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  if (typeof payload.decision === "string") parts.push(payload.decision);
  if (typeof payload.recommendation === "string") parts.push(`recommends ${payload.recommendation.replace("_", "-")}`);
  if (Array.isArray(payload.documents)) parts.push(`${payload.documents.length} documents submitted`);
  if (Array.isArray(payload.reasons) && payload.reasons.length) parts.push(payload.reasons.join("; "));
  if (Array.isArray(payload.findings) && payload.findings.length) parts.push(payload.findings.join("; "));
  if (typeof payload.justification === "string") parts.push(`“${payload.justification}”`);
  return parts.join(" · ");
}

function render(result, expected) {
  const { report } = result;
  const passed = report.checks.every((c) => c.status === "PASS");
  const count = report.checks.filter((c) => c.status === "PASS").length;
  const network = expected.networkId;

  const verdict = $("verdict");
  const notes = [
    result.tamperedName ? ` · one byte of ${result.tamperedName} was changed on purpose` : "",
    result.missing.length ? ` · missing files: ${result.missing.join(", ")}` : "",
    result.bundleProgramId !== expected.programId ? ` · the bundle names program ${result.bundleProgramId}` : "",
    result.source === "snapshot" ? ` · accounts from the recorded devnet snapshot, slot ${result.slot}` : "",
  ].filter(Boolean);
  verdict.replaceChildren(
    el("strong", null, passed ? `${count}/${report.checks.length} checks passed` : `Verification failed: ${count}/${report.checks.length} checks passed`),
    ...notes.map((note) => el("span", null, note))
  );
  verdict.className = `verdict ${passed ? "pass" : "fail"}`;

  const s = report.summary;
  const rows = [
    ["Case", document.createTextNode(s.case_ref)],
    ["Program", link(s.program_id, explorerUrl("address", s.program_id, network))],
    ["Case record", link(s.case_record, explorerUrl("address", s.case_record, network))],
    ["Final state", document.createTextNode(s.final_state ?? "unknown")],
    ["Amount", document.createTextNode(sol(s.amount_lamports))],
    ["Automation limit", document.createTextNode(sol(s.autonomy_limit_lamports))],
    ["Creator", link(s.creator ?? "", explorerUrl("address", s.creator, network))],
    ["Payee key", link(s.submitter ?? "", explorerUrl("address", s.submitter, network))],
    ["AI agent key", link(s.agent ?? "", explorerUrl("address", s.agent, network))],
    ["Rule engine key", link(s.rule_engine ?? "", explorerUrl("address", s.rule_engine, network))],
    ["Approver key", link(s.approver ?? "", explorerUrl("address", s.approver, network))],
  ];
  $("summary").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", null, term), el("dd", null, value)]));

  const body = $("timeline").querySelector("tbody");
  body.replaceChildren(
    ...report.timeline.map((t) => {
      const onchain = el("td", null);
      onchain.append(link(`anchor ${short(t.anchor_account)}`, explorerUrl("address", t.anchor_account, network)));
      if (t.anchor_slot) onchain.append(el("span", "muted", ` slot ${t.anchor_slot}`));
      if (t.tx_signature) onchain.append(el("br"), link(`tx ${short(t.tx_signature)}`, explorerUrl("tx", t.tx_signature, network)));
      return el(
        "tr",
        null,
        el("td", null, `${t.from_state} → ${t.to_state}`),
        el("td", null, `${t.actor_kind} · ${t.autonomy}`, el("br"), el("span", "muted", short(t.actor_did))),
        el("td", null, decisionText(t.payload)),
        el("td", null, t.valid_from),
        onchain
      );
    })
  );

  $("check-chain").replaceChildren(
    ...report.checks.map((c, i) => {
      const item = el("li", c.status === "PASS" ? "pass" : "fail", el("span", "pin", String(c.id)), el("span", "name", c.name.split(" ").slice(0, 2).join(" ")));
      item.style.setProperty("--i", String(i));
      item.title = `${c.id}. ${c.name}: ${c.status}`;
      return item;
    })
  );

  $("checks").replaceChildren(
    ...report.checks.map((c) =>
      el(
        "li",
        `check ${c.status === "PASS" ? "pass" : "fail"}`,
        el("span", "badge", c.status),
        el("strong", null, `${c.id}. ${c.name}`),
        el("ul", null, ...c.details.map((d) => el("li", null, d)))
      )
    )
  );
  $("result").hidden = false;
}

async function run(bundleText, files, snapshot = null) {
  setBusy(true);
  setStatus("Checking…");
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
    setStatus(
      result.source === "snapshot"
        ? `Accounts read from the recorded devnet snapshot (slot ${result.slot}); no network request was made. Everything was computed in this browser.`
        : `Accounts read from the RPC at slot ${result.slot}. Everything else was computed in this browser.`
    );
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("result").hidden = true;
    setStatus(`Could not verify: ${error.message ?? error}`, true);
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
    setStatus(`Could not load the sample: ${error.message ?? error}`, true);
  }
}

function renderFileList() {
  $("file-list").replaceChildren(
    ...[...selected.entries()].map(([name, bytes]) => el("li", null, `${name} (${bytes.length} bytes)`))
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
    setStatus("No audit bundle found among the files (a JSON file with format coorre-audit-bundle/1).", true);
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
  $("theme-label").textContent = dark ? "Light" : "Dark";
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

function show(route, arg) {
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
      if (arg) renderCaseDetail(siteData, arg, rpcUrl());
      else if (!rendered.has(route)) renderCaseList(siteData);
    }
    if (route !== "cases" || !arg) rendered.add(route);
  }
  if (route === "verify" && arg && SAMPLES.includes(arg)) runSample(arg);
  window.scrollTo(0, 0);
}

function route(event) {
  const [name, arg] = location.hash.replace(/^#/, "").split("/");
  show(ROUTES.includes(name) ? name : "overview", arg ? decodeURIComponent(arg) : undefined);
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
  setStatus("Ready.");
  try {
    siteData = await (await fetch("site-data.json")).json();
  } catch (error) {
    setStatus(`Could not load the dashboard data: ${error.message ?? error}`, true);
  }
  window.addEventListener("hashchange", route);
  route();
}

main().catch((error) => setStatus(`Could not start the verifier: ${error.message ?? error}`, true));
