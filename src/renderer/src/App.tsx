import { Dock } from './components/AgentDock'
import { board, chat, roster } from './data/seed'

export default function App() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        background: 'var(--bg-base, #0B0F1A)',
        color: 'var(--fg-1, #F1F5F9)',
        fontFamily: "var(--font-ui, 'Inter', system-ui, sans-serif)",
      }}
    >
      <div style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ margin: 0, letterSpacing: '-0.02em' }}>Hive IDE</h1>
          <p style={{ marginTop: 8, opacity: 0.7 }}>
            Scaffold ready. Components landing as agents merge PRs.
          </p>
        </div>
      </div>
      <Dock
        onOpenFile={(path) => console.log('open file', path)}
        board={board}
        roster={roster}
        chat={chat}
      />
    </div>
  )
}
