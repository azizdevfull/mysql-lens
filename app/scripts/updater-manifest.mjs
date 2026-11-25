// Collects the signed NSIS installer and writes latest.json for the Tauri updater.
// Usage: node scripts/updater-manifest.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'release-assets';
const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const dir = 'target/release/bundle/nsis';
const setup = fs.readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
if (!setup || !fs.existsSync(path.join(dir, setup + '.sig'))) throw new Error(`Signed installer not found in ${dir}`);

// GitHub turns spaces into dots in asset names; use a stable name without spaces.
const name = `MySQL-Lens_${version}_x64-setup.exe`;
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(dir, setup), path.join(out, name));
fs.copyFileSync(path.join(dir, setup + '.sig'), path.join(out, name + '.sig'));

const manifest = {
  version,
  notes: fs.existsSync('release-notes.md') ? fs.readFileSync('release-notes.md', 'utf8').trim() : `MySQL Lens ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(path.join(dir, setup + '.sig'), 'utf8').trim(),
      url: `https://github.com/azizdevfull/mysql-lens/releases/download/app-v${version}/${name}`,
    },
  },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`latest.json -> ${manifest.platforms['windows-x86_64'].url}`);
