import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  seal,
  unlock,
  openWithSession,
  validateEnvelope,
  fingerprint,
} from '../lib/vault.ts';
import {
  mergeCatalogues,
  validateCatalogue,
  normalizeTags,
  youtubeUrl,
  filterLectures,
} from '../lib/catalogue.ts';

import { pushGithub } from '../lib/github.ts';

const password = 'A very long random test password';
const lecture = {
  id: 'test',
  title: 'Private lecture 牙齿',
  course: 'Test course',
  module: 'Module 1',
  discipline: 'Orthodontics',
  tags: ['Clear aligners'],
  youtubeUrl: '',
  notes: 'Private sentinel α',
  source: 'Test',
  relativePath: 'lesson.ts',
  duration: 600,
  bytes: 1024,
  importedAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
  classificationReviewed: false,
  availability: 'Source file found',
};
const catalogue = {
  schemaVersion: 1,
  updatedAt: '2026-09-07T00:00:00Z',
  lectures: [lecture],
};

test('encryption protects Unicode records; rejects wrong passwords, tampering and invalid envelopes', async () => {
  const session = await createSession(password);
  const e = await seal(catalogue, session);
  const second = await seal(catalogue, session);
  assert.notEqual(e.iv, second.iv);
  assert.notEqual(e.ciphertext, second.ciphertext);
  assert.equal(e.salt, second.salt);
  assert(!JSON.stringify(e).includes('Private sentinel'));
  assert.deepEqual(
    validateCatalogue((await unlock(e, password)).value),
    catalogue,
  );
  assert.deepEqual(await openWithSession(second, session), catalogue);
  await assert.rejects(unlock(e, 'the wrong password'));
  const bytes = Buffer.from(e.ciphertext, 'base64');
  bytes[10] ^= 1;
  await assert.rejects(
    openWithSession({ ...e, ciphertext: bytes.toString('base64') }, session),
  );
  assert.throws(() => validateEnvelope({ ...e, iterations: 1 }));
  assert.throws(() => validateEnvelope({ ...e, iv: 'AA==' }));
  assert.throws(() => validateEnvelope({ ...e, version: 2 }));
});
test('tag and URL validation supports real video links and rejects malicious links', () => {
  assert.deepEqual(normalizeTags(' Aligners, #aligners, Implant, , '), [
    'aligners',
    'Implant',
  ]);
  assert.equal(
    youtubeUrl('https://youtu.be/abcdefghijk?t=5'),
    'https://www.youtube.com/watch?v=abcdefghijk',
  );
  assert.equal(
    youtubeUrl('https://www.youtube.com/shorts/abcdefghijk'),
    'https://www.youtube.com/watch?v=abcdefghijk',
  );
  for (const url of [
    'javascript:alert(1)',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=abc',
    'http://youtu.be/abcdefghijk',
  ])
    assert.throws(() => youtubeUrl(url));
  assert.throws(() =>
    validateCatalogue({ ...catalogue, lectures: [lecture, lecture] }),
  );
  assert.throws(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [{ ...lecture, youtubeUrl: 'javascript:alert(1)' }],
    }),
  );
});
test('search intersects tags, discipline, course and link status without losing titled TS recordings', () => {
  const f = {
    query: '#clear ALIGNERS',
    discipline: 'Orthodontics',
    source: 'Test',
    status: 'pending',
    tag: 'Clear aligners',
    course: 'Test course',
  };
  assert.equal(filterLectures([lecture], f).length, 1);
  assert.equal(filterLectures([lecture], { ...f, status: 'linked' }).length, 0);
  assert.equal(
    filterLectures([lecture], { ...f, query: 'not present' }).length,
    0,
  );
});
test('GitHub writes use the original baseline; conflicts and expired tokens preserve remote data', async () => {
  const session = await createSession(password);
  let remote = await seal(catalogue, session);
  const baseline = await fingerprint(remote);
  let sha = 'revision-1';
  let puts = 0;
  let expired = false;
  let ambiguous = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    if (expired) return new Response('{}', { status: 401 });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      assert.equal(body.sha, sha);
      const raw = Buffer.from(body.content, 'base64').toString('utf8');
      assert(!raw.includes('Private sentinel'));
      remote = JSON.parse(raw);
      sha = 'revision-' + (++puts + 1);
      if (ambiguous) throw new TypeError('Network response lost');
      return Response.json({ content: { sha } });
    }
    return init.headers.Accept === 'application/vnd.github.raw+json'
      ? Response.json(remote)
      : Response.json({ sha });
  };
  try {
    const config = {
      repo: 'owner/library',
      branch: 'main',
      token: 'test-token',
    };
    const next = await seal(
      { ...catalogue, updatedAt: '2026-09-07T01:00:00Z' },
      session,
    );
    await pushGithub(config, next, baseline);
    assert.equal(puts, 1);
    await assert.rejects(
      pushGithub(config, await seal(catalogue, session), baseline),
      /changed since/,
    );
    assert.equal(puts, 1);
    expired = true;
    await assert.rejects(
      pushGithub(config, next, await fingerprint(remote)),
      /401/,
    );
    assert.equal(puts, 1);
    expired = false;
    ambiguous = true;
    await pushGithub(
      config,
      await seal(catalogue, session),
      await fingerprint(remote),
    );
    assert.equal(puts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rescans merge file metadata and document counts without overwriting newer human edits', () => {
  const original = {
    ...lecture,
    notes: 'My newest notes',
    updatedAt: '2026-09-08T00:00:00Z',
  };
  const scanned = {
    ...lecture,
    duration: 900,
    availability: 'Source not confirmed on latest scan',
    sourceUpdatedAt: '2026-09-09T00:00:00Z',
  };
  const result = mergeCatalogues(
    { ...catalogue, lectures: [original] },
    {
      ...catalogue,
      lectures: [scanned],
      importSummary: {
        scannedAt: '2026-09-09T00:00:00Z',
        documents: 77,
        skipped: 1,
        sources: [],
      },
    },
  );
  assert.equal(result.catalogue.lectures[0].notes, 'My newest notes');
  assert.equal(result.catalogue.lectures[0].duration, 900);
  assert.equal(result.catalogue.importSummary.documents, 77);
  assert.equal(result.catalogue.lectures[0].updatedAt, original.updatedAt);
});
