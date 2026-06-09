# Extension Marketplace + Ecosystem — Design Spec

**Backlog:** Epic 10 (E10-01..E10-10). The backlog requires this spec before E10-01
("a registry source decision (own index JSON vs Open VSX-compatible). Capture
that decision in a spec before building.").
**Status (this branch):** plugin runtime exists (install from folder/GitHub,
per-project enable, LSP/language contributions). `contributes.keybindings`
(E10-04) landed. Command / keybinding / settings / theme registries all exist.

## Goal
Browse a registry of plugins, see descriptions/versions/README, and install by
id into the existing plugin storage — plus the remaining contribution points
and (eventually) an isolated extension host.

## Decision: registry source

| Option | Pros | Cons |
|---|---|---|
| **Own index JSON** (a `registry.json` hosted by the project, listing id → name, description, repo, releases) | Full control; trivial to host (a static file / gist); reuses the existing GitHub-release install path | Curated manually; small ecosystem |
| Open-VSX compatible | Large existing ecosystem | VSIX format + activation model ≠ this app's plugin model; heavy adapter work |

**Recommendation: own index JSON for v1.** Hive plugins are a bespoke
(declarative language/LSP) format, not VSIX, so Open-VSX entries wouldn't run
unmodified. A small curated `registry.json` (fetched over https, schema below)
maps cleanly onto the existing `installGithub` plumbing.

```jsonc
// registry.json
{
  "version": 1,
  "plugins": [
    {
      "id": "hive.python",
      "name": "Python",
      "description": "Pyright language support",
      "publisher": "hive-ide-official-plugins",
      "repo": { "owner": "nikrich", "repo": "hive-plugins" },
      "latest": "0.1.0",
      "readmeUrl": "https://.../python/README.md"
    }
  ]
}
```

## Architecture
- **main**: `plugins:registry-fetch` (GET the configured `registry.json` url,
  validate, cache with a TTL) + `plugins:registry-readme` (fetch a README).
  Install reuses the existing `installGithub`.
- **renderer**: extend `PluginsView` with a "Marketplace" tab — search the
  fetched index, show result cards (name/description/version), a README pane,
  and an Install button that calls `installGithub` then refreshes `plugins.list`.
- **auto-update (E10-02)**: compare installed `manifest.version` to registry
  `latest` (semver); show an "update available" badge + an Update action.

## Remaining contribution points (registries already exist)
- **E10-03 `contributes.commands`** — register into `commandStore`. Inert until
  an execution model exists; see extension host.
- **E10-05 `contributes.configuration`** — add a `pluginDefaults` layer to the
  settings store (merge order: defaults ← pluginDefaults ← user) + an
  `extraSettings: Record<string, unknown>` channel for non-core keys, surfaced
  in the settings editor under the plugin's section.
- **E10-07 `contributes.themes`** — register a theme into a dynamic theme
  registry (Monaco `defineTheme` from the contributed color map; chrome maps to
  the nearest base via the theme's declared `type`). Requires generalizing the
  theme system's `ConcreteThemeId` from a union to a registry of ids.
- **E10-06 `contributes.debuggers`** — ties to the DAP spec.

## Extension host (E10-09) — the hard decision
Running plugin JS requires an isolated execution context (the backlog calls this
out as P2). Options: a hidden `BrowserWindow`/`utilityProcess` sandbox, or a
Node `vm`/worker with a constrained API surface. This is a separate, larger
spec; until it lands, `contributes.commands` and any imperative plugin behavior
stay declarative-only. **Out of scope for the marketplace v1.**

## Phasing
1. `registry.json` schema + `plugins:registry-fetch` + Marketplace tab + install (E10-01).
2. Update-available detection + Update action (E10-02).
3. `contributes.configuration` (E10-05) + `contributes.themes` (E10-07).
4. Extension host (E10-09) → unlocks `contributes.commands` (E10-03) +
   `contributes.debuggers` (E10-06).
