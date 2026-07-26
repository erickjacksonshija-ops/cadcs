// One-off, non-interactive replacement for `bubblewrap init` + signing-key creation.
// bubblewrap's own CLI wizard (inquirer prompts) does not work reliably over this
// environment's stdin, so this drives the same @bubblewrap/core APIs directly.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const corePath = 'C:\\Users\\Mr. Shija\\AppData\\Roaming\\npm\\node_modules\\@bubblewrap\\cli\\node_modules\\@bubblewrap\\core';
const core = require(corePath);

// bubblewrap's bundled FetchUtils sends a Firefox User-Agent, which trips
// ngrok's free-tier browser-warning interstitial (returns an HTML page
// instead of the actual asset). Route icon/manifest fetches through Node's
// native fetch with the header that tells ngrok to skip that page.
core.fetchUtils.fetch = async (input) => fetch(input, {
  headers: { 'ngrok-skip-browser-warning': 'true' },
  redirect: 'follow',
});

const MANIFEST_URL = 'https://reaffirm-rethink-palm.ngrok-free.dev/crew/manifest.json';
const TARGET_DIR = 'C:\\devtools\\cadcs-apk';
const config = JSON.parse(fs.readFileSync('C:\\Users\\Mr. Shija\\.bubblewrap\\config.json', 'utf8'));

async function main() {
  const twaManifest = await core.TwaManifest.fromWebManifest(MANIFEST_URL);

  twaManifest.packageId = 'com.cadcs.crew';
  twaManifest.name = 'CADCS Crew MDT';
  twaManifest.launcherName = 'CADCS Crew';
  twaManifest.appVersionCode = 1;
  twaManifest.appVersionName = '1.0';
  twaManifest.signingKey = {
    path: path.join(TARGET_DIR, 'android.keystore'),
    alias: 'cadcs',
  };

  const manifestFile = path.join(TARGET_DIR, 'twa-manifest.json');
  await twaManifest.saveToFile(manifestFile);
  console.log('Wrote', manifestFile);

  const twaGenerator = new core.TwaGenerator();
  const log = new core.ConsoleLog('generate');
  await twaGenerator.createTwaProject(TARGET_DIR, twaManifest, log);
  console.log('Android project generated at', TARGET_DIR);

  const manifestContents = fs.readFileSync(manifestFile);
  const sum = crypto.createHash('sha1').update(manifestContents).digest('hex');
  fs.writeFileSync(path.join(TARGET_DIR, 'manifest-checksum.txt'), sum);
  console.log('Checksum file written');

  const jdkHelper = new core.JdkHelper(process, config);
  const keyTool = new core.KeyTool(jdkHelper, log);
  await keyTool.createSigningKey({
    fullName: 'Erick Jackson Shija',
    organizationalUnit: 'CADCS',
    organization: 'Mbeya University of Science and Technology',
    country: 'TZ',
    password: 'cadcs-demo-2026',
    keypassword: 'cadcs-demo-2026',
    alias: twaManifest.signingKey.alias,
    path: twaManifest.signingKey.path,
  });
  console.log('Signing key created at', twaManifest.signingKey.path);
  console.log('DONE');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
