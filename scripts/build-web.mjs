import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const outDir = path.join(root, 'dist', 'web');
const assetsDir = path.join(outDir, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });

const production = process.env.NODE_ENV === 'production' || process.env.NIMBUS_MINIFY === '1';

await build({
  entryPoints: [path.join(root, 'web', 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: path.join(assetsDir, 'app.js'),
  minify: production,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});

for (const entry of fs.readdirSync(path.join(root, 'web', 'public'))) {
  const source = path.join(root, 'web', 'public', entry);
  const destination = path.join(outDir, entry);
  fs.cpSync(source, destination, { recursive: true });
}

// index.html and the service worker request the stylesheet from /assets/.
fs.copyFileSync(path.join(root, 'web', 'public', 'styles.css'), path.join(assetsDir, 'styles.css'));

console.log(`web build complete → ${outDir}`);
