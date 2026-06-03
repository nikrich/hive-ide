# CI/CD Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, package, and publish the Hive IDE Electron app for macOS, Windows, and Linux via GitHub Actions, with release-please-driven versioning and conditional code signing (mac Developer ID + notarization, Windows Azure Trusted Signing).

**Architecture:** Three GitHub Actions workflows — `ci.yml` (typecheck/test/build gate), `release-please.yml` (version + Release PR automation), and `release-build.yml` (3-OS matrix that packages with electron-builder and publishes installers to the triggering Release). electron-builder config moves from `package.json` into `electron-builder.config.cjs` so signing can be toggled on the presence of secrets without failing unsigned builds.

**Tech Stack:** Electron 33, electron-vite, electron-builder 25, GitHub Actions, release-please-action v4, node-pty (native, rebuilt per OS), `png-to-ico` + `iconutil`/`sips` for icon generation.

---

## File Structure

- Create: `electron-builder.config.cjs` — electron-builder config (migrated from `package.json`), conditional signing.
- Create: `build/icon.icns` — generated macOS icon.
- Create: `build/icon.ico` — generated Windows icon.
- Create: `build/entitlements.mac.plist` — hardened-runtime entitlements for notarization.
- Create: `.github/workflows/ci.yml` — quality gate.
- Create: `.github/workflows/release-please.yml` — release automation.
- Create: `.github/workflows/release-build.yml` — package & publish matrix.
- Create: `release-please-config.json` — release-please configuration.
- Create: `.release-please-manifest.json` — release-please version manifest.
- Modify: `package.json` — remove inline `build` block, fix `build:*` scripts.
- Modify: `README.md` — document required signing secrets.

---

## Task 1: Generate platform icons

**Files:**
- Create: `build/icon.icns`
- Create: `build/icon.ico`

- [ ] **Step 1: Generate the macOS `.icns` from `build/icon.png`**

Run:
```bash
cd /Users/jannik/development/nikrich/hive-ide
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z $size $size build/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  dbl=$((size*2))
  sips -z $dbl $dbl build/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns
```
Expected: `build/icon.icns` created, no errors.

- [ ] **Step 2: Generate the Windows `.ico` from `build/icon.png`**

Run:
```bash
npx --yes png-to-ico build/icon.png > build/icon.ico
```
Expected: `build/icon.ico` created (non-empty).

- [ ] **Step 3: Verify both icons exist and are non-empty**

Run:
```bash
ls -l build/icon.icns build/icon.ico
file build/icon.icns build/icon.ico
```
Expected: both files listed, non-zero size; `file` reports Mac OS X icon and MS Windows icon resource.

- [ ] **Step 4: Commit**

```bash
git add build/icon.icns build/icon.ico
git commit -m "build(icons): generate icns and ico from icon.png"
```

---

## Task 2: Add macOS entitlements file

**Files:**
- Create: `build/entitlements.mac.plist`

- [ ] **Step 1: Create the entitlements file**

`build/entitlements.mac.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.inherit</key>
    <true/>
  </dict>
</plist>
```

- [ ] **Step 2: Validate the plist parses**

Run:
```bash
plutil -lint build/entitlements.mac.plist
```
Expected: `build/entitlements.mac.plist: OK`

- [ ] **Step 3: Commit**

```bash
git add build/entitlements.mac.plist
git commit -m "build(mac): add hardened-runtime entitlements for notarization"
```

---

## Task 3: Migrate electron-builder config to a conditional JS config file

**Files:**
- Create: `electron-builder.config.cjs`
- Modify: `package.json` (remove `build` block, fix `build:*` scripts)

- [ ] **Step 1: Create `electron-builder.config.cjs`**

