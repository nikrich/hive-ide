/* Hive IDE — bottom panel: terminal, manager.log, problems. Exports BottomPanel. */

function Terminal() {
  return (
    <div className="term">
      <div className="line"><span className="p">acme/web-dashboard</span> <span className="dim">feat/oauth2 $</span> hive status</div>
      <div className="line dim">Reading mempalace · drawer: requirements, stories, agents, escalations…</div>
      <div className="line"> </div>
      <div className="line"><span className="ok">●</span> REQ-001  OAuth2 with Google &amp; GitHub   <span className="dim">running · tick 184</span></div>
      <div className="line">  3 worktrees · 14/31 pts done · PR #218 in review</div>
      <div className="line"> </div>
      <div className="line"><span className="p">acme/web-dashboard</span> <span className="dim">feat/oauth2 $</span> hive logs --follow im-7c3a</div>
      <div className="line ok">✓ Intermediate spawned — analyzing STORY-002…</div>
      <div className="line">→ editing src/lib/oauth.ts (Google provider exchange)</div>
      <div className="line"><span className="dim">…streaming</span> <span className="cur"></span></div>
    </div>
  );
}

function ManagerLog() {
  return (
    <div className="mlog">
      {HD.log.map((l, i) => (
        <div className="ll" key={i}>
          <span className="tm">{l.t}</span>
          <span className={"tx " + (l.cls || "")}>{l.txt}</span>
        </div>
      ))}
      <div className="ll">
        <span className="tm">live</span>
        <span className="tx dim">waiting for next tick · 00:38 <span className="cur" style={{ background: "var(--fg-3)" }}></span></span>
      </div>
    </div>
  );
}

function Problems({ onOpenFile }) {
  return (
    <div className="prob">
      {HD.problems.map((p, i) => (
        <div className={"prob-row " + p.sev} key={i} onClick={() => onOpenFile(p.file)}>
          <span className="pi"><Icon name={p.sev === "warn" ? "alert-triangle" : "info"} /></span>
          <div>
            <div className="pm">{p.msg}</div>
            <div className="pl">{p.file}:{p.line}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function BottomPanel({ tab, setTab, onClose, onOpenFile }) {
  const tabs = [
    { k: "terminal", l: "Terminal", icon: "square-terminal" },
    { k: "log", l: "manager.log", icon: "scroll-text" },
    { k: "problems", l: "Problems", icon: "alert-triangle", cnt: HD.problems.length },
  ];
  return (
    <section className="panel">
      <div className="panel-tabs">
        {tabs.map(t => (
          <button key={t.k} className={"panel-tab" + (tab === t.k ? " active" : "")} onClick={() => setTab(t.k)}>
            <Icon name={t.icon} size={14} /> {t.l}
            {t.cnt ? <span className="cnt">{t.cnt}</span> : null}
          </button>
        ))}
        <div className="panel-actions">
          <button className="ib" title="Split"><Icon name="columns-2" /></button>
          <button className="ib" title="Close panel" onClick={onClose}><Icon name="x" /></button>
        </div>
      </div>
      <div className="panel-body">
        {tab === "terminal" && <Terminal />}
        {tab === "log" && <ManagerLog />}
        {tab === "problems" && <Problems onOpenFile={onOpenFile} />}
      </div>
    </section>
  );
}

Object.assign(window, { BottomPanel });
