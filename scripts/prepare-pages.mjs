import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateEnvelope } from '../lib/vault.ts';
const directory = 'dist/client';
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.github.com; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'none'";
const indexPath = path.join(directory, 'index.html');
let html = await readFile(indexPath, 'utf8');
if (!html.includes('Dental Library'))
  throw new Error('Missing library page in static export.');
html = html.replace(
  '<head>',
  `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`,
);
await writeFile(indexPath, html);
await writeFile(path.join(directory, '.nojekyll'), '');
validateEnvelope(
  JSON.parse(await readFile(path.join(directory, 'library.enc.json'), 'utf8')),
);
const forbidden = [
  '.private',
  'catalogue.json',
  'library-password.txt',
  'sources.json',
  '.env',
  'node_modules',
];
let secret = '';
try {
  secret = (await readFile('.private/library-password.txt', 'utf8')).trim();
} catch {}
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (forbidden.includes(entry.name))
      throw new Error('Private data found in the publish directory.');
    if (entry.isDirectory()) await scan(p);
    else {
      if (entry.name.endsWith('.map'))
        throw new Error('Unexpected source map in public output.');
      if (secret && (await readFile(p)).includes(Buffer.from(secret)))
        throw new Error('Library password found in public output.');
    }
  }
}
await scan(directory);
console.log(
  'GitHub Pages output verified: encrypted catalogue, no private files or password.',
);
