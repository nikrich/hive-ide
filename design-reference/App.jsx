/* Hive IDE — app shell, routing, file state, agent streaming, tweaks. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "indigo",
  "density": "comfortable",
  "showDock": true,
  "showPanel": true,
  "agentPresence": "ghost"
}/*EDITMODE-END*/;

// clone all known file contents into editable state
function initContents() {
  const o = {};
  Object.keys(HD.C).forEach(k => { if (!k.startsWith("__")) o[k] = HD.C[k]; });
  return o;
}

const AGENT_FILE = HD.AGENT_FILE;                       // src/lib/oauth.ts
const AGENT_BASE_LEN = HD.C[AGENT_FILE].length;         // committed length
const AGENT_TARGET = HD.C["__oauth_incoming"];          // streamed-to text

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [view, setView] = useState("ide");              // ide | hub | prs
  const [contents, setContents] = useState(initContents);
  const [saved, setSaved] = useState(initContents);
  const [tabs, setTabs] = useState(HD.openTabs.slice());
  const [active, setActive] = useState("src/components/AuthForm.tsx");
  const [palette, setPalette] = useState(false);
  const [projMenu, setProjMenu] = useState(false);
  const [project, setProject] = useState(HD.projects.find(p => p.current));
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState("log");

  const dirty = {};
  tabs.forEach(p => { if (p !== AGENT_FILE) dirty[p] = contents[p] !== saved[p]; });

  // redraw lucide icons after each render — icons now render their own SVG, no-op kept intentionally removed

  // ⌘K / ⌘S
  useEffect(() => {
    function h(e) {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") { e.preventDefault(); setPalette(p => !p); }
      if ((e.metaKey || e.ctrlKey) && k === "s") { e.preventDefault(); setSaved(s => ({ ...s, [active]: contents[active] })); }
      if ((e.metaKey || e.ctrlKey) && k === "j") { e.preventDefault(); setPanelOpen(o => !o); }
    }
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [active, contents]);

  // live agent streaming into oauth.ts — only while it's the active tab (keeps typing smooth elsewhere)
  const posRef = useRef(AGENT_BASE_LEN);
  useEffect(() => {
    if (view !== "ide" || active !== AGENT_FILE) return;
    if (posRef.current >= AGENT_TARGET.length) return;
    const id = setInterval(() => {
      posRef.current = Math.min(AGENT_TARGET.length, posRef.current + 2);
      setContents(c => ({ ...c, [AGENT_FILE]: AGENT_TARGET.slice(0, posRef.current) }));
      if (posRef.current >= AGENT_TARGET.length) clearInterval(id);
    }, 38);
    return () => clearInterval(id);
  }, [view, active]);

  function openFile(path) {
    setView("ide");
    setTabs(ts => ts.includes(path) ? ts : [...ts, path]);
    setActive(path);
    setContents(c => (path in c ? c : { ...c, [path]: HD.C[path] || "" }));
    setSaved(s => (path in s ? s : { ...s, [path]: HD.C[path] || "" }));
  }
  function closeTab(path) {
    setTabs(ts => {
      const i = ts.indexOf(path);
      const nt = ts.filter(p => p !== path);
      if (active === path) setActive(nt[Math.max(0, i - 1)] || nt[0] || null);
      return nt;
    });
  }
  function onChange(path, v) { setContents(c => ({ ...c, [path]: v })); }

  function nav(target) {
    setPalette(false);
    if (target === "prs") { setView("prs"); return; }
    if (target === "hub") { setView("hub"); return; }
    if (target === "terminal") { setPanelOpen(true); setPanelTab("terminal"); return; }
    if (target && target.startsWith("proj:")) { enterProject(target.slice(5)); return; }
    setView("ide");
  }
  function enterProject(id) {
    const p = HD.projects.find(x => x.id === id);
    if (p) setProject(p);
    setProjMenu(false);
    setView("ide");
  }

  const rail = [
    { key: "explorer", icon: "files", label: "Explorer", view: "ide" },
    { key: "hub", icon: "layout-grid", label: "Projects", view: "hub" },
    { key: "prs", icon: "git-pull-request", label: "Pull requests", view: "prs", badge: HD.prs.length },
    { key: "memory", icon: "brain-circuit", label: "Team memory" },
  ];
  const railActive = k => (k === "explorer" && view === "ide") || k === view;

  const liveAgents = HD.roster.filter(a => a.status === "running").length;

  return (
    <div className="shell" data-accent={t.accent} data-density={t.density === "compact" ? "compact" : "comfortable"}>
      {/* title bar */}
      <div className="titlebar">
        <div className="tb-dots"><i style={{ background: "#FB7185" }}></i><i style={{ background: "#FBBF24" }}></i><i style={{ background: "#34D399" }}></i></div>
        <div className="tb-brand">
          <img src="assets/hive-mark.png" alt="" />
          <span className="nm">Hive <span className="d">IDE</span></span>
        </div>
        <div className="proj-switch" onClick={() => setProjMenu(m => !m)}>
          <span className="proj-dot" style={{ background: statusColor(project.status) }}></span>
          <span className="pn">{project.name}</span>
          <span className="pb">{project.branch}</span>
          <Icon name="chevrons-up-down" size={14} />
        </div>
        <div className="tb-center">
          <div className="tb-search" onClick={() => setPalette(true)}>
            <Icon name="search" size={14} /> Search files, projects, agents…
            <span className="kbd">⌘K</span>
          </div>
        </div>
        <div className="tb-right">
          <button className="ib-btn" title="Notifications"><Icon name="bell" size={16} /></button>
          <button className="ib-btn" title="Settings"><Icon name="settings" size={16} /></button>
        </div>
      </div>

      {projMenu && <ProjectMenu project={project} onPick={enterProject} onClose={() => setProjMenu(false)} onHub={() => { setProjMenu(false); setView("hub"); }} />}

      {/* body */}
      <div className="body">
        <nav className="rail">
          <div className="brand"><img src="assets/hive-mark.png" alt="Hive" /></div>
          {rail.map(r => (
            <button key={r.key} className={"rail-btn" + (railActive(r.key) ? " active" : "")} title={r.label}
                    onClick={() => r.view && nav(r.view)}>
              <Icon name={r.icon} size={21} />
              {r.badge && <span className="rail-badge">{r.badge}</span>}
            </button>
          ))}
          <div className="rail-spacer"></div>
          <button className="rail-btn" title="Docs"><Icon name="book-open" size={21} /></button>
          <div className="rail-ava" title="You">JD</div>
        </nav>

        <div className="workarea">
          {view === "hub" && <ProjectsHub onEnter={enterProject} currentId={project.id} />}
          {view === "prs" && <PRsView onOpenFile={openFile} />}
          {view === "ide" && (
            <div className="ide"
                 data-dock={t.showDock ? "shown" : "hidden"}
                 data-panel={panelOpen && t.showPanel ? "open" : "closed"}
                 style={{ "--panel-h": (panelOpen && t.showPanel) ? "232px" : "0px" }}>
              <Explorer openFile={openFile} activePath={active} project={project} />
              <EditorGroup
                tabs={tabs} active={active} dirty={dirty} contents={contents}
                agentFile={AGENT_FILE} agentBaseLen={AGENT_BASE_LEN}
                onSelect={setActive} onClose={closeTab} onChange={onChange} />
              {t.showDock && <Dock onOpenFile={openFile} />}
              {panelOpen && t.showPanel &&
                <BottomPanel tab={panelTab} setTab={setPanelTab} onClose={() => setPanelOpen(false)} onOpenFile={openFile} />}
            </div>
          )}
        </div>
      </div>

      {/* status bar */}
      <div className="statusbar">
        <span className="sb-i sb-btn" onClick={() => setProjMenu(true)}><Icon name="git-branch" size={13} /> {project.branch}</span>
        <span className="sb-live"><Pulse /> {liveAgents} agents live</span>
        <span className="sb-i"><Icon name="box" size={13} /> {project.runs} run</span>
        <span className="sb-i sb-btn" onClick={() => { setPanelOpen(true); setPanelTab("problems"); }}>
          <Icon name="alert-triangle" size={13} /> {HD.problems.length}
        </span>
        <div className="right">
          <span className="sb-i"><Icon name="timer" size={13} /> next tick 00:38</span>
          <span className="sb-i sb-btn" onClick={() => { setPanelOpen(true); setPanelTab("terminal"); }}><Icon name="square-terminal" size={13} /> Terminal</span>
          <span className="sb-i"><Icon name="brain-circuit" size={13} /> mempalace · synced</span>
          <span className="sb-i">Opus 4.7</span>
        </div>
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} onNav={nav} onOpenFile={openFile} />}

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Accent" value={t.accent} options={["indigo", "teal", "amber"]} onChange={v => setTweak("accent", v)} />
        <TweakRadio label="Density" value={t.density} options={["comfortable", "compact"]} onChange={v => setTweak("density", v)} />
        <TweakSection label="Layout" />
        <TweakToggle label="Agent dock" value={t.showDock} onChange={v => setTweak("showDock", v)} />
        <TweakToggle label="Bottom panel" value={t.showPanel} onChange={v => setTweak("showPanel", v)} />
      </TweaksPanel>
    </div>
  );
}

/* project switcher dropdown */
function ProjectMenu({ project, onPick, onClose, onHub }) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 80 }} onClick={onClose}></div>
      <div className="menu">
        <div className="menu-head">Switch project</div>
        {HD.projects.map(p => (
          <div key={p.id} className={"menu-item" + (p.id === project.id ? " cur" : "")} onClick={() => onPick(p.id)}>
            <span className="proj-dot" style={{ background: statusColor(p.status), width: 8, height: 8 }}></span>
            <div className="mi-meta">
              <div className="mi-n">{p.name}</div>
              <div className="mi-s">{p.stack} · {p.branch}</div>
            </div>
            {p.agents > 0
              ? <span style={{ font: "var(--t-meta)", color: "var(--fg-2)", display: "inline-flex", gap: 5, alignItems: "center" }}>{p.status === "running" && <Pulse />}{p.agents}</span>
              : <span style={{ font: "var(--t-meta)", color: "var(--fg-3)" }}>idle</span>}
          </div>
        ))}
        <div className="menu-foot">
          <Btn kind="ghost" sm icon="layout-grid" onClick={onHub}>Open Projects hub</Btn>
        </div>
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
