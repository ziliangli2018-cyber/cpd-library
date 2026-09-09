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
  compareLectures,
  setLectureProgress,
  recordLectureWatch,
  lastWatchedAt,
  recentlyWatched,
  MAX_WATCH_HISTORY,
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
  progressStatus: 'unseen',
  watchHistory: [],
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
  assert.doesNotThrow(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [
        {
          ...lecture,
          youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
          youtubePrivacy: 'unlisted',
        },
      ],
    }),
  );
  assert.throws(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [{ ...lecture, youtubePrivacy: 'friends-only' }],
    }),
  );
});
test('old catalogues migrate to safe progress defaults and invalid progress is rejected', () => {
  const legacyLecture = { ...lecture };
  delete legacyLecture.progressStatus;
  delete legacyLecture.watchHistory;
  const migrated = validateCatalogue({
    ...catalogue,
    lectures: [legacyLecture],
  });
  assert.equal(migrated.lectures[0].progressStatus, 'unseen');
  assert.deepEqual(migrated.lectures[0].watchHistory, []);

  assert.throws(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [{ ...lecture, progressStatus: 'started' }],
    }),
  );
  assert.throws(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [{ ...lecture, watchHistory: ['not-a-date'] }],
    }),
  );
  assert.throws(() =>
    validateCatalogue({
      ...catalogue,
      lectures: [{ ...lecture, progressUpdatedAt: 0 }],
    }),
  );
});
test('progress helpers record bounded history without mutating lectures', () => {
  const first = '2026-09-09T01:00:00.000Z';
  const second = '2026-09-09T02:00:00.000Z';
  const third = '2026-09-09T03:00:00.000Z';
  const started = recordLectureWatch(lecture, first);
  assert.equal(lecture.progressStatus, 'unseen');
  assert.deepEqual(lecture.watchHistory, []);
  assert.equal(started.progressStatus, 'in-progress');
  assert.deepEqual(started.watchHistory, [first]);
  assert.equal(started.updatedAt, lecture.updatedAt);

  const duplicate = recordLectureWatch(started, first);
  assert.deepEqual(duplicate.watchHistory, [first]);
  const completed = setLectureProgress(duplicate, 'seen', second);
  const replayed = recordLectureWatch(completed, third);
  assert.equal(replayed.progressStatus, 'seen');
  assert.deepEqual(replayed.watchHistory, [first, second, third]);
  assert.equal(lastWatchedAt(replayed), third);

  const reset = setLectureProgress(replayed, 'unseen', '2026-09-09T04:00:00Z');
  assert.equal(reset.progressStatus, 'unseen');
  assert.deepEqual(reset.watchHistory, replayed.watchHistory);
  assert.equal(reset.progressUpdatedAt, '2026-09-09T04:00:00.000Z');

  const fullHistory = Array.from({ length: MAX_WATCH_HISTORY }, (_, index) =>
    new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  );
  const bounded = recordLectureWatch(
    { ...lecture, watchHistory: fullHistory },
    '2026-09-10T00:00:00Z',
  );
  assert.equal(bounded.watchHistory.length, MAX_WATCH_HISTORY);
  assert.equal(bounded.watchHistory.at(-1), '2026-09-10T00:00:00.000Z');
});
test('recent history is ordered by the latest watch event', () => {
  const older = recordLectureWatch(lecture, '2026-09-09T01:00:00Z');
  const newer = recordLectureWatch(
    { ...lecture, id: 'newer' },
    '2026-09-09T03:00:00Z',
  );
  const never = { ...lecture, id: 'never' };
  assert.deepEqual(
    recentlyWatched([older, never, newer]).map((item) => item.id),
    ['newer', 'test'],
  );
  assert.deepEqual(recentlyWatched([older, newer], 1), [newer]);
});
test('catalogue merges retain watch events and use the latest progress decision', () => {
  const current = recordLectureWatch(lecture, '2026-09-09T01:00:00Z');
  const incoming = setLectureProgress(
    { ...lecture, watchHistory: current.watchHistory },
    'seen',
    '2026-09-09T02:00:00Z',
  );
  const result = mergeCatalogues(
    { ...catalogue, lectures: [current] },
    { ...catalogue, lectures: [incoming] },
  ).catalogue.lectures[0];
  assert.equal(result.progressStatus, 'seen');
  assert.deepEqual(result.watchHistory, [
    '2026-09-09T01:00:00.000Z',
    '2026-09-09T02:00:00.000Z',
  ]);
});
test('newer progress merges without reverting newer human edits', () => {
  const remoteEdit = {
    ...lecture,
    notes: 'New notes saved by another person',
    tags: ['Clear aligners', 'Treatment planning'],
    updatedAt: '2026-09-09T02:00:00.000Z',
  };
  const localWatch = recordLectureWatch(
    { ...lecture, notes: 'Stale notes' },
    '2026-09-09T03:00:00.000Z',
  );
  const result = mergeCatalogues(
    { ...catalogue, lectures: [remoteEdit] },
    { ...catalogue, lectures: [localWatch] },
  ).catalogue.lectures[0];

  assert.equal(result.notes, remoteEdit.notes);
  assert.deepEqual(result.tags, remoteEdit.tags);
  assert.equal(result.updatedAt, remoteEdit.updatedAt);
  assert.equal(result.progressStatus, 'in-progress');
  assert.deepEqual(result.watchHistory, ['2026-09-09T03:00:00.000Z']);
  assert.equal(result.progressUpdatedAt, '2026-09-09T03:00:00.000Z');
});
test('linked-first ordering surfaces shareable videos before private and unlinked lectures', () => {
  const records = [
    { ...lecture, id: 'none', title: 'A', youtubeUrl: '' },
    {
      ...lecture,
      id: 'private',
      title: 'B',
      youtubeUrl: 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
      youtubePrivacy: 'private',
    },
    {
      ...lecture,
      id: 'unlisted',
      title: 'C',
      youtubeUrl: 'https://www.youtube.com/watch?v=CCCCCCCCCCC',
      youtubePrivacy: 'unlisted',
    },
  ];
  records.sort((a, b) => compareLectures(a, b, 'linked'));
  assert.deepEqual(
    records.map((record) => record.id),
    ['unlisted', 'private', 'none'],
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
  assert.equal(
    filterLectures([{ ...lecture, course: '  ' }], {
      ...f,
      query: '',
      course: 'Uncategorised course',
    }).length,
    1,
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
    progressStatus: 'seen',
    watchHistory: ['2026-09-08T00:30:00.000Z'],
    progressUpdatedAt: '2026-09-08T00:30:00.000Z',
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
  assert.equal(result.catalogue.lectures[0].progressStatus, 'seen');
  assert.deepEqual(result.catalogue.lectures[0].watchHistory, [
    '2026-09-08T00:30:00.000Z',
  ]);
});
