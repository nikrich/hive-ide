/* Hive IDE — right-side agent orchestration dock. Exports Dock. */

function AgentRosterRow({ a, onOpenFile }) {
  const r = HD.ROLE[a.role];
  return (
    <div className="agent-row">
      <RoleAva role={a.role} size={30} live={a.status === "running"} dot={a.status === "running" ? "var(--status-running)" : (a.status === "review" ? "var(--status-review)" : null)} />
      <div className="meta">
        <div className="nm">{r.label} <span className="model" style={{ fontWeight: 400 }}>· {r.model}</span></div>
        <div className="note">
          {a.file
            ? <span style={{ cursor: "pointer", color: "var(--accent-text)" }} onClick={() => onOpenFile(a.file)}>{a.note}</span>
            : a.note}
        </div>
      </div>
      <StatusChip status={a.status} />
    </div>
  );
}

function MiniBoard({ onOpenFile }) {
  const cols = [
    { key: "running", label: "In progress" },
    { key: "review", label: "In review" },
    { key: "pending", label: "Pending" },
    { key: "done", label: "Done" },
  ];
  return (
    <div className="dock-sec">
      {cols.map(col => {
        const items = HD.board[col.key] || [];
        return (
          <div className="mini-col" key={col.key}>
            <div className="ch">
              {col.key === "running" && <Pulse />}
              {col.label} <span className="ct">{items.length}</span>
            </div>
            {items.map(s => (
              <div key={s.id} className={"scard" + (s.status === "running" ? " live" : "")}
                   onClick={() => s.file && onOpenFile(s.file)}>
                <div className="st">
                  <span className="sid">{s.id}</span>
                  <span className="pts">{s.pts} pts</span>
                </div>
                <div className="stt">{s.title}</div>
                <div className="sf">
                  <RoleAva role={s.role} size={20} />
                  <span style={{ font: "var(--t-meta)", color: "var(--fg-3)" }}>{HD.ROLE[s.role].label}</span>
                  {s.file && <span style={{ marginLeft: "auto", font: "var(--t-code-sm)", color: "var(--accent-text)" }}>{s.file.split("/").pop()}</span>}
                </div>
              </div>
            ))}
            {!items.length && <div style={{ font: "var(--t-body-sm)", color: "var(--fg-3)", padding: "2px 2px 6px" }}>—</div>}
          </div>
        );
      })}
    </div>
  );
}

function RunPanel({ onOpenFile }) {
  return (
    <>
      <div className="dock-sec">
        <h4>Active run <span className="ct">REQ-001</span></h4>
        <div style={{ font: "600 13.5px/1.4 var(--font-ui)", color: "var(--fg-1)", marginBottom: 12 }}>
          OAuth2 with Google &amp; GitHub providers
        </div>
        <KV k="Status" v={<StatusChip status="running" />} />
        <KV k="Branch" v="feat/oauth2" mono />
        <KV k="Worktrees" v="3 active" mono />
        <KV k="Manager tick" v="184" mono />
        <KV k="Story points" v="14 / 31 done" mono />
      </div>
      <div className="dock-sec">
        <h4>Team roster <span className="ct">{HD.roster.length}</span></h4>
        {HD.roster.map((a, i) => <AgentRosterRow key={i} a={a} onOpenFile={onOpenFile} />)}
      </div>
    </>
  );
}

function KV({ k, v, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--border-subtle)", font: "var(--t-body-sm)" }}>
      <span style={{ color: "var(--fg-3)" }}>{k}</span>
      <span style={{ color: "var(--fg-1)", fontFamily: mono ? "var(--font-mono)" : undefined, fontSize: mono ? 12 : undefined, whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}

function ChatPanel() {
  const [msgs, setMsgs] = useState(HD.chat);
  const [text, setText] = useState("");
  const endRef = useRef(null);
  useEffect(() => { if (endRef.current) endRef.current.scrollTop = endRef.current.scrollHeight; }, [msgs]);
  function send() {
    if (!text.trim()) return;
    const t = text.trim();
    setMsgs(m => [...m, { who: "you", txt: t }]);
    setText("");
    setTimeout(() => setMsgs(m => [...m, { who: "manager", role: "manager", txt: "Understood — I'll fold that into the current run and re-pend the affected stories. The team will pick it up on the next tick." }]), 700);
  }
  return (
    <div className="chat">
      <div className="chat-scroll" ref={endRef}>
        {msgs.map((m, i) => (
          <div key={i} className={"msg " + m.who}>
            {m.who === "manager" && <RoleAva role="manager" size={26} />}
            <div className="bub" dangerouslySetInnerHTML={{ __html: m.who === "manager" ? "<b>Manager</b> · " + m.txt : m.txt }} />
          </div>
        ))}
      </div>
      <div className="chat-in">
        <input value={text} placeholder="Message the orchestrator…" onChange={e => setText(e.target.value)}
               onKeyDown={e => { if (e.key === "Enter") send(); }} />
        <button className="ib-btn" onClick={send}><Icon name="send-horizontal" size={16} /></button>
      </div>
    </div>
  );
}

function Dock({ onOpenFile }) {
  const [tab, setTab] = useState("run");
  return (
    <aside className="dock">
      <div className="dock-tabs">
        {[["run", "Run"], ["board", "Stories"], ["chat", "Chat"]].map(([k, l]) => (
          <button key={k} className={"dock-tab" + (tab === k ? " active" : "")} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="dock-body">
        {tab === "run" && <RunPanel onOpenFile={onOpenFile} />}
        {tab === "board" && <MiniBoard onOpenFile={onOpenFile} />}
        {tab === "chat" && <ChatPanel />}
      </div>
    </aside>
  );
}

Object.assign(window, { Dock });
