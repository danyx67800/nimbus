import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'web', 'src', 'i18n.ts'), 'utf8');
const itStart = source.indexOf('const it:');
const enStart = source.indexOf('const en:');
const itBlock = source.slice(itStart, enStart);
const enBlock = source.slice(enStart, source.indexOf('const messages:'));
const keyPattern = /'([A-Za-z0-9.]+)':/g;
const itKeys = new Set([...itBlock.matchAll(keyPattern)].map((match) => match[1]));
const enKeys = new Set([...enBlock.matchAll(keyPattern)].map((match) => match[1]));

const used = new Set();
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) {
      const contents = fs.readFileSync(full, 'utf8');
      for (const match of contents.matchAll(/\bt\('([^']+)'/g)) {
        if (!match[1].endsWith('.')) used.add(match[1]);
      }
    }
  }
}
walk(path.join(root, 'web', 'src'));

const missingIt = [...used].filter((key) => !itKeys.has(key)).sort();
const missingEn = [...used].filter((key) => !enKeys.has(key)).sort();
console.log(`used keys: ${used.size}; it: ${itKeys.size}; en: ${enKeys.size}`);
if (missingIt.length) console.log(`missing in it:\n${missingIt.join('\n')}`);
if (missingEn.length) console.log(`missing in en:\n${missingEn.join('\n')}`);
if (missingIt.length || missingEn.length) process.exitCode = 1;
