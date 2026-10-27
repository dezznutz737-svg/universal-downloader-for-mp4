// electron-builder is configured with mac.identity=null (no paid Apple Developer
// ID). That leaves the app with only the linker's ad-hoc signature, whose seal
// doesn't cover the Info.plist — macOS reads that as tampered and blocks the app
// as "damaged", a dead end with no user bypass.
//
// Applying a *proper* ad-hoc signature (valid on disk, binds the Info.plist)
// gives the app a well-formed seal. A downloaded copy is still un-notarized, so
// macOS still warns, but via the normal "unverified developer" path where the
// user can Open Anyway (System Settings → Privacy & Security) or run `xattr -cr`.
//
// This does not replace notarization — it just gets macOS out of the dead end.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`afterPack: applied ad-hoc signature to ${appPath}`);
};
