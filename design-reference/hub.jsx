/* Hive IDE — Projects hub (cross-project) + command palette. */

function ProjectsHub({ onEnter, currentId }) {
  const totalAgents = HD.projects.reduce((a, p) => a + p.agents, 0);
  const running = HD.projects.filter(p => p.status === "running").length;
  const blocked = HD.projects.filter(p => p.status === "blocked").length;
  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">Workspace</div>
            <h1>Projects</h1>
            <div className="sub">Every repo Hive is orchestrating. Open one to drop into its editor and live run.</div>
          </div>
          <Btn kind="amber" icon="plus">New orchestration</Btn>
        </div>
      </div>
      <div className="stats">
        <div className="card stat"><div className="n">{HD.projects.length}</div><div className="l">Projects</div></div>
        <div className="card stat"><div className="n" style={{ color: "var(--status-running)" }}>{running}</div><div className="l">Active runs</div></div>
        <div className="card stat"><div className="n" style={{ color: "var(--teal-400)" }}>{totalAgents}</div><div className="l">Agents live</div></div>
        <div className="card stat"><div className="n" style={{ color: blocked ? "var(--status-blocked)" : "var(--fg-1)" }}>{blocked}</div><div className="l">Escalations</div></div>
      </div>
      <div className="hub-grid">
        {HD.projects.map(p => (
          <div key={p.id} className="card click pcard" onClick={() => onEnter(p.id)}>
            <div className="pcard-top">
              <div>
                <div className="pn"><span className="proj-dot" style={{ background: statusColor(p.status) }}></span>{p.name}</div>
                <div className="stack">{p.stack}</div>
              </div>
              <StatusChip status={p.status} />
            </div>
            <div className="req">{p.req.includes("·")
              ? <><span className="rid">{p.req.split(" · ")[0]}</span> · {p.req.split(" · ")[1]}</>
              : p.req}</div>
            <div className="pcard-foot">
              <span className="brn"><Icon name="git-branch" size={13} /> {p.branch}</span>
              {p.agents > 0
                ? <span style={{ font: "var(--t-body-sm)", color: "var(--fg-2)", display: "inline-flex", alignItems: "center", gap: 7 }}>
                    {p.status === "running" && <Pulse />}{p.agents} agents · {p.runs} run{p.runs !== 1 ? "s" : ""}
                  </span>
                : <span style={{ font: "var(--t-body-sm)", color: "var(--fg-3)" }}>idle</span>}
            </div>
            {currentId === p.id && <div style={{ marginTop: 12, font: "var(--t-meta)", color: "var(--accent-text)", textTransform: "uppercase", letterSpacing: "var(--tr-eyebrow)" }}>● currently open</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function statusColor(s) {
  return { running: "var(--status-running)", review: "var(--status-review)", blocked: "var(--status-blocked)", idle: "var(--fg-3)", done: "var(--status-done)" }[s] || "var(--fg-3)";
}

function CommandPalette({ onClose, onNav, onOpenFile }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inRef = useRef(null);
  useEffect(() => { inRef.current && inRef.current.focus(); }, []);

  const files = [];
  (function walk(nodes) { nodes.forEach(n => { if (n.type === "file") files.push(n.path); else walk(n.children); }); })(HD.tree);

  const actions = [
    { kind: "action", icon: "git-pull-request", t: "View pull requests", d: "PRs", go: () => onNav("prs") },
    { kind: "action", icon: "layout-dashboard", t: "Open Projects hub", d: "Workspace", go: () => onNav("hub") },
    { kind: "action", icon: "play", t: "Spawn new orchestration", d: "Manager", go: () => onNav("hub") },
    { kind: "action", icon: "square-terminal", t: "Toggle terminal", d: "Panel", go: () => onNav("terminal") },
    { kind: "action", icon: "git-branch", t: "Switch branch…", d: "Git", go: () => {} },
  ];
  const projItems = HD.projects.map(p => ({ kind: "project", icon: "box", t: p.name, d: p.stack, go: () => onNav("proj:" + p.id) }));
  const fileItems = files.map(f => ({ kind: "file", icon: "file", t: f.split("/").pop(), d: f, go: () => onOpenFile(f) }));

  const all = [...actions, ...projItems, ...fileItems];
  const filtered = q.trim()
    ? all.filter(x => (x.t + " " + x.d).toLowerCase().includes(q.toLowerCase()))
    : all;

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = filtered[sel]; if (it) { it.go(); onClose(); } }
    else if (e.key === "Escape") onClose();
  }

  const groups = [
    ["Actions", filtered.filter(x => x.kind === "action")],
    ["Projects", filtered.filter(x => x.kind === "project")],
    ["Files", filtered.filter(x => x.kind === "file")],
  ];
  let idx = -1;

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd" onClick={e => e.stopPropagation()}>
        <div className="cmd-in">
          <Icon name="search" />
          <input ref={inRef} value={q} placeholder="Search files, projects, actions…" onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
          <span className="kbd">esc</span>
        </div>
        <div className="cmd-list">
          {groups.map(([label, items]) => items.length ? (
            <div key={label}>
              <div className="cmd-sec">{label}</div>
              {items.map(it => {
                idx++; const myIdx = idx;
                return (
                  <div key={it.t + it.d} className={"cmd-item" + (sel === myIdx ? " sel" : "")}
                       onMouseEnter={() => setSel(myIdx)} onClick={() => { it.go(); onClose(); }}>
                    <Icon name={it.icon} />
                    <span className="ci-t">{it.t}</span>
                    <span className="ci-d">{it.d}</span>
                  </div>
                );
              })}
            </div>
          ) : null)}
          {!filtered.length && <div style={{ padding: 24, textAlign: "center", color: "var(--fg-3)", font: "var(--t-body-sm)" }}>No matches</div>}
        </div>
      </div>
    </div>
  );
}

function PRsView({ onOpenFile }) {
  const prIcon = { review: ["git-pull-request", "var(--status-review)"], merged: ["git-merge", "var(--status-merged)"], blocked: ["git-pull-request-closed", "var(--status-blocked)"] };
  return (
    <div className="view">
      <div className="phead">
        <div className="phead-row">
          <div>
            <div className="eyebrow">{HIVE_PROJECT_LABEL}</div>
            <h1>Pull requests</h1>
            <div className="sub">PRs Hive opened on your remote, each linked to the stories that produced it.</div>
          </div>
          <Btn kind="outline" icon="external-link">Open on GitHub</Btn>
        </div>
      </div>
      <div style={{ padding: "6px 32px 32px", display: "flex", flexDirection: "column", gap: 12 }}>
        {HD.prs.map(pr => {
          const [ic, col] = prIcon[pr.status] || prIcon.review;
          return (
            <div key={pr.num} className="card" style={{ padding: "16px 20px", display: "grid", gridTemplateColumns: "24px 1fr auto", gap: 14, alignItems: "start" }}>
              <span style={{ color: col, display: "flex", marginTop: 2 }}><Icon name={ic} size={19} /></span>
              <div>
                <div style={{ font: "600 14.5px/1.35 var(--font-ui)", color: "var(--fg-1)" }}>
                  <span style={{ color: "var(--fg-3)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>#{pr.num}</span> {pr.title}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 9, flexWrap: "wrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7, font: "var(--t-body-sm)", color: "var(--fg-2)" }}>
                    <RoleAva role={pr.role} size={20} /> {HD.ROLE[pr.role].label}
                  </span>
                  <span className="meta-mono" style={{ background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", padding: "2px 8px" }}>{pr.branch}</span>
                  <span style={{ font: "var(--t-code-sm)" }}><span style={{ color: "var(--diff-add-fg)" }}>+{pr.add}</span> <span style={{ color: "var(--diff-del-fg)" }}>−{pr.del}</span></span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "var(--t-meta)", color: pr.checks === "passed" ? "var(--status-done)" : pr.checks === "failed" ? "var(--status-blocked)" : "var(--status-pending)" }}>
                    <Icon name={pr.checks === "passed" ? "check-circle-2" : pr.checks === "failed" ? "x-circle" : "loader"} size={13} /> checks {pr.checks}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 9 }}>
                <StatusChip status={pr.status} />
                <span className="meta-mono">{pr.time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
const HIVE_PROJECT_LABEL = "acme/web-dashboard";

Object.assign(window, { ProjectsHub, PRsView, CommandPalette, statusColor });
