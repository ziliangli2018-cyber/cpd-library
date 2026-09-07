import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { unlock } from '../lib/vault.ts';
import { validateCatalogue } from '../lib/catalogue.ts';
const path = process.argv[2];
if (!path)
  throw new Error(
    'Usage: node scripts/restore-backup.mjs PATH_TO_ENCRYPTED_BACKUP',
  );
const password = (
  await readFile('.private/library-password.txt', 'utf8')
).trim();
const data = validateCatalogue(
  (await unlock(JSON.parse(await readFile(path, 'utf8')), password)).value,
);
try {
  await copyFile(
    '.private/catalogue.json',
    '.private/catalogue.before-restore.json',
  );
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
await writeFile('.private/catalogue.json', JSON.stringify(data));
console.log(
  `Restored ${data.lectures.length} records locally. A previous local catalogue, if present, was backed up.`,
);
