import { columnBars, donut, evidenceChain, html, interactive, rangeBars, ring, stackedBars, stateMachine, svg, tableView, vbars } from "./charts.js";
import { explorerUrl } from "./verify-core.js";
import { decodeCaseRecord, decodeUpgradeAuthority, readAccounts } from "./live.js";

const NETWORK = "solana:devnet";
const REPO = "https://github.com/catitodev/CoorRe";

export const OUTCOMES = {
  auto: { label: "Approved by the rule engine", short: "Auto-approved", cls: "auto" },
  approved: { label: "Approved by a person", short: "Approved by a person", cls: "human" },
  rejected: { label: "Rejected by a person, escrow refunded", short: "Rejected, refunded", cls: "third" },
};

const ROLE_LABELS = {
  payee: "Payee",
  agent: "AI agent",
  rule_engine: "Rule engine",
  approver: "Approver",
};

export function sol(lamports) {
  if (typeof lamports !== "number") return "";
  const whole = Math.floor(lamports / 1e9);
  const fraction = String(lamports % 1e9).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} SOL` : `${whole} SOL`;
}

function solShort(lamports) {
  return `${Number((lamports / 1e9).toFixed(3))} SOL`;
}

function lamports(n) {
  return `${n.toLocaleString("en-US")} lamports`;
}

function short(value) {
  return typeof value === "string" && value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value ?? "";
}

function link(text, url) {
  if (!url) return document.createTextNode(text);
  const a = html("a", null, text);
  a.href = url;
  if (/^https?:/.test(url)) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}

function tx(signature) {
  return link(short(signature), explorerUrl("tx", signature, NETWORK));
}

function address(value) {
  return link(short(value), explorerUrl("address", value, NETWORK));
}

function facts(pairs) {
  return html("dl", "facts", ...pairs.flatMap(([term, value]) => [html("dt", null, term), html("dd", null, value)]));
}

function outcomeTag(outcome) {
  const o = OUTCOMES[outcome];
  return html("span", "outcome", html("span", `swatch ${o.cls}`), o.short);
}

let livePromise = null;

export function liveState(data, rpcUrl) {
  livePromise ??= readAccounts(rpcUrl, [data.program.id, data.program.programdata, ...data.cases.map((c) => c.case_record)]).catch((error) => {
    livePromise = null;
    throw error;
  });
  return livePromise;
}

function liveError(container, error) {
  container.replaceChildren(html("p", "status error", `Could not read devnet: ${error.message ?? error}. The recorded data below is unaffected.`));
}

const CHECK_SVG = () => {
  const icon = svg("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" });
  icon.append(svg("path", { d: "M2.5 6.2 5 8.6 9.5 3.6" }));
  return icon;
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function renderOverview(data, rpcUrl) {
  const cases = data.cases;
  const count = (outcome) => cases.filter((c) => c.outcome === outcome).length;
  const escalated = cases.filter((c) => c.steps.some((s) => s.to === "ESCALATED"));
  const blocked = cases.filter((c) => c.blocked_attempt);

  const go = (hash) => () => {
    location.hash = hash;
  };
  evidenceChain(document.getElementById("hero-chain"), {
    steps: [
      { label: "escrow", lines: ["Escrow", "SUP-002: the creator put 0.2 SOL in escrow", "Open this step"], onSelect: go("#cases/SUP-002/step-0") },
      { label: "evidence", lines: ["Evidence", "SUP-002: the supplier submitted two documents", "Open this step"], onSelect: go("#cases/SUP-002/step-1") },
      { label: "agent advice", lines: ["Agent advice", "SUP-002: the AI agent recommended escalation", "Open this step"], onSelect: go("#cases/SUP-002/step-2") },
      { label: "rule decision", lines: ["Rule decision", "SUP-002: an approval above the mandate was refused, then the case was escalated", "Open this step"], onSelect: go("#cases/SUP-002/step-3") },
      { label: "human signature", signature: true, lines: ["Human signature", "SUP-002: the approver signed the exception", "Open this step"], onSelect: go("#cases/SUP-002/step-5") },
      { label: "anchored", lines: ["Anchored", "Every step of the ten cases is anchored on Solana devnet", "Open the on-chain proof"], onSelect: go("#onchain") },
    ],
  });

  donut(document.getElementById("outcome-chart"), {
    unit: "cases",
    caption: "Outcomes of the devnet cases",
    items: ["auto", "approved", "rejected"].map((key) => ({
      label: OUTCOMES[key].label,
      value: count(key),
      cls: OUTCOMES[key].cls,
      detail: [cases.filter((c) => c.outcome === key).map((c) => c.id).join(", ")],
    })),
  });

  const guard = document.getElementById("guard-chart");
  const guardRing = html("div");
  ring(guardRing, {
    value: blocked.length,
    max: escalated.length,
    label: `${blocked.length}/${escalated.length}`,
    caption: "above the limit",
    cls: "human",
    lines: ["Escalations above the autonomy limit", `${blocked.length} of ${escalated.length}: ${blocked.map((c) => c.id).join(", ")}`, "Each was refused on-chain with MandateExceeded before a person signed"],
  });
  guard.replaceChildren(
    html(
      "div",
      "ring-wrap",
      html(
        "div",
        null,
        html("span", "big", String(blocked.length), " ", html("small", null, "blocked")),
        html("p", "note", "Approvals the rule engine tried above its mandate. The program refused each one with MandateExceeded; no transaction exists and no funds moved."),
        html(
          "div",
          "mini-stats",
          html("div", null, html("span", null, "Escalated"), html("strong", null, String(escalated.length))),
          html("div", null, html("span", null, "Approved by a person"), html("strong", null, String(count("approved")))),
          html("div", null, html("span", null, "Rejected"), html("strong", null, String(count("rejected"))))
        )
      ),
      guardRing
    )
  );

  const latest = [...cases].sort((a, b) => b.steps.at(-1).signed_at.localeCompare(a.steps.at(-1).signed_at) || a.id.localeCompare(b.id)).slice(0, 5);
  document.getElementById("latest-list").replaceChildren(
    ...latest.map((c) => {
      const o = OUTCOMES[c.outcome];
      const icon = html("span", `check-icon ${o.cls}`);
      if (c.outcome !== "rejected") icon.append(CHECK_SVG());
      const title = html("a", "row-title", `${c.id} · ${c.payee}`);
      title.href = `#cases/${c.id}`;
      return html("li", null, icon, html("span", null, title, html("span", "row-sub", `${c.rule.id} v${c.rule.version} · ${solShort(c.amount)}`)), html("span", `status-text ${o.cls}`, o.short));
    })
  );

  document.getElementById("runs-list").replaceChildren(
    ...data.runs.map((r) => {
      const [, month, day] = r.date.split("-");
      return html(
        "li",
        null,
        html("span", "date-badge", html("strong", null, day), html("span", null, MONTHS[Number(month) - 1])),
        html("span", null, html("span", "row-title", r.label), html("span", "row-sub", `${r.cases.length} cases · ${r.transactions} transactions · ${solShort(r.spent)} spent · ${r.utc} UTC`)),
        html("span", `dot-status ${r.spent === r.recorded_spent ? "auto" : "human"}`)
      );
    })
  );

  const counts = {};
  for (const c of cases) {
    counts.OPEN = (counts.OPEN ?? 0) + 1;
    for (const s of c.steps) counts[s.to] = (counts[s.to] ?? 0) + 1;
  }
  stateMachine(document.getElementById("state-chart"), { counts, total: cases.length });

  vbars(document.getElementById("tx-chart"), {
    caption: "Transactions per devnet case",
    unit: "transactions",
    rows: cases.map((c) => ({
      label: c.id.replace("-00", "-"),
      value: c.steps.length + 1,
      cls: OUTCOMES[c.outcome].cls,
      detail: [`${c.id} · ${OUTCOMES[c.outcome].label}`, "Open the case"],
      onSelect: () => {
        location.hash = `#cases/${c.id}`;
      },
    })),
  });

  document.getElementById("overview-samples").replaceChildren(
    ...cases
      .filter((c) => c.sample)
      .map((c) => {
        const a = html("a", null, html("strong", null, c.id), html("span", null, OUTCOMES[c.outcome].short));
        a.href = `#verify/${c.id}`;
        return a;
      })
  );

  const nowTime = document.getElementById("now-time");
  const now = document.getElementById("now-card");
  const status = document.getElementById("status-card");
  now.replaceChildren(html("p", "muted", "Reading devnet…"));
  status.replaceChildren(html("p", "muted", "Reading devnet…"));
  liveState(data, rpcUrl).then(
    ({ slot, accounts }) => {
      const program = accounts[data.program.id];
      const authority = accounts[data.program.programdata] ? decodeUpgradeAuthority(accounts[data.program.programdata].data) : null;
      const matches = cases.filter((c) => {
        const account = accounts[c.case_record];
        return account && account.owner === data.program.id && decodeCaseRecord(account.data).state === c.final_state;
      }).length;
      nowTime.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      now.replaceChildren(
        html("span", "big", `${matches}`, html("small", null, `/${cases.length}`)),
        html("p", "note", "case records on devnet hold the final state their bundle recorded"),
        html("div", "kv", html("span", null, "slot ", html("strong", null, String(slot ?? ""))), html("span", null, "program ", html("strong", null, program?.executable ? "executable" : "not found")))
      );
      const ringBox = html("div");
      ring(ringBox, { value: matches, max: cases.length, label: `${Math.round((matches / cases.length) * 100)}%`, caption: "records match", cls: "auto" });
      const meters = [
        ["Case records match bundles", matches / cases.length, `${matches} of ${cases.length}`],
        ["Program executable", program?.executable ? 1 : 0, program?.executable ? "yes" : "no"],
        ["Upgrade authority as recorded", authority === data.program.upgrade_authority ? 1 : 0, authority === data.program.upgrade_authority ? "yes" : "changed"],
        ["Rules shipped by the verifier", 1, `${data.rules.length} of ${data.rules.length}`],
        ["Run costs match DEPLOYMENTS.md", data.runs.filter((r) => r.spent === r.recorded_spent).length / data.runs.length, `${data.runs.filter((r) => r.spent === r.recorded_spent).length} of ${data.runs.length}`],
      ];
      status.replaceChildren(
        ringBox,
        html(
          "ul",
          "meters",
          ...meters.map(([label, share, reading], i) => {
            const fill = html("span", share < 1 ? "bad" : null);
            fill.style.width = `${Math.max(2, share * 100)}%`;
            fill.style.setProperty("--i", String(i));
            return html("li", null, html("span", null, label), html("span", "meter", fill), html("span", "reading", reading));
          })
        )
      );
    },
    (error) => {
      liveError(now, error);
      liveError(status, error);
    }
  );
}

