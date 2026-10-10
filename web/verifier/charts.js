const SVG = "http://www.w3.org/2000/svg";

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function html(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function order(node, i) {
  node.style.setProperty("--i", String(i));
  return node;
}

let tooltipNode = null;

function tooltip() {
  tooltipNode ??= document.getElementById("tooltip");
  return tooltipNode;
}

export function showTip(lines, x, y) {
  const tip = tooltip();
  if (!tip) return;
  tip.replaceChildren(...lines.map((line, i) => html(i === 0 ? "strong" : "span", null, line, i === 0 ? null : html("br"))));
  tip.hidden = false;
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  const left = Math.min(Math.max(pad, x + 14), window.innerWidth - rect.width - pad);
  const top = y - rect.height - 14 < pad ? y + 18 : y - rect.height - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTip() {
  const tip = tooltip();
  if (tip) tip.hidden = true;
}

export function interactive(target, lines, onSelect) {
  target.setAttribute("tabindex", "0");
  target.setAttribute("role", onSelect ? "button" : "img");
  target.setAttribute("aria-label", lines.join(". "));
  const group = target.parentNode;
  const fromEvent = (event) => showTip(lines, event.clientX, event.clientY);
  const fromFocus = () => {
    const box = target.getBoundingClientRect();
    showTip(lines, box.left + box.width / 2, box.top);
  };
  target.addEventListener("pointerenter", fromEvent);
  target.addEventListener("pointermove", fromEvent);
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("focus", () => {
    group?.classList?.add("focused");
    fromFocus();
  });
  target.addEventListener("blur", () => {
    group?.classList?.remove("focused");
    hideTip();
  });
  if (onSelect) {
    target.addEventListener("click", onSelect);
    target.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect();
      }
    });
  }
  return target;
}

export function tableView(caption, headers, rows) {
  const details = html("details", "table-toggle");
  details.append(html("summary", null, caption));
  const table = html("table");
  table.append(html("thead", null, html("tr", null, ...headers.map((h) => html("th", h.num ? "num" : null, h.label)))));
  table.append(html("tbody", null, ...rows.map((row) => html("tr", null, ...row.map((cell, i) => html("td", headers[i].num ? "num" : null, cell))))));
  details.append(html("div", "table-wrap", table));
  return details;
}

function arcPath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

export function donut(container, { items, total, caption, unit }) {
  const size = 200;
  const c = size / 2;
  const chart = svg("svg", { viewBox: `0 0 ${size} ${size}`, role: "group", "aria-label": caption });
  let angle = 0;
  const sum = items.reduce((n, item) => n + item.value, 0);
  items.forEach((item, i) => {
    if (!item.value) return;
    const sweep = (item.value / sum) * Math.PI * 2;
    const g = svg("g");
    const path = order(svg("path", { d: arcPath(c, c, 62, 92, angle, angle + sweep), class: `mark arc ${item.cls}` }), i);
    const ring = svg("path", { d: arcPath(c, c, 58, 96, angle, angle + sweep), class: "focus-ring" });
    g.append(path, ring);
    interactive(path, [item.label, `${item.value} of ${sum} ${unit}`, ...(item.detail ?? [])]);
    chart.append(g);
    angle += sweep;
  });
  chart.append(
    svg("text", { x: c, y: c + 6, "text-anchor": "middle", class: "donut-total" }, String(total ?? sum)),
    svg("text", { x: c, y: c + 26, "text-anchor": "middle", class: "donut-caption" }, unit)
  );
  const legend = html(
    "ul",
    "legend",
    ...items.map((item) => html("li", null, html("span", `swatch ${item.swatch ?? item.cls}`), html("span", null, item.label), html("span", "count", String(item.value))))
  );
  container.replaceChildren(html("div", "donut-wrap", chart, legend));
  container.append(tableView("Show as table", [{ label: "Outcome" }, { label: unit, num: true }], items.map((item) => [item.label, String(item.value)])));
}

function niceMax(value) {
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
}

