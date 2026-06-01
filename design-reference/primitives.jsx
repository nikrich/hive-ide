/* Hive IDE — shared primitives. Exports to window. */
const { useState, useEffect, useRef, useCallback } = React;
const HD = window.HIVE;

function Icon({ name, size, style, cls }) {
  const html = iconSVG(name, size || 16);
  return <span className={cls} style={{ display: "inline-flex", width: size || 16, height: size || 16, ...(style || {}) }}
               dangerouslySetInnerHTML={{ __html: html }} />;
}

// Build a stable SVG string from lucide's icon node data (React owns the wrapper
// span; the svg inside is set via innerHTML so React never reconciles its guts —
// avoids the createIcons() removeChild crash).
const _iconCache = {};
const _alias = {
  "alert-triangle": "triangle-alert", "check-circle-2": "circle-check-big",
  "x-circle": "circle-x", "info": "info", "git-pull-request-closed": "git-pull-request-closed",
};
function _pascal(n) { return n.split(/[-_]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(""); }
function _lookup(name) {
  const L = window.lucide; if (!L) return null;
  const tryNames = [name, _alias[name]].filter(Boolean);
  for (const nm of tryNames) {
    const p = _pascal(nm);
    const node = (L.icons && (L.icons[p] || L.icons[nm])) || L[p];
    if (node) return node;
  }
  return null;
}
function iconSVG(name, size) {
  const key = name + ":" + size;
  if (_iconCache[key]) return _iconCache[key];
  const node = _lookup(name);
  let inner = "";
  if (node) {
    // node may be an iconNode [tag, attrs, children] or just an array of child tuples
    const kids = Array.isArray(node) && typeof node[0] === "string" ? (node[2] || []) : node;
    for (const child of kids) {
      const tag = child[0], attrs = child[1] || {};
      const a = Object.keys(attrs).map(k => `${k}="${attrs[k]}"`).join(" ");
      inner += `<${tag} ${a}></${tag}>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  _iconCache[key] = svg;
  return svg;
}
function Pulse() { return <span className="pulse"></span>; }

const STATUS = {
  running: { cls: "st-running", label: "running", pulse: true },
  pending: { cls: "st-pending", label: "pending" },
  review:  { cls: "st-review",  label: "in review" },
  blocked: { cls: "st-blocked", label: "blocked" },
  merged:  { cls: "st-merged",  label: "merged" },
  done:    { cls: "st-done",    label: "done" },
  idle:    { cls: "st-idle",    label: "idle" },
};
function StatusChip({ status, label }) {
  const s = STATUS[status] || STATUS.pending;
  return (
    <span className={"chip " + s.cls}>
      {s.pulse ? <Pulse/> : <span className="dot" style={{ background: "currentColor" }}></span>}
      {label || s.label}
    </span>
  );
}

function RoleAva({ role, size, live, dot }) {
  const r = HD.ROLE[role] || HD.ROLE.junior;
  const sz = size || 28;
  const ds = Math.max(8, Math.round(sz * 0.34));
  return (
    <span className="ava" title={r.label} style={{
      width: sz, height: sz, fontSize: Math.round(sz * 0.36),
      color: r.color, background: hexA(r.color, 0.16), borderColor: hexA(r.color, 0.42),
    }}>
      {r.abbr}
      {(live || dot) && <span className="sdot" style={{ width: ds, height: ds, background: dot || "var(--status-running)" }}></span>}
    </span>
  );
}
function AvaStack({ roles, size }) {
  return <div className="ava-stack">{roles.map((role, i) => <RoleAva key={i} role={role} size={size || 24} />)}</div>;
}
function Btn({ kind, sm, icon, children, onClick, style }) {
  return (
    <button className={`btn btn-${kind || "outline"}${sm ? " btn-sm" : ""}`} onClick={onClick} style={style}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* file-type icon + tint class from a filename */
function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    tsx: ["braces", "ic-tsx"], ts: ["file-code", "ic-ts"], js: ["file-code", "ic-ts"], jsx: ["braces", "ic-tsx"],
    json: ["braces", "ic-json"], css: ["hash", "ic-css"], md: ["file-text", "ic-md"],
    svg: ["image", "ic-xml"], xml: ["code", "ic-xml"], html: ["code", "ic-xml"],
  };
  return map[ext] || ["file", "ic-md"];
}

const ROLE_PROGRESS = { done: "var(--status-done)", review: "var(--status-review)", running: "var(--status-running)", pending: "rgba(148,163,184,.25)" };
function StoryProgress({ counts }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const order = ["done", "review", "running", "pending"];
  return (
    <div className="progress" style={{ height: 6, borderRadius: 99, background: "rgba(148,163,184,.14)", overflow: "hidden", marginTop: 14, display: "flex" }}>
      {order.map(k => counts[k] ? <i key={k} style={{ display: "block", height: "100%", width: `${(counts[k] / total) * 100}%`, background: ROLE_PROGRESS[k] }}></i> : null)}
    </div>
  );
}

Object.assign(window, { Icon, Pulse, StatusChip, RoleAva, AvaStack, Btn, hexA, fileIcon, StoryProgress, STATUS });
