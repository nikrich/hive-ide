# Hive IDE

<img width="1919" height="1072" alt="image" src="https://github.com/user-attachments/assets/00b33093-12fb-481c-b0dd-dcb1117d7b25" />

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

## Releases & code signing

Releases are automated. Conventional-commit messages (`feat:`, `fix:`, …) on
`main` drive **release-please**, which opens a Release PR that bumps the version
and updates `CHANGELOG.md`. Merging that PR creates a GitHub Release, which
triggers `release-build.yml` to package macOS, Windows, and Linux installers and
attach them to the Release.

Builds run **unsigned** until the following repository secrets are added
(Settings → Secrets and variables → Actions):

### macOS (Developer ID + notarization)
- `MAC_CERT_P12` — base64-encoded Developer ID Application `.p12`
- `MAC_CERT_PASSWORD` — password for the `.p12`
- `APPLE_API_KEY_P8` — base64-encoded App Store Connect API key (`.p8`)
- `APPLE_API_KEY_ID` — API key ID
- `APPLE_API_ISSUER` — API key issuer ID
- `APPLE_TEAM_ID` — Apple Developer Team ID

### Windows (Azure Trusted Signing)
- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` — service principal
- `AZURE_PUBLISHER_NAME` — publisher display name
- `AZURE_CODE_SIGNING_ENDPOINT` — Trusted Signing endpoint URL
- `AZURE_CODE_SIGNING_ACCOUNT` — Trusted Signing account name
- `AZURE_CERT_PROFILE` — certificate profile name

To produce a base64 secret: `base64 -i cert.p12 | pbcopy` (macOS).
