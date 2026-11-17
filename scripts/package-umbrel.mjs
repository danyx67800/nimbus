import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'umbrel');
const output = path.join(root, 'dist', 'umbrel-store');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true });

const appManifest = path.join(output, 'nimbus-app', 'umbrel-app.yml');
const assetBase = process.env.UMBREL_ASSET_BASE_URL?.replace(/\/+$/, '');
if (assetBase) {
  const manifest = fs.readFileSync(appManifest, 'utf8');
  const placeholder = 'https://raw.githubusercontent.com/danyx67800/nimbus/main/umbrel/nimbus-app';
  fs.writeFileSync(appManifest, manifest.replaceAll(placeholder, assetBase));
  console.log(`asset URLs rewritten to ${assetBase}`);
} else {
  console.warn('UMBREL_ASSET_BASE_URL not set; icon/gallery URLs still point at the placeholder repository.');
}

for (const required of ['icon.png', 'gallery/1.png', 'gallery/2.png']) {
  const file = path.join(output, 'nimbus-app', required);
  if (!fs.existsSync(file)) console.warn(`missing ${required}; publish it before submitting the store.`);
}

console.log(`Umbrel store assembled → ${output}`);
