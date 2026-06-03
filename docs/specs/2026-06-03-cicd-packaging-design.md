# CI/CD Packaging for Hive IDE — Design

Date: 2026-06-03
Status: Approved (pending spec review)

## Goal

Build and package the Hive IDE Electron app for **macOS, Windows, and Linux**
in GitHub Actions, with automated versioning/releases via **release-please** and
**code signing** for macOS (Developer ID + notarization) and Windows (Azure
Trusted Signing). Signing is wired in but conditional, so builds succeed
unsigned until the secrets are added.

## Context

- App is an Electron app built with `electron-vite` + `electron-builder@25.1.8`.
- `electron-builder` is already configured inline in `package.json` (`build` key)
  with targets: mac `dmg`+`zip`, win `nsis`+`portable`, linux `AppImage`.
- Native dependency **`node-pty`** is rebuilt against Electron via the
  `postinstall` hook (`electron-rebuild --only node-pty`). Native modules cannot
  be cleanly cross-compiled, so packaging requires a per-OS build matrix.
- Remote: `github.com/nikrich/hive-ide`. No CI exists yet (`.github/` empty).
- Recent commits already follow Conventional Commits (`feat(...)`, `fix(...)`),
  which release-please depends on.
- `build/` contains only `icon.png` (11 KB). The mac config references
  `build/icon.icns`, which does not exist — mac packaging would fail today.

## Architecture — three workflows

### 1. `.github/workflows/ci.yml` — quality gate

- **Triggers:** `pull_request` and `push` to `main`.
- **Runner:** `ubuntu-latest` (fast/cheap; no packaging).
- **Steps:** `actions/checkout` → `actions/setup-node@v4` (Node 22, npm cache) →
  `npm ci` → `npm run typecheck` → `npm test` → `npm run build`.
- **Purpose:** fast feedback on PRs; gate before merge.

### 2. `.github/workflows/release-please.yml` — release automation

- **Triggers:** `push` to `main`.
- **Action:** `googleapis/release-please-action@v4`, `release-type: node`.
- **Behavior:** maintains a standing "Release PR" that bumps `version` in
  `package.json` and updates `CHANGELOG.md` from conventional commits. Merging
  that PR creates the git tag (e.g. `v0.2.0`) and a GitHub Release.
- **Permissions:** `contents: write`, `pull-requests: write`. Uses the default
  `GITHUB_TOKEN`.

### 3. `.github/workflows/release-build.yml` — package & publish

- **Trigger:** `release: { types: [published] }` (the Release created by
  release-please). Also `workflow_dispatch` for ad-hoc test builds.
- **Matrix:** `os: [macos-latest, windows-latest, ubuntu-latest]`.
- **Steps per runner:**
  1. `actions/checkout`
  2. `actions/setup-node@v4` (Node 22, npm cache)
  3. `npm ci` (runs `electron-rebuild` for `node-pty` on the native OS)
  4. Platform signing setup (conditional — see below)
  5. `npx electron-builder --<platform> --publish always`
     - mac: `--mac`, win: `--win`, linux: `--linux`
     - `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` so electron-builder attaches
       artifacts to the triggering Release.
- **Output artifacts:** `.dmg`+`.zip` (mac), `.exe` (nsis) + portable `.exe`
  (win), `.AppImage` (linux), plus `latest*.yml` update metadata.

## Signing — wired but conditional

Both paths are written into `release-build.yml` and gated so a missing secret
yields an **unsigned** build rather than a failure.

### macOS (Developer ID + notarization)

- A step decodes `MAC_CERT_P12` (base64 `.p12`) with password `MAC_CERT_PASSWORD`
  into a temporary keychain.
- Notarization via App Store Connect API key env vars consumed by
  electron-builder: `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`. Team id via `APPLE_TEAM_ID`.
- Gate the keychain/notarize steps with `if:` on the presence of `MAC_CERT_P12`.
- Requires `mac.hardenedRuntime: true` and an entitlements file
  (`build/entitlements.mac.plist`) for notarization.

**Secrets:** `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.

### Windows (Azure Trusted Signing)

- Add `azureSignOptions` to the win `electron-builder` config (publisherName,
  endpoint, codeSigningAccountName, certificateProfileName).
- Auth via env vars read by the Azure SDK / Trusted Signing tooling:
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, plus
  `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`,
  `AZURE_CERT_PROFILE`.
- Gate signing on the presence of `AZURE_CLIENT_ID`; otherwise build unsigned.

**Secrets:** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT`,
`AZURE_CERT_PROFILE`.

### Linux

AppImage is not signed (standard).

## Supporting changes

1. **Icons:** generate `build/icon.icns` (via `iconutil` from a generated
   `.iconset`) and `build/icon.ico` (multi-resolution) from `build/icon.png`;
   commit both. Add `win.icon: "build/icon.ico"` to the config.
   - Note: source `icon.png` is small (11 KB); a higher-res master is desirable
     later but out of scope here.
2. **Fix npm scripts:** `build:mac` / `build:win` / `build:linux` end in a
   dangling `--config` flag (it consumes the following arg, leaving no value).
   Remove it — config is inline in `package.json`.
3. **Entitlements:** add `build/entitlements.mac.plist` (and reference it in the
   mac config) for hardened-runtime notarization.
4. **Docs:** document required GitHub secrets (mac + Azure) in `README.md` so
   they can be added later to enable signing.

## Decisions (resolved during brainstorming)

- **Trigger model:** release-please drives versioning/releases; `release-build`
  runs on `release: published`.
- **Signing:** mac (Developer ID + notarization) **and** Windows (Azure Trusted
  Signing). Scaffolded now, secrets added later — builds stay green meanwhile.
- **CI checks:** typecheck + test + build gate on every PR/push.
- **Publishing:** electron-builder's built-in GitHub publisher
  (`--publish always`, `GH_TOKEN`) attaches assets to the triggering Release.
- **Icons:** generated from `build/icon.png`.

## Non-goals

- Auto-update server / update feed wiring (electron-updater runtime) — the
  `latest*.yml` files are produced but consuming them in-app is out of scope.
- High-resolution icon redesign.
- Linux package formats beyond AppImage (no `.deb`/`.rpm`/snap/flatpak).
- Signing the Linux build.

## Testing / verification

- `ci.yml`: verified by opening a PR and confirming typecheck/test/build pass.
- `release-build.yml`: verified via `workflow_dispatch` producing installers as
  workflow run artifacts (unsigned) before the first real tagged release.
- release-please: verified by landing a `feat:`/`fix:` commit on `main` and
  confirming a Release PR appears.
