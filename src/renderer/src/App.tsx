export default function App() {
  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg-base, #0B0F1A)",
        color: "var(--fg-1, #F1F5F9)",
        fontFamily: "var(--font-ui, 'Inter', system-ui, sans-serif)",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <h1 style={{ margin: 0, letterSpacing: "-0.02em" }}>Hive IDE</h1>
        <p style={{ marginTop: 8, opacity: 0.7 }}>
          Scaffold ready. Components landing as agents merge PRs.
        </p>
      </div>
    </div>
  );
}