function filtersFor(data, onChange) {
  const rule = document.getElementById("filter-rule");
  const outcome = document.getElementById("filter-outcome");
  if (!rule.options.length) {
    rule.append(new Option("All rules", ""), ...data.rules.map((r) => new Option(`${r.id} v${r.version}`, r.id)));
    outcome.append(new Option("All outcomes", ""), ...Object.entries(OUTCOMES).map(([key, o]) => new Option(o.short, key)));
    rule.addEventListener("change", onChange);
    outcome.addEventListener("change", onChange);
  }
  return { rule: rule.value, outcome: outcome.value };
}

export function renderCaseList(data) {
  const draw = () => {
    const f = filtersFor(data, draw);
    const rows = data.cases.filter((c) => (!f.rule || c.rule.id === f.rule) && (!f.outcome || c.outcome === f.outcome));
    const open = (c) => {
      location.hash = `#cases/${c.id}`;
    };
    rangeBars(document.getElementById("amount-chart"), {
      caption: "Amount against the autonomy limit",
      format: solShort,
      onSelect: (row) => open(row.item),
      rows: rows.map((c) => ({
        item: c,
        label: c.id,
        value: c.amount,
        marker: c.limit,
        cls: OUTCOMES[c.outcome].cls,
        tip: [`${c.id} · ${c.payee}`, `Amount ${sol(c.amount)}, limit ${sol(c.limit)}`, OUTCOMES[c.outcome].label, c.blocked_attempt ? "Approval above the limit blocked on-chain" : "Within the rule engine's reach", "Open the case"],
      })),
    });
    document.getElementById("amount-chart").append(
      html(
        "ul",
        "legend legend-row",
        ...Object.values(OUTCOMES).map((o) => html("li", null, html("span", `swatch ${o.cls}`), html("span", null, o.label))),
        html("li", null, html("span", "swatch tick"), html("span", null, "Autonomy limit"))
      )
    );
    const body = document.querySelector("#cases-table tbody");
    body.replaceChildren(
      ...rows.map((c) => {
        const a = html("a", null, c.id);
        a.href = `#cases/${c.id}`;
        const tr = html(
          "tr",
          null,
          html("td", null, a),
          html("td", null, `${c.rule.id} v${c.rule.version}`),
          html("td", null, c.payee),
          html("td", "num", sol(c.amount)),
          html("td", "num", sol(c.limit)),
          html("td", null, outcomeTag(c.outcome)),
          html("td", null, c.run)
        );
        tr.addEventListener("click", (event) => {
          if (event.target.closest("a")) return;
          open(c);
        });
        return tr;
      })
    );
  };
  draw();
}