export function rangeBars(container, { rows, caption, format, onSelect }) {
  const max = niceMax(Math.max(...rows.map((r) => Math.max(r.value, r.marker ?? 0))));
  const width = 640;
  const labelW = 86;
  const rowH = 30;
  const top = 6;
  const plotW = width - labelW - 70;
  const height = top + rows.length * rowH + 26;
  const x = (v) => labelW + (v / max) * plotW;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": caption });
  const ticks = 4;
  for (let t = 0; t <= ticks; t += 1) {
    const v = (max / ticks) * t;
    chart.append(
      svg("line", { x1: x(v), x2: x(v), y1: top, y2: height - 22, class: t === 0 ? "axis-line" : "grid-line" }),
      svg("text", { x: x(v), y: height - 6, "text-anchor": "middle" }, format(v))
    );
  }
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const g = svg("g");
    g.append(svg("text", { x: labelW - 10, y: y + 19, "text-anchor": "end", class: "value-label" }, row.label));
    const bar = order(svg("rect", { x: labelW, y: y + 7, width: Math.max(2, x(row.value) - labelW), height: 16, rx: 4, class: `mark bar ${row.cls}` }), i);
    g.append(bar);
    if (row.marker !== undefined) {
      g.append(order(svg("line", { x1: x(row.marker), x2: x(row.marker), y1: y + 2, y2: y + 28, class: "limit-tick" }), i));
    }
    const text = format(row.value);
    const end = x(row.value);
    const room = row.marker === undefined || x(row.marker) <= end || x(row.marker) - end > text.length * 7.6 + 16;
    const labelX = room ? end + 8 : x(row.marker) + 8;
    g.append(order(svg("text", { x: labelX, y: y + 19, class: "value-label" }, text), i));
    const hit = svg("rect", { x: 0, y, width, height: rowH, class: "hit" });
    const ring = svg("rect", { x: 1, y: y + 1, width: width - 2, height: rowH - 2, rx: 6, class: "focus-ring" });
    g.append(hit, ring);
    interactive(hit, row.tip, onSelect ? () => onSelect(row) : null);
    chart.append(g);
  });
  container.replaceChildren(chart);
}

export function columnBars(container, { rows, caption, unit }) {
  const max = Math.max(...rows.map((r) => r.value));
  const width = 760;
  const labelW = 380;
  const rowH = 28;
  const height = rows.length * rowH + 6;
  const plotW = width - labelW - 40;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": caption });
  rows.forEach((row, i) => {
    const y = 3 + i * rowH;
    const g = svg("g");
    g.append(svg("text", { x: labelW - 10, y: y + 17, "text-anchor": "end" }, row.label));
    g.append(order(svg("rect", { x: labelW, y: y + 5, width: Math.max(2, (row.value / max) * plotW), height: 15, rx: 4, class: `mark bar ${row.cls ?? "neutral"}` }), i));
    g.append(order(svg("text", { x: labelW + (row.value / max) * plotW + 8, y: y + 17, class: "value-label" }, String(row.value)), i));
    const hit = svg("rect", { x: 0, y, width, height: rowH, class: "hit" });
    const ring = svg("rect", { x: 1, y: y + 1, width: width - 2, height: rowH - 2, rx: 6, class: "focus-ring" });
    g.append(hit, ring);
    interactive(hit, [row.label, `${row.value} ${unit}`, ...(row.detail ?? [])]);
    chart.append(g);
  });
  container.replaceChildren(chart);
  container.append(tableView("Show as table", [{ label: "Reason" }, { label: unit, num: true }], rows.map((r) => [r.label, String(r.value)])));
}

