/**
 * Run & Debug view (E3-04..E3-08).
 *
 * A workarea overlay (consistent with Search/Settings) hosting the debug
 * toolbar (start/stop/continue/step), the run/debug config picker, the call
 * stack, the selected frame's scopes/variables tree, watch expressions, and the
 * debug console. Reads/writes the debug store; the live session lives in main.
 */

import { useEffect, useMemo, useState } from 'react'

import { Icon } from './primitives'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useDebugStore, type Scope, type Variable } from '../store/debugStore'
import { loadLaunchConfig } from '../lib/launchConfig'
import type { DebugConfiguration } from '../../../types/launch'

export interface DebugViewProps {
  onClose?: () => void
}

export function DebugView({ onClose }: DebugViewProps) {
  const repos = useWorkspaceStore((s) => s.repos)
  const status = useDebugStore((s) => s.status)
  const error = useDebugStore((s) => s.error)
  const frames = useDebugStore((s) => s.frames)
  const activeFrameId = useDebugStore((s) => s.activeFrameId)
  const scopes = useDebugStore((s) => s.scopes)
  const output = useDebugStore((s) => s.output)
  const debug = useDebugStore()

  const [configs, setConfigs] = useState<DebugConfiguration[]>([])
  const [selected, setSelected] = useState(0)
  const [watchInput, setWatchInput] = useState('')

  // Load launch configs from the first repo (E3-02).
  useEffect(() => {
    const repo = repos[0]
    if (!repo) return
    let cancelled = false
    void loadLaunchConfig(repo.path).then((cfg) => {
      if (!cancelled) setConfigs(cfg.configurations)
    })
    return () => {
      cancelled = true
    }
  }, [repos])

  const running = status !== 'inactive'

  return (
    <div className="wsview">
      <div className="ws-toolbar">
        {onClose && (
          <button
            type="button"
            className="set-jsonbtn"
            title="Close"
            aria-label="Close debug"
            onClick={onClose}
          >
            <Icon name="arrow-left" size={13} />
          </button>
        )}
        <div className="ws-title">
          <Icon name="bug" size={15} /> Run &amp; Debug
        </div>
        <select
          className="dbg-config"
          value={selected}
          onChange={(e) => setSelected(Number(e.target.value))}
          disabled={configs.length === 0}
          aria-label="Debug configuration"
        >
          {configs.length === 0 ? (
            <option>No configurations (add launch.json)</option>
          ) : (
            configs.map((c, i) => (
              <option key={c.name} value={i}>
                {c.name}
              </option>
            ))
          )}
        </select>
        <div className="dbg-toolbar">
          {!running ? (
            <button
              type="button"
              className="dbg-btn run"
              title="Start Debugging (F5)"
              disabled={configs.length === 0}
              onClick={() => configs[selected] && void debug.start(configs[selected])}
            >
              <Icon name="play" size={15} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="dbg-btn"
                title="Continue (F5)"
                disabled={status !== 'stopped'}
                onClick={() => void debug.resume()}
              >
                <Icon name="play" size={15} />
              </button>
              <button
                type="button"
                className="dbg-btn"
                title="Step Over (F10)"
                disabled={status !== 'stopped'}
                onClick={() => void debug.next()}
              >
                <Icon name="corner-down-right" size={15} />
              </button>
              <button
                type="button"
                className="dbg-btn"
                title="Step Into (F11)"
                disabled={status !== 'stopped'}
                onClick={() => void debug.stepIn()}
              >
                <Icon name="arrow-down" size={15} />
              </button>
              <button
                type="button"
                className="dbg-btn"
                title="Step Out (⇧F11)"
                disabled={status !== 'stopped'}
                onClick={() => void debug.stepOut()}
              >
                <Icon name="arrow-up" size={15} />
              </button>
              <button
                type="button"
                className="dbg-btn stop"
                title="Stop (⇧F5)"
                onClick={() => void debug.stop()}
              >
                <Icon name="square" size={14} />
              </button>
            </>
          )}
        </div>
        <span className="dbg-status">{status}</span>
      </div>

      {error && <div className="plug-note err"><Icon name="alert-triangle" size={15} /> {error}</div>}

      <div className="dbg-body">
        <div className="dbg-cols">
          <section className="dbg-pane">
            <h3>Call Stack</h3>
            {frames.length === 0 ? (
              <div className="dbg-empty">Not paused.</div>
            ) : (
              frames.map((f) => (
                <div
                  key={f.id}
                  className={'dbg-frame' + (f.id === activeFrameId ? ' active' : '')}
                  onClick={() => void debug.selectFrame(f.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="dbg-frame-name">{f.name}</span>
                  <span className="dbg-frame-loc">
                    {f.path ? f.path.split(/[\\/]/).pop() : ''}:{f.line}
                  </span>
                </div>
              ))
            )}
          </section>

          <section className="dbg-pane">
            <h3>Variables</h3>
            {scopes.length === 0 ? (
              <div className="dbg-empty">No scopes.</div>
            ) : (
              scopes.map((s) => <ScopeNode key={s.variablesReference} scope={s} />)
            )}
          </section>

          <section className="dbg-pane">
            <h3>Watch</h3>
            <WatchPane watchInput={watchInput} setWatchInput={setWatchInput} />
          </section>
        </div>

        <section className="dbg-console">
          <h3>Debug Console</h3>
          <div className="dbg-console-out">
            {output.length === 0 ? (
              <div className="dbg-empty">No output.</div>
            ) : (
              output.map((l, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} className={'dbg-line ' + l.category}>
                  {l.text}
                </div>
              ))
            )}
          </div>
          <ConsoleInput />
        </section>
      </div>
    </div>
  )
}

function ScopeNode({ scope }: { scope: Scope }) {
  const variables = useDebugStore((s) => s.variables[scope.variablesReference])
  const load = useDebugStore((s) => s.loadVariables)
  const [open, setOpen] = useState(!scope.expensive)
  useEffect(() => {
    if (open) void load(scope.variablesReference)
  }, [open, scope.variablesReference, load])
  return (
    <div className="dbg-scope">
      <div
        className="dbg-scope-head"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} /> {scope.name}
      </div>
      {open &&
        (variables ?? []).map((v) => <VariableNode key={v.name} variable={v} depth={1} />)}
    </div>
  )
}

