import init, * as wasm from "./pkg/coorre_verify.js";
import { verifyBundle, explorerUrl } from "./verify-core.js";

const $ = (id) => document.getElementById(id);
const BUNDLE_FORMAT = "coorre-audit-bundle/1";
const selected = new Map();
const buttons = ["sample-sup-001", "sample-sup-002", "verify-files"];

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

function sol(lamports) {
  if (typeof lamports !== "number") return "";
  const whole = Math.floor(lamports / 1e9);
  const fraction = String(lamports % 1e9).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} SOL` : `${whole} SOL`;
}

function setStatus(text, isError = false) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function setBusy(busy) {
  for (const id of buttons) $(id).disabled = busy;
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
  return parts.join(" — ");
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
    ["Supplier key", link(s.submitter ?? "", explorerUrl("address", s.submitter, network))],
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

async function run(bundleText, files) {
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
    });
    render(result, expected);
    setStatus(`Accounts read from the RPC at slot ${result.slot}. Everything else was computed in this browser.`);
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
    await run(bundleText, files);
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

function findBundle() {
  for (const [name, bytes] of selected) {
    if (!name.endsWith(".json")) continue;
    try {
      const text = new TextDecoder().decode(bytes);
      if (JSON.parse(text).format === BUNDLE_FORMAT) return { name, text };
    } catch {
      continue;
    }
  }
  return null;
}

async function verifySelected() {
  const bundle = findBundle();
  if (!bundle) {
    setStatus("No audit bundle found among the files (a JSON file with format coorre-audit-bundle/1).", true);
    return;
  }
  const files = [...selected.entries()].filter(([name]) => name !== bundle.name).map(([name, bytes]) => ({ name, bytes }));
  await run(bundle.text, files);
}

async function main() {
  await init();
  $("program-id").value = wasm.defaultProgramId();
  $("network-id").value = wasm.defaultNetworkId();
  $("footer-program").textContent = wasm.defaultProgramId();
  $("sample-sup-001").addEventListener("click", () => runSample("SUP-001"));
  $("sample-sup-002").addEventListener("click", () => runSample("SUP-002"));
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
}

main().catch((error) => setStatus(`Could not start the verifier: ${error.message ?? error}`, true));
