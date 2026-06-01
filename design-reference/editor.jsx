/* Hive IDE — tabbed editor group: editable code surface + agent streaming view. */

function TabBar({ tabs, active, dirty, agentFile, onSelect, onClose }) {
  return (
    <div className="tabbar">
      {tabs.map(path => {
        const name = path.split("/").pop();
        const [ic, tint] = fileIcon(name);
        const isAgent = path === agentFile;
        const role = isAgent ? HD.ROLE[HD.tree && "intermediate"] : null;
        return (
          <div key={path} className={"tab" + (active === path ? " active" : "")} onClick={() => onSelect(path)} title={path}>
            <span className={"fi " + tint}><Icon name={ic} size={14} /></span>
            <span className="tnm">{name}</span>
            {isAgent && <span className="agent-dot" style={{ background: "var(--role-intermediate)" }} title="Agent editing"></span>}
            {dirty[path]
              ? <span className="dirty" onClick={(e) => { e.stopPropagation(); onClose(path); }} title="Unsaved"></span>
              : <span className="x" onClick={(e) => { e.stopPropagation(); onClose(path); }}><Icon name="x" size={13} /></span>}
          </div>
        );
      })}
    </div>
  );
}

function Breadcrumb({ path, dirty }) {
  const segs = path.split("/");
  return (
    <div className="breadcrumb">
      <Icon name="folder" size={13} />
      {segs.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Icon name="chevron-right" size={13} />}
          <span className={"seg" + (i === segs.length - 1 ? " last" : "")}>{s}</span>
        </React.Fragment>
      ))}
      {dirty && <span style={{ marginLeft: 8, color: "var(--fg-3)", font: "var(--t-meta)" }}>● unsaved</span>}
    </div>
  );
}

/* Editable code surface. value + onChange controlled by App. */
function CodeEditor({ path, lang, value, onChange }) {
  const taRef = useRef(null);
  const [curLine, setCurLine] = useState(0);
  const lines = value.split("\n");
  const html = window.highlightCode(value, lang);

  function syncCaret() {
    const ta = taRef.current; if (!ta) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    setCurLine(upto.split("\n").length - 1);
  }
  function onKeyDown(e) {
    const ta = e.target;
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      const nv = value.slice(0, s) + "  " + value.slice(en);
      onChange(nv);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
  }
  const LH = 20.8, PT = 14;
  return (
    <div className="code-scroll">
      <div className="code-inner">
        <div className="gutter">
          {lines.map((_, i) => (
            <div key={i} className={"gl" + (i === curLine ? " cur" : "")}>{i + 1}</div>
          ))}
        </div>
        <div className="code-cell">
          <div className="lineglow" style={{ top: PT + curLine * LH }}></div>
          <pre className="code-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html + "\n" }} />
          <textarea
            ref={taRef}
            className="code-input"
            spellCheck={false}
            autoCapitalize="off" autoCorrect="off"
            value={value}
            onChange={(e) => { onChange(e.target.value); }}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onKeyDown={onKeyDown}
            onSelect={syncCaret}
          />
        </div>
      </div>
    </div>
  );
}

/* Read-only agent streaming view: committed text + streamed-added region + ghost caret. */
function AgentEditor({ path, lang, baseLen, value, role }) {
  const r = HD.ROLE[role] || HD.ROLE.intermediate;
  const committed = value.slice(0, baseLen);
  const added = value.slice(baseLen);
  const lines = value.split("\n");
  const htmlC = window.highlightCode(committed, lang);
  const htmlA = window.highlightCode(added, lang);
  const scrollRef = useRef(null);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [value]);

  return (
    <>
      <div className="agent-banner">
        <RoleAva role={role} size={22} live />
        <span><span className="who" style={{ color: r.color }}>{r.label}</span> is writing this file…</span>
        <span className="sp"></span>
        <span className="meta-mono">agent/web--im-7c3a</span>
        <span className="lock"><Icon name="lock" size={13} /> read-only while agent owns it</span>
      </div>
      <div className="code-scroll" ref={scrollRef}>
        <div className="code-inner">
          <div className="gutter">
            {lines.map((_, i) => <div key={i} className="gl">{i + 1}</div>)}
          </div>
          <div className="code-cell">
            <pre className="code-highlight" style={{ "--role-c": r.color }}>
              <span dangerouslySetInnerHTML={{ __html: htmlC }} />
              <span style={{ background: "var(--diff-add-bg)" }} dangerouslySetInnerHTML={{ __html: htmlA }} />
              <span className="ghost-caret" style={{ "--role-c": r.color }}></span>
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}

function EmptyEditor() {
  return (
    <div className="editor-empty">
      <img src="assets/hive-mark.png" alt="" />
      <div style={{ font: "var(--t-h3)", color: "var(--fg-2)" }}>No file open</div>
      <div className="hint">Open a file from the explorer, or press <span className="kbd">⌘K</span> to jump anywhere.</div>
    </div>
  );
}

function EditorGroup({ tabs, active, dirty, contents, agentFile, agentBaseLen, onSelect, onClose, onChange }) {
  const path = active;
  const node = path ? findNode(HD.tree, path) : null;
  const lang = node ? node.lang : "ts";
  return (
    <section className="editor">
      <TabBar tabs={tabs} active={active} dirty={dirty} agentFile={agentFile} onSelect={onSelect} onClose={onClose} />
      {!path && <EmptyEditor />}
      {path && (
        <>
          <Breadcrumb path={path} dirty={dirty[path]} />
          {path === agentFile
            ? <AgentEditor path={path} lang={lang} baseLen={agentBaseLen} value={contents[path]} role="intermediate" />
            : <CodeEditor path={path} lang={lang} value={contents[path]} onChange={(v) => onChange(path, v)} />}
        </>
      )}
    </section>
  );
}

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.type === "file" && n.path === path) return n;
    if (n.type === "folder") { const f = findNode(n.children, path); if (f) return f; }
  }
  return null;
}

Object.assign(window, { EditorGroup, findNode });
