# Hive IDE

A multi-agent code editor desktop app — the operator-facing IDE for [hungry-ghost-hive v2](https://github.com/nikrich/hungry-ghost-hive-v2).

Built **by** hive v2: each component below was authored by a worker agent (junior / intermediate / senior) in its own worktree, opened as a PR, and merged after QA passed.

## Platforms

- macOS (primary)
- Windows
- Linux

## Stack

- **Electron** — desktop shell
- **electron-vite** — main / preload / renderer dev + build
- **React 18 + TypeScript** — renderer
- **lucide-react** — icons

## Develop

```bash
npm install
npm run dev          # launches Electron pointed at the Vite dev renderer
```

## Build a Mac app

```bash
npm run build:mac    # produces release/<version>/Hive IDE-*.dmg
```

## Where the design came from

See [`design-reference/`](./design-reference/) — the original HTML/CSS/JSX prototypes from Claude Design that workers used as the visual spec.
