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
    publisherName: process.env.AZURE_PUBLISHER_NAME || undefined,
    ...(azureConfigured
      ? {
          azureSignOptions: {
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