function lowerFirst(text) {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function stepStory(c, s) {
  const reasons = (list) => (list?.length ? `: ${list.map(lowerFirst).join("; ")}` : "");
  switch (s.to) {
    case "OPEN":
      return { title: `The creator put ${sol(c.amount)} in escrow`, body: `The program holds it until a signed decision is anchored. The rule engine may release up to ${sol(c.limit)} alone.` };
    case "SUBMITTED":
      return { title: `The ${c.payee_label} submitted ${c.documents.length} documents`, body: c.documents.join(", ") };
    case "AGENT_REVIEWED":
      return { title: `The AI agent recommended ${s.recommendation === "auto_approve" ? "approval" : "escalation"}${reasons(s.findings)}`, body: "Advice only: the rule engine decides." };
    case "AUTO_APPROVED":
      return { title: "The rule engine approved within the mandate", body: `The escrow of ${sol(c.amount)} was released to the ${c.payee_label}.` };
    case "ESCALATED":
      return { title: `The rule engine escalated to a person${reasons(s.reasons)}`, body: "Above the limit or outside the rule, only the approver can decide." };
    case "APPROVED":
      return { title: "A person approved and signed", body: `The escrow of ${sol(c.amount)} was released to the ${c.payee_label}.`, quote: s.justification };
    case "REJECTED":
      return { title: "A person rejected and signed", body: `The escrow of ${sol(c.amount)} was refunded to the creator.`, quote: s.justification };
    default:
      return { title: s.to, body: "" };
  }
}

function stepItem(c, s, n) {
  const human = s.role === "approver";
  const story = stepStory(c, s);
  const li = html("li", human ? "human" : null);
  li.id = `step-${n}`;
  li.tabIndex = -1;
  li.style.setProperty("--i", String(n));
  const meta = [`${ROLE_LABELS[s.role] ?? "Creator"} · ${s.actor_kind}, ${s.autonomy.replace(/_/g, " ")}`, ` · ${s.signed_at}`];
  li.append(
    ...[
      html("span", "dot"),
      human ? html("span", "step-flag", "Human signature") : null,
      html("div", "step-head", story.title),
      story.body ? html("div", "step-body", story.body) : null,
      story.quote ? html("blockquote", "step-quote", `“${story.quote}”`) : null,
      html("div", "step-meta", ...meta, " · ", s.tx ? tx(s.tx) : "no receipt", s.anchor ? html("span", null, " · anchor ", address(s.anchor)) : null),
      html("div", "step-state", s.to),
    ].filter(Boolean)
  );
  return li;
}

function blockedItem(c, n) {
  const li = html("li", "blocked");
  li.id = `step-${n}`;
  li.tabIndex = -1;
  li.style.setProperty("--i", String(n));
  li.append(
    html("span", "dot"),
    html("div", "step-head", `The rule engine tried to approve ${sol(c.amount)} above its ${sol(c.limit)} limit`),
    html("div", "step-body", "The program refused it with MandateExceeded. No transaction exists and no funds moved."),
    html("div", "step-state", "AUTO_APPROVED refused")
  );
  return li;
}

export function caseSteps(c) {
  const rows = [{ kind: "step", step: { to: "OPEN", role: null, actor_kind: "creator", autonomy: "funds the escrow", signed_at: `run of ${c.run}`, tx: c.open_tx, anchor: null } }];
  for (const s of c.steps) {
    if (s.to === "ESCALATED" && c.blocked_attempt) rows.push({ kind: "blocked" });
    rows.push({ kind: "step", step: s });
  }
  return rows;
}

export function renderCaseDetail(data, id, rpcUrl, focus) {
  const container = document.getElementById("case-detail");
  const c = data.cases.find((x) => x.id === id);
  if (!c) {
    container.replaceChildren(html("p", "status error", `No case ${id}.`));
    return;
  }
  const back = html("a", "back", "All cases");
  back.href = "#cases";
  const live = html("span", "muted", "reading devnet…");
  const amount = html("div", "chart");
  rangeBars(amount, {
    caption: `${c.id} amount against the autonomy limit`,
    format: solShort,
    rows: [{ label: c.id, value: c.amount, marker: c.limit, cls: OUTCOMES[c.outcome].cls, tip: [`Amount ${sol(c.amount)}`, `Autonomy limit ${sol(c.limit)}`] }],
  });

  const steps = html("ol", "steps story");
  caseSteps(c).forEach((row, n) => steps.append(row.kind === "blocked" ? blockedItem(c, n) : stepItem(c, row.step, n)));

  const action = c.sample ? link("Verify this case in the browser", `#verify/${c.id}`) : link("Audit bundle on GitHub", `${REPO}/tree/main/${c.source}`);
  container.replaceChildren(
    back,
    html("h2", "case-title", `${c.id} · ${c.payee}`),
    html("p", "case-sub", outcomeTag(c.outcome), " · ", `${c.rule.id} v${c.rule.version}`, " · ", `devnet run of ${c.run}`),
    html(
      "article",
      "panel",
      html("h2", null, "Mandate"),
      amount,
      facts([
        ["Case", html("code", null, c.case_ref)],
        ["Case record", address(c.case_record)],
        ["State on devnet now", live],
        ["Documents", html("ul", "chips", ...c.documents.map((d) => html("li", null, d)))],
        ["Re-check", action],
      ])
    ),
    html("article", "panel", html("h2", null, "What happened, step by step"), html("p", "note", "Each step was signed by the key that holds its role and anchored on Solana devnet."), steps)
  );
  if (focus) {
    const target = container.querySelector(`#${CSS.escape(focus)}`);
    if (target) {
      target.classList.add("focus-step");
      setTimeout(() => {
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
      }, 0);
    }
  }
  liveState(data, rpcUrl).then(
    ({ slot, accounts }) => {
      const account = accounts[c.case_record];
      if (!account || account.owner !== data.program.id) {
        live.replaceChildren(html("span", "tag fail", "not found"));
        return;
      }
      const record = decodeCaseRecord(account.data);
      const ok = record.state === c.final_state && record.transitions === c.steps.length && record.amount === c.amount;
      live.replaceChildren(`${record.state}, ${record.transitions} transitions, ${lamports(account.lamports)} held (slot ${slot}) `, html("span", `tag ${ok ? "pass" : "fail"}`, ok ? "matches the bundle" : "differs"));
    },
    (error) => live.replaceChildren(html("span", "status error", String(error.message ?? error)))
  );
}

function alternatives(condition, labels) {
  return condition.reason.split(" | ").flatMap((r) => (r.includes("<label>") ? Object.values(labels).map((l) => r.replace("<label>", l)) : [r]));
}

export function renderRules(data) {
  const escalations = data.cases.flatMap((c) => c.steps.filter((s) => s.to === "ESCALATED").map((s) => ({ c, reasons: s.reasons ?? [] })));
  const tally = new Map();
  for (const { c, reasons } of escalations) {
    for (const r of reasons) {
      const entry = tally.get(r) ?? { count: 0, cases: [] };
      entry.count += 1;
      entry.cases.push(c.id);
      tally.set(r, entry);
    }
  }
  columnBars(document.getElementById("reasons-chart"), {
    caption: "Reasons recorded across escalated devnet cases",
    unit: "escalated cases",
    rows: [...tally.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .map(([reason, entry]) => ({ label: reason, value: entry.count, detail: [entry.cases.join(", ")] })),
  });

  document.getElementById("rules-list").replaceChildren(
    ...data.rules.map((rule) => {
      const cases = rule.cases.map((id) => data.cases.find((c) => c.id === id));
      const rows = [...rule.conditions, { ...rule.mandate, mandate: true }];
      const table = html("table", "matrix");
      table.append(html("thead", null, html("tr", null, html("th", null, "Condition, in the rule's order"), ...cases.map((c) => html("th", null, c.id)))));
      table.append(
        html(
          "tbody",
          null,
          ...rows.map((row, i) => {
            const alts = alternatives(row, rule.labels);
            return html(
              "tr",
              null,
              html("td", null, `${i + 1}. ${row.mandate ? "Mandate: " : ""}${row.check}`, html("span", "reason", `If it fails: ${row.reason.replace(/<label>/g, "document")}`)),
              ...cases.map((c) => {
                const recorded = c.steps.find((s) => s.to === "ESCALATED" || s.to === "AUTO_APPROVED")?.reasons ?? [];
                const failed = recorded.filter((r) => alts.includes(r));
                return html("td", null, html("span", `tag ${failed.length ? "fail" : "pass"}`, failed.length ? "failed" : "held"));
              })
            );
          })
        )
      );
      return html(
        "article",
        "panel rule-card",
        html("div", "rule-head", html("h2", null, `${rule.id} v${rule.version}`), html("code", null, short(rule.hash))),
        html("p", "note", rule.description),
        html("h3", null, "Documents"),
        html("ul", "chips", ...rule.documents.map((d) => html("li", null, rule.labels[d] ?? d))),
        html("h3", null, "Conditions and the devnet cases"),
        html("div", "table-wrap", table)
      );
    })
  );
}

export function renderOnchain(data, rpcUrl) {
  const programFacts = document.getElementById("program-facts");
  programFacts.replaceChildren(html("p", "muted", "Reading devnet…"));
  liveState(data, rpcUrl).then(
    ({ slot, accounts }) => {
      const program = accounts[data.program.id];
      const authority = accounts[data.program.programdata] ? decodeUpgradeAuthority(accounts[data.program.programdata].data) : null;
      programFacts.replaceChildren(
        facts([
          ["Program id", address(data.program.id)],
          ["Executable", html("span", `tag ${program?.executable ? "pass" : "fail"}`, program?.executable ? "yes" : "no")],
          ["Loader", html("code", null, program?.owner ?? "")],
          ["Upgrade authority", html("span", null, address(authority ?? ""), " ", html("span", `tag ${authority === data.program.upgrade_authority ? "pass" : "fail"}`, authority === data.program.upgrade_authority ? "as recorded" : "changed"))],
          ["Deploy transaction", tx(data.program.deploy_tx)],
          ["Deployed", data.program.deployed],
          ["Read at slot", String(slot ?? "")],
        ])
      );
    },
    (error) => liveError(programFacts, error)
  );

  const runsChart = document.getElementById("runs-chart");
  stackedBars(runsChart, {
    caption: "Where the creator's SOL went in each run",
    format: (n) => `${sol(n)} (${lamports(n)})`,
    series: [
      { key: "released", label: "Released to payees", cls: "auto" },
      { key: "network", label: "Rent and fees", cls: "third" },
    ],
    rows: data.runs.map((r) => ({ label: r.date, sublabel: `${r.cases.length} cases`, total: solShort(r.spent), values: { released: r.released, network: r.rent + r.fees } })),
  });
  runsChart.append(
    tableView(
      "Show as table",
      [{ label: "Run" }, { label: "Released", num: true }, { label: "Refunded", num: true }, { label: "Rent", num: true }, { label: "Fees", num: true }, { label: "Creator spent", num: true }, { label: "Recorded" }],
      data.runs.map((r) => [r.date, sol(r.released), sol(r.refunded), sol(r.rent), sol(r.fees), sol(r.spent), r.spent === r.recorded_spent ? "matches DEPLOYMENTS.md" : "differs"])
    )
  );

  document.getElementById("tx-list").replaceChildren(
    ...data.cases.map((c) => {
      const details = html("details");
      details.append(html("summary", null, `${c.id} · ${c.steps.length + 1} transactions · ${OUTCOMES[c.outcome].short}`));
      const list = html("ol", "plain");
      list.append(html("li", null, "OPEN · ", c.open_tx ? tx(c.open_tx) : "no receipt"));
      for (const s of c.steps) list.append(html("li", null, `${s.to} · `, s.tx ? tx(s.tx) : "no receipt", " · anchor ", address(s.anchor)));
      details.append(list);
      return details;
    })
  );
}

export { interactive, svg };
