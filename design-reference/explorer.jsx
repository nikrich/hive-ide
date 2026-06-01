/* Hive IDE — file explorer (recursive tree). Exports Explorer. */

function TreeNode({ node, depth, openSet, toggle, openFile, activePath }) {
  const pad = 6 + depth * 13;
  if (node.type === "folder") {
    const isOpen = openSet.has(node.name + depth + (node.path || ""));
    const key = node.name + depth + (node.path || "");
    return (
      <div>
        <div className="row" style={{ paddingLeft: pad }} onClick={() => toggle(key)}>
          <span className="tw"><Icon name={isOpen ? "chevron-down" : "chevron-right"} size={14} /></span>
          <span className="fi ic-folder"><Icon name={isOpen ? "folder-open" : "folder"} size={15} /></span>
          <span className="nm">{node.name}</span>
        </div>
        {isOpen && node.children.map((c, i) => (
          <TreeNode key={i} node={c} depth={depth + 1} openSet={openSet} toggle={toggle} openFile={openFile} activePath={activePath} />
        ))}
      </div>
    );
  }
  const [ic, tint] = fileIcon(node.name);
  const role = node.agent ? HD.ROLE[node.agent] : null;
  return (
    <div className={"row" + (activePath === node.path ? " sel" : "")} style={{ paddingLeft: pad + 14 }} onClick={() => openFile(node.path)}>
      <span className={"fi " + tint}><Icon name={ic} size={15} /></span>
      <span className="nm" style={{ color: node.git === "U" ? "var(--teal-400)" : undefined }}>{node.name}</span>
      {node.agent && <span className="agent-dot" title={role.label + " is editing"} style={{ background: role.color }}></span>}
      {node.git && <span className={"git git-" + node.git}>{node.git}</span>}
    </div>
  );
}

function Explorer({ openFile, activePath, project }) {
  // default-open folders that have open:true
  const seed = new Set();
  (function walk(nodes, depth) {
    nodes.forEach(n => {
      if (n.type === "folder") {
        if (n.open) seed.add(n.name + depth + (n.path || ""));
        walk(n.children, depth + 1);
      }
    });
  })(HD.tree, 0);
  const [openSet, setOpenSet] = useState(seed);
  const toggle = (key) => setOpenSet(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <aside className="explorer">
      <div className="exp-head">
        <span className="ttl">Explorer</span>
        <div className="exp-actions">
          <button className="ib" title="New file"><Icon name="file-plus" /></button>
          <button className="ib" title="New folder"><Icon name="folder-plus" /></button>
          <button className="ib" title="Refresh"><Icon name="refresh-cw" /></button>
          <button className="ib" title="Collapse all" onClick={() => setOpenSet(new Set())}><Icon name="chevrons-down-up" /></button>
        </div>
      </div>
      <div className="exp-repo">
        <Icon name="git-branch" size={14} /> {project.name.split("/")[1]}
        <span style={{ marginLeft: "auto", font: "var(--t-code-sm)", color: "var(--fg-3)" }}>{project.branch}</span>
      </div>
      <div className="tree">
        {HD.tree.map((n, i) => (
          <TreeNode key={i} node={n} depth={0} openSet={openSet} toggle={toggle} openFile={openFile} activePath={activePath} />
        ))}
      </div>
    </aside>
  );
}

Object.assign(window, { Explorer });