export function stackedBars(container, { rows, series, caption, format }) {
  const max = Math.max(...rows.map((r) => series.reduce((n, s) => n + r.values[s.key], 0)));
  const width = 760;
  const labelW = 120;
  const rowH = 52;
  const height = rows.length * rowH + 8;
  const plotW = width - labelW - 150;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": caption });
  rows.forEach((row, i) => {
    const y = 4 + i * rowH;
    chart.append(svg("text", { x: labelW - 10, y: y + 16, "text-anchor": "end", class: "value-label" }, row.label));
    chart.append(svg("text", { x: labelW - 10, y: y + 31, "text-anchor": "end" }, row.sublabel));
    let x = labelW;
    series.forEach((s, j) => {
      const value = row.values[s.key];
      const w = (value / max) * plotW;
      const g = svg("g");
      const rect = order(svg("rect", { x, y: y + 6, width: Math.max(2, w - 2), height: 24, rx: 3, class: `mark bar ${s.cls}` }), i * series.length + j);
      const ring = svg("rect", { x: x - 2, y: y + 4, width: Math.max(4, w + 2), height: 28, rx: 5, class: "focus-ring" });
      g.append(rect, ring);
      interactive(rect, [`${row.label}: ${s.label}`, format(value)]);
      chart.append(g);
      x += w;
    });
    chart.append(order(svg("text", { x: x + 8, y: y + 23, class: "value-label" }, row.total), i));
  });
  const legend = html("ul", "legend legend-row", ...series.map((s) => html("li", null, html("span", `swatch ${s.cls}`), html("span", null, s.label))));
  container.replaceChildren(chart, legend);
}

const SM_NODES = [
  { id: "OPEN", x: 10, y: 104, role: "creator" },
  { id: "SUBMITTED", x: 210, y: 104, role: "payee" },
  { id: "AGENT_REVIEWED", x: 410, y: 104, role: "AI agent" },
  { id: "AUTO_APPROVED", x: 650, y: 14, role: "rule engine", cls: "terminal-auto" },
  { id: "ESCALATED", x: 650, y: 194, role: "rule engine" },
  { id: "APPROVED", x: 890, y: 130, role: "approver", cls: "terminal-human" },
  { id: "REJECTED", x: 890, y: 232, role: "approver", cls: "terminal-human" },
];

const SM_EDGES = [
  ["OPEN", "SUBMITTED", ""],
  ["SUBMITTED", "AGENT_REVIEWED", ""],
  ["AGENT_REVIEWED", "AUTO_APPROVED", "within limit"],
  ["AGENT_REVIEWED", "ESCALATED", "escalate"],
  ["ESCALATED", "APPROVED", "person approves"],
  ["ESCALATED", "REJECTED", "person rejects"],
];