`electron-builder.config.cjs`:
```js
// electron-builder configuration.
// Signing is conditional: builds run UNSIGNED unless the relevant secrets are
// present in the environment, so CI never fails for lack of certificates.
//
// macOS signing/notarization is driven by electron-builder's native env vars
// (CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER)
// set conditionally by the release-build workflow.
//
// Windows uses Azure Trusted Signing; the azureSignOptions block is only added
// when AZURE_CLIENT_ID is set (otherwise an unsigned build is produced).

const azureConfigured = !!process.env.AZURE_CLIENT_ID;
const macNotarize = !!process.env.APPLE_API_KEY;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.nikrich.hive-ide',
  productName: 'Hive IDE',
  directories: {
    buildResources: 'build',
    output: 'release/${version}',
  },
  files: ['out/**/*', 'resources/**/*'],
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: macNotarize,
  },
  win: {
    target: ['nsis', 'portable'],
    icon: 'build/icon.ico',
    ...(azureConfigured
      ? {
          azureSignOptions: {
            publisherName: process.env.AZURE_PUBLISHER_NAME,
            endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_CERT_PROFILE,
          },
        }
      : {}),
  },
  linux: {
    target: ['AppImage'],
    category: 'Development',
    icon: 'build/icon.png',
  },
};
```

- [ ] **Step 2: Remove the inline `build` block from `package.json`**

Delete the entire top-level `"build": { ... }` object from `package.json` (the block ending the file, starting at `"build": {` with `appId`, `mac`, `win`, `linux`). Leave a trailing `}` for the root object intact.

- [ ] **Step 3: Fix the `build:*` scripts in `package.json`**

Replace the three scripts so the dangling `--config` flag gets a value (the new config file):
```json
"build:mac": "npm run build && electron-builder --mac --config electron-builder.config.cjs",
"build:win": "npm run build && electron-builder --win --config electron-builder.config.cjs",
"build:linux": "npm run build && electron-builder --linux --config electron-builder.config.cjs",
```

- [ ] **Step 4: Verify the config file loads and `package.json` is valid JSON**

Run:
```bash
node -e "console.log(JSON.stringify(require('./electron-builder.config.cjs').appId))"
node -e "require('./package.json'); console.log('package.json OK')"
```
Expected: prints `"dev.nikrich.hive-ide"` then `package.json OK`.

- [ ] **Step 5: Verify a local unsigned pack works end-to-end (mac, current platform)**

Run:
```bash
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --config electron-builder.config.cjs --dir
```
Expected: completes without error; produces `release/0.1.0/mac*/Hive IDE.app` (unsigned). This proves the migrated config + icons + entitlements are wired correctly.

- [ ] **Step 6: Commit**

```bash
git add electron-builder.config.cjs package.json
git commit -m "build: move electron-builder config to conditional cjs file"
```

---

## Task 4: CI quality-gate workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    name: Typecheck, test, build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Typecheck
        run: npm run typecheck
      - name: Test
        run: npm test
      - name: Build
        run: npm run build
```

- [ ] **Step 2: Lint the workflow syntax**

Run:
```bash
npx --yes @action-validator/cli .github/workflows/ci.yml || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml OK')"
```
Expected: validator passes, or YAML parses with `yaml OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck/test/build quality gate"
```

---

## Task 5: release-please automation

**Files:**
- Create: `.github/workflows/release-please.yml`
- Create: `release-please-config.json`
- Create: `.release-please-manifest.json`

- [ ] **Step 1: Create `release-please-config.json`**

`release-please-config.json`:
```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "hive-ide",
      "changelog-path": "CHANGELOG.md",
      "include-component-in-tag": false
    }
  }
}
```

- [ ] **Step 2: Create `.release-please-manifest.json`**

Seed it with the current version so release-please knows the baseline.

`.release-please-manifest.json`:
```json
{
  ".": "0.1.0"
}
```

- [ ] **Step 3: Create `.github/workflows/release-please.yml`**

`.github/workflows/release-please.yml`:
```yaml
name: release-please

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  release-please:
    runs-on: ubuntu-latest
    steps:
      - uses: googleapis/release-please-action@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

- [ ] **Step 4: Validate JSON + YAML**

Run:
```bash
node -e "require('./release-please-config.json'); require('./.release-please-manifest.json'); console.log('json OK')"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-please.yml')); print('yaml OK')"
```
Expected: `json OK` then `yaml OK`.

- [ ] **Step 5: Commit**

```bash
git add release-please-config.json .release-please-manifest.json .github/workflows/release-please.yml
git commit -m "ci: add release-please version + release automation"
```

---

## Task 6: Release build & publish matrix

**Files:**
- Create: `.github/workflows/release-build.yml`

