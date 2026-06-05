# Code Signing & Notarization

How Hive IDE release artifacts are signed. Builds run **unsigned** unless the
relevant secrets are present, so CI never fails for lack of certificates
(see `electron-builder.config.cjs` and `.github/workflows/release-build.yml`).

## macOS — Developer ID + notarization (configured)

Distributed outside the Mac App Store (DMG/zip), so we use a **Developer ID
Application** certificate plus notarization via an App Store Connect API key.

### One-time credential creation

The `.p12` was built entirely from the CLI (no Keychain GUI needed):

```bash
mkdir -p ~/hive-signing && cd ~/hive-signing

# 1. Private key + CSR
openssl req -new -newkey rsa:2048 -nodes \
  -keyout DeveloperID.key -out DeveloperID.csr \
  -subj "/emailAddress=YOU@example.com/CN=Hive IDE Developer ID/C=US"

# 2. Upload DeveloperID.csr in the Apple portal:
#    Certificates → + → "Developer ID Application" → Profile Type "G2 Sub-CA".
#    Download the resulting .cer.

# 3. Convert + bundle cert with the private key into a password-protected .p12
openssl x509 -inform DER -in ~/Downloads/developerID_application.cer -out DeveloperID.cer.pem
P12_PASS="$(openssl rand -base64 24)"; echo "$P12_PASS" > DeveloperID.p12.password
openssl pkcs12 -export -inkey DeveloperID.key -in DeveloperID.cer.pem \
  -name "Developer ID Application" -legacy \
  -out DeveloperID.p12 -passout pass:"$P12_PASS"
```

The **App Store Connect API key** (for notarization) is created at
App Store Connect → Users and Access → Integrations → Keys (Access = Developer).
Download the one-time `AuthKey_<KEYID>.p8`; note the Key ID (in the filename)
and the Issuer ID (UUID at top of the Keys page).

### GitHub secrets

Set on `nikrich/hive-ide`:

| Secret | Source | Maps to (electron-builder) |
|---|---|---|
| `MAC_CERT_P12` | `base64 < DeveloperID.p12` (no newlines) | `CSC_LINK` |
| `MAC_CERT_PASSWORD` | contents of `DeveloperID.p12.password` | `CSC_KEY_PASSWORD` |
| `APPLE_API_KEY_P8` | `base64 < AuthKey_<KEYID>.p8` (workflow decodes it) | `APPLE_API_KEY` (path) |
| `APPLE_API_KEY_ID` | the `<KEYID>` from the filename | `APPLE_API_KEY_ID` |
| `APPLE_API_ISSUER` | Issuer UUID | `APPLE_API_ISSUER` |
| `APPLE_TEAM_ID` | 10-char team id, e.g. from cert CN parentheses | `APPLE_TEAM_ID` |

```bash
cd ~/hive-signing
base64 < DeveloperID.p12 | tr -d '\n' | gh secret set MAC_CERT_P12 --repo nikrich/hive-ide
tr -d '\n' < DeveloperID.p12.password | gh secret set MAC_CERT_PASSWORD --repo nikrich/hive-ide
base64 < ~/Downloads/AuthKey_<KEYID>.p8 | tr -d '\n' | gh secret set APPLE_API_KEY_P8 --repo nikrich/hive-ide
printf '<KEYID>'      | gh secret set APPLE_API_KEY_ID --repo nikrich/hive-ide
printf '<ISSUER-UUID>'| gh secret set APPLE_API_ISSUER --repo nikrich/hive-ide
printf '<TEAMID>'     | gh secret set APPLE_TEAM_ID --repo nikrich/hive-ide
```

Cert expires **2031-06** (renew before then).

## Windows — not yet configured

Config supports **Azure Trusted Signing** (`azureSignOptions`, gated on
`AZURE_CLIENT_ID`). Cheapest paid path (~$120/yr) but requires org/identity
verification. Free alternative for this MIT-licensed repo: apply to
**SignPath.io** OSS program. Until then Windows builds ship unsigned
(users click through SmartScreen "More info → Run anyway").

## Trigger a build

```bash
# Test build (no release published, artifacts uploaded for inspection)
gh workflow run release-build.yml --repo nikrich/hive-ide --ref main

# Real signed release: publish a GitHub Release (release-please drives this)
```