export function stateMachine(container, { counts, total }) {
  const w = 160;
  const h = 64;
  const chart = svg("svg", { viewBox: "0 0 1060 306", role: "group", "aria-label": "Case state machine" });
  chart.append(svg("defs", {}, svg("marker", { id: "sm-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" }, svg("path", { d: "M0,0 L8,4 L0,8 z", class: "sm-arrow" }))));
  const byId = Object.fromEntries(SM_NODES.map((n) => [n.id, n]));
  const edgeNodes = [];
  SM_EDGES.forEach(([from, to, label], i) => {
    const a = byId[from];
    const b = byId[to];
    const x1 = a.x + w;
    const y1 = a.y + h / 2;
    const x2 = b.x - 4;
    const y2 = b.y + h / 2;
    const mid = (x1 + x2) / 2;
    const path = order(svg("path", { d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`, class: "sm-edge", "marker-end": "url(#sm-arrow)", "data-from": from, "data-to": to }), i + 1);
    const straight = y1 === y2;
    const text = order(
      svg("text", { x: straight ? mid : x2 - 8, y: straight ? y1 - 10 : y2 > y1 ? y2 + 22 : y2 - 10, "text-anchor": straight ? "middle" : "end", class: "sm-edge-label" }, label),
      i + 1
    );
    edgeNodes.push(path);
    chart.append(path, text);
  });
  SM_NODES.forEach((n, i) => {
    const count = counts[n.id] ?? 0;
    const g = order(svg("g", { class: `sm-node ${n.cls ?? ""}`, "data-state": n.id }), i);
    g.append(
      svg("rect", { x: n.x, y: n.y, width: w, height: h, rx: 8 }),
      svg("text", { x: n.x + w / 2, y: n.y + 21, "text-anchor": "middle" }, n.id),
      svg("text", { x: n.x + w / 2, y: n.y + 38, "text-anchor": "middle", class: "sm-count" }, n.id === "OPEN" ? "by the creator" : `by the ${n.role}`),
      svg("text", { x: n.x + w / 2, y: n.y + 54, "text-anchor": "middle", class: "sm-count" }, `${count} of ${total} cases`)
    );
    const lines = [n.id, n.id === "OPEN" ? "Opened by the creator, who funds the escrow" : `Signed by the ${n.role}`, `${count} of ${total} devnet cases reached this state`];
    const highlight = (on) => {
      g.classList.toggle("active", on);
      for (const edge of edgeNodes) edge.classList.toggle("active", on && (edge.dataset.to === n.id || edge.dataset.from === n.id));
    };
    interactive(g, lines);
    g.addEventListener("pointerenter", () => highlight(true));
    g.addEventListener("pointerleave", () => highlight(false));
    g.addEventListener("focus", () => highlight(true));
    g.addEventListener("blur", () => highlight(false));
    chart.append(g);
  });
  container.replaceChildren(chart);
}

export function ring(container, { value, max, label, caption, cls, lines }) {
  const r = 62;
  const c = 2 * Math.PI * r;
  const share = max ? value / max : 0;
  const chart = svg("svg", { viewBox: "0 0 150 150", class: "ring", role: "img", "aria-label": `${label}: ${caption}` });
  chart.append(
    svg("circle", { cx: 75, cy: 75, r, class: "track" }),
    svg("g", { transform: "rotate(-90 75 75)" }, svg("circle", { cx: 75, cy: 75, r, class: `fill ${cls}`, "stroke-dasharray": `${c * share} ${c}` })),
    svg("text", { x: 75, y: 78, "text-anchor": "middle", class: "ring-value" }, label),
    svg("text", { x: 75, y: 98, "text-anchor": "middle", class: "ring-caption" }, caption)
  );
  if (lines) interactive(chart, lines);
  container.replaceChildren(chart);
  return chart;
}

export function vbars(container, { rows, caption, unit }) {
  const max = Math.max(...rows.map((r) => r.value));
  const width = 640;
  const height = 210;
  const top = 26;
  const bottom = 30;
  const plotH = height - top - bottom;
  const slot = width / rows.length;
  const barW = Math.min(18, slot * 0.4);
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, class: "vbars", role: "group", "aria-label": caption });
  rows.forEach((row, i) => {
    const cx = slot * i + slot / 2;
    const h = (row.value / max) * plotH;
    const g = svg("g");
    g.append(
      svg("rect", { x: cx - barW / 2, y: top, width: barW, height: plotH, rx: barW / 2, class: "track" }),
      order(svg("rect", { x: cx - barW / 2, y: top + plotH - h, width: barW, height: h, rx: barW / 2, class: `vbar ${row.cls}` }), i),
      svg("text", { x: cx, y: top + plotH - h - 8, "text-anchor": "middle", class: "vbar-value" }, String(row.value)),
      svg("text", { x: cx, y: height - 8, "text-anchor": "middle" }, row.label)
    );
    const hit = svg("rect", { x: cx - slot / 2, y: 0, width: slot, height, class: "hit" });
    const ringRect = svg("rect", { x: cx - slot / 2 + 3, y: 2, width: slot - 6, height: height - 4, rx: 10, class: "focus-ring" });
    g.append(hit, ringRect);
    interactive(hit, [row.label, `${row.value} ${unit}`, ...(row.detail ?? [])], row.onSelect);
    chart.append(g);
  });
  container.replaceChildren(chart);
}

export function evidenceChain(container, { steps }) {
  const width = 640;
  const y = 30;
  const gap = (width - 40) / (steps.length - 1);
  const chart = svg("svg", { viewBox: `0 0 ${width} 66`, role: "img", "aria-label": steps.map((s) => s.label).join(", ") });
  const line = svg("line", { x1: 20, y1: y, x2: width - 20, y2: y, class: "link-line" });
  chart.append(line);
  steps.forEach((s, i) => {
    const x = 20 + gap * i;
    chart.append(
      order(svg("circle", { cx: x, cy: y, r: s.signature ? 10 : 7, class: s.signature ? "link-sig" : "link-dot" }), i),
      svg("text", { x, y: y + 28, "text-anchor": i === 0 ? "start" : i === steps.length - 1 ? "end" : "middle" }, s.label)
    );
  });
  container.replaceChildren(chart);
}
