import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createSession, seal, unlock } from '../lib/vault.ts';
import { validateCatalogue } from '../lib/catalogue.ts';

await mkdir('.private', { recursive: true });
let password;
try {
  password = (await readFile('.private/library-password.txt', 'utf8')).trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Never silently rotate a password for an already encrypted library.
  try {
    await access('public/library.enc.json');
    throw new Error(
      'Restore the existing password file before encrypting updates.',
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  password = randomBytes(24).toString('base64url');
  await writeFile('.private/library-password.txt', password + '\n', {
    flag: 'wx',
  });
}
const data = validateCatalogue(
  JSON.parse(await readFile('.private/catalogue.json', 'utf8')),
);
let session;
try {
  session = (
    await unlock(
      JSON.parse(await readFile('public/library.enc.json', 'utf8')),
      password,
    )
  ).session;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  session = await createSession(password);
}
const envelope = await seal(data, session);
validateCatalogue((await unlock(envelope, password)).value);
await writeFile('public/library.enc.json', JSON.stringify(envelope));
console.log(
  `Encrypted and verified ${data.lectures.length} lectures. Password stays in the local .private folder.`,
);