function VariableNode({ variable, depth }: { variable: Variable; depth: number }) {
  const variables = useDebugStore((s) => s.variables[variable.variablesReference])
  const load = useDebugStore((s) => s.loadVariables)
  const [open, setOpen] = useState(false)
  const expandable = variable.variablesReference > 0
  useEffect(() => {
    if (open && expandable) void load(variable.variablesReference)
  }, [open, expandable, variable.variablesReference, load])
  return (
    <>
      <div
        className="dbg-var"
        style={{ paddingLeft: depth * 12 }}
        onClick={() => expandable && setOpen((v) => !v)}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
      >
        {expandable && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />}
        <span className="dbg-var-name">{variable.name}</span>
        <span className="dbg-var-value">{variable.value}</span>
      </div>
      {open &&
        (variables ?? []).map((v) => (
          <VariableNode key={v.name} variable={v} depth={depth + 1} />
        ))}
    </>
  )
}

function WatchPane({
  watchInput,
  setWatchInput,
}: {
  watchInput: string
  setWatchInput: (v: string) => void
}) {
  const watches = useDebugStore((s) => s.watches)
  const results = useDebugStore((s) => s.watchResults)
  const addWatch = useDebugStore((s) => s.addWatch)
  const removeWatch = useDebugStore((s) => s.removeWatch)
  return (
    <div>
      <input
        className="dbg-watch-input"
        value={watchInput}
        placeholder="Add expression…"
        onChange={(e) => setWatchInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && watchInput.trim()) {
            addWatch(watchInput.trim())
            setWatchInput('')
          }
        }}
      />
      {watches.map((w) => (
        <div key={w} className="dbg-var">
          <span className="dbg-var-name">{w}</span>
          <span className="dbg-var-value">{results[w] ?? ''}</span>
          <button
            type="button"
            className="dbg-watch-x"
            onClick={() => removeWatch(w)}
            aria-label={`Remove watch ${w}`}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

function ConsoleInput() {
  const [value, setValue] = useState('')
  const frameId = useDebugStore((s) => s.activeFrameId)
  const status = useDebugStore((s) => s.status)
  const evaluate = async (): Promise<void> => {
    const expr = value.trim()
    if (!expr) return
    setValue('')
    try {
      const body = (await window.hive.debug.request('evaluate', {
        expression: expr,
        frameId: frameId ?? undefined,
        context: 'repl',
      })) as { result?: string }
      useDebugStore.setState((s) => ({
        output: [
          ...s.output,
          { category: 'input', text: `› ${expr}` },
          { category: 'result', text: body.result ?? '' },
        ].slice(-1000),
      }))
    } catch (e) {
      useDebugStore.setState((s) => ({
        output: [...s.output, { category: 'stderr', text: String(e) }].slice(-1000),
      }))
    }
  }
  return (
    <input
      className="dbg-console-in"
      value={value}
      placeholder={status === 'stopped' ? 'Evaluate…' : 'Evaluate (paused only)'}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void evaluate()
      }}
    />
  )
}

export default DebugView