- [ ] **Step 1: Create `.github/workflows/release-build.yml`**

`.github/workflows/release-build.yml`:
```yaml
name: release-build

on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    name: Package (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            platform: mac
          - os: windows-latest
            platform: win
          - os: ubuntu-latest
            platform: linux
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies (rebuilds node-pty for this OS)
        run: npm ci

      - name: Build app bundle
        run: npm run build

      # --- macOS signing/notarization: only when the secret is present ---
      - name: Write Apple API key
        if: matrix.platform == 'mac' && env.APPLE_API_KEY_P8 != ''
        env:
          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
        run: |
          echo "$APPLE_API_KEY_P8" | base64 --decode > "$RUNNER_TEMP/apple_api_key.p8"
          echo "APPLE_API_KEY=$RUNNER_TEMP/apple_api_key.p8" >> "$GITHUB_ENV"

      - name: Package and publish
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS Developer ID cert (electron-builder reads these natively)
          CSC_LINK: ${{ secrets.MAC_CERT_P12 }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows Azure Trusted Signing
          AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
          AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
          AZURE_PUBLISHER_NAME: ${{ secrets.AZURE_PUBLISHER_NAME }}
          AZURE_CODE_SIGNING_ENDPOINT: ${{ secrets.AZURE_CODE_SIGNING_ENDPOINT }}
          AZURE_CODE_SIGNING_ACCOUNT: ${{ secrets.AZURE_CODE_SIGNING_ACCOUNT }}
          AZURE_CERT_PROFILE: ${{ secrets.AZURE_CERT_PROFILE }}
        shell: bash
        run: |
          # Disable auto-discovery of signing identity when no mac cert is set,
          # so unsigned mac builds don't fail looking for a keychain identity.
          if [ "${{ matrix.platform }}" = "mac" ] && [ -z "${CSC_LINK}" ]; then
            export CSC_IDENTITY_AUTO_DISCOVERY=false
          fi
          # Publish only for real releases; workflow_dispatch just builds.
          if [ "${{ github.event_name }}" = "release" ]; then
            PUBLISH=always
          else
            PUBLISH=never
          fi
          npx electron-builder --${{ matrix.platform }} \
            --config electron-builder.config.cjs \
            --publish "$PUBLISH"

      - name: Upload build artifacts (dispatch / inspection)
        if: github.event_name == 'workflow_dispatch'
        uses: actions/upload-artifact@v4
        with:
          name: hive-ide-${{ matrix.platform }}
          path: |
            release/**/*.dmg
            release/**/*.zip
            release/**/*.exe
            release/**/*.AppImage
          if-no-files-found: ignore
```

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-build.yml')); print('yaml OK')"
npx --yes @action-validator/cli .github/workflows/release-build.yml || true
```
Expected: `yaml OK` (action-validator advisory).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-build.yml
git commit -m "ci: add cross-platform package + publish matrix"
```

---

## Task 7: Document required signing secrets

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a "Releases & code signing" section to `README.md`**

Add at the end of `README.md`:
```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document release-please flow and signing secrets"
```

---

## Self-Review Notes

- **Spec coverage:** ci.yml (Task 4) ✓ quality gate; release-please (Task 5) ✓; release-build matrix + publish (Task 6) ✓; conditional mac + Azure signing (Tasks 3, 6) ✓; icons (Task 1) ✓; entitlements (Task 2) ✓; fixed npm scripts (Task 3) ✓; secrets docs (Task 7) ✓. Non-goals (auto-update runtime, deb/rpm, signed Linux) intentionally excluded.
- **Conditional-signing correctness:** Azure block only added when `AZURE_CLIENT_ID` set (Task 3 config); mac uses native `CSC_LINK`/`APPLE_API_*` env with `CSC_IDENTITY_AUTO_DISCOVERY=false` fallback (Task 6) — both keep unsigned builds green.
- **Name consistency:** config file `electron-builder.config.cjs` referenced identically in package.json scripts (Task 3) and both packaging invocations (Task 6). Secret names match between workflow (Task 6) and README (Task 7).
- **Verification reality:** Task 3 Step 5 does a real local `--dir` pack on macOS to prove config/icons/entitlements before any CI run; workflow YAML is lint-checked in Tasks 4–6.
```
