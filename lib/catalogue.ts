export const DISCIPLINES = [
  'Orthodontics',
  'Restorative dentistry',
  'Prosthodontics',
  'Periodontics',
  'Implant dentistry',
  'Oral surgery',
  'Endodontics',
  'Digital dentistry',
  'Orofacial pain & sleep',
  'Paediatric dentistry',
  'Radiology',
  'General dentistry',
] as const;
export const MAX_WATCH_HISTORY = 50;
export type LectureProgressStatus = 'unseen' | 'in-progress' | 'seen';
export type Lecture = {
  id: string;
  title: string;
  course: string;
  module: string;
  discipline: string;
  tags: string[];
  youtubeUrl: string;
  youtubeSource?: 'uploader' | 'manual';
  youtubeStatus?: 'current' | 'unavailable';
  youtubePrivacy?: 'private' | 'unlisted' | 'public';
  youtubePreviousUrl?: string;
  youtubeUnavailableAt?: string;
  youtubeUpdatedAt?: string;
  notes: string;
  progressStatus: LectureProgressStatus;
  watchHistory: string[];
  progressUpdatedAt?: string;
  source: string;
  relativePath: string;
  duration: number | null;
  bytes: number;
  importedAt: string;
  updatedAt: string;
  classificationReviewed: boolean;
  availability: string;
  duplicateGroup?: string;
  sourceUpdatedAt?: string;
};

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error('Progress changes require a valid timestamp.');
  return new Date(parsed).toISOString();
}

function normalizedWatchHistory(history: string[]): string[] {
  return [...new Set(history.map(canonicalTimestamp))]
    .sort()
    .slice(-MAX_WATCH_HISTORY);
}

/**
 * Return a lecture with a manually selected progress state. Viewing states are
 * also watch events. Resetting to unseen deliberately preserves earlier watch
 * history so the Home history remains a truthful activity record.
 */
export function setLectureProgress(
  lecture: Lecture,
  progressStatus: LectureProgressStatus,
  occurredAt: string,
): Lecture {
  if (!['unseen', 'in-progress', 'seen'].includes(progressStatus))
    throw new Error('Choose unseen, in-progress or seen.');
  const timestamp = canonicalTimestamp(occurredAt);
  const history = lecture.watchHistory || [];
  return {
    ...lecture,
    progressStatus,
    watchHistory:
      progressStatus === 'unseen'
        ? normalizedWatchHistory(history)
        : normalizedWatchHistory([...history, timestamp]),
    progressUpdatedAt: timestamp,
  };
}

/** Record a play/open event without moving an already-seen lecture backwards. */
export function recordLectureWatch(
  lecture: Lecture,
  watchedAt: string,
): Lecture {
  return setLectureProgress(
    lecture,
    lecture.progressStatus === 'seen' ? 'seen' : 'in-progress',
    watchedAt,
  );
}

export function lastWatchedAt(lecture: Lecture): string | undefined {
  if (!lecture.watchHistory?.length) return undefined;
  return lecture.watchHistory.reduce((latest, timestamp) =>
    timestamp > latest ? timestamp : latest,
  );
}

export function recentlyWatched(lectures: Lecture[], limit = 12): Lecture[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return lectures
    .filter((lecture) => !!lastWatchedAt(lecture))
    .sort((a, b) =>
      (lastWatchedAt(b) || '').localeCompare(lastWatchedAt(a) || ''),
    )
    .slice(0, count);
}

function progressEventAt(lecture: Lecture): number {
  return (
    Date.parse(lecture.progressUpdatedAt || lastWatchedAt(lecture) || '') || 0
  );
}

export type Catalogue = {
  schemaVersion: 1;
  updatedAt: string;
  lectures: Lecture[];
  importSummary?: {
    scannedAt?: string;
    sources: { name: string; count: number }[];
    documents: number;
    skipped: number;
  };
};

// Human edits and scanned file metadata have independent timestamps.
export function mergeCatalogues(
  current: Catalogue,
  incoming: Catalogue,
): { catalogue: Catalogue; changes: number } {
  const map = new Map(current.lectures.map((v) => [v.id, v]));
  let changes = 0;
  for (const record of incoming.lectures) {
    const old = map.get(record.id);
    if (!old) {
      map.set(record.id, record);
      changes++;
      continue;
    }
    let next =
      Date.parse(record.updatedAt) > Date.parse(old.updatedAt)
        ? { ...record }
        : { ...old };
    const source =
      Date.parse(record.sourceUpdatedAt || record.importedAt) >
      Date.parse(old.sourceUpdatedAt || old.importedAt)
        ? record
        : old;
    const oldProgressAt = progressEventAt(old);
    const incomingProgressAt = progressEventAt(record);
    const progress =
      incomingProgressAt > oldProgressAt
        ? record
        : oldProgressAt > incomingProgressAt
          ? old
          : next;
    next = {
      ...next,
      bytes: source.bytes,
      duration: source.duration,
      availability: source.availability,
      sourceUpdatedAt: source.sourceUpdatedAt,
      duplicateGroup: source.duplicateGroup,
      progressStatus: progress.progressStatus || 'unseen',
      watchHistory: normalizedWatchHistory([
        ...(old.watchHistory || []),
        ...(record.watchHistory || []),
      ]),
      progressUpdatedAt: progress.progressUpdatedAt,
    };
    if (
      Object.keys(next).some(
        (k) =>
          JSON.stringify(next[k as keyof Lecture]) !==
          JSON.stringify(old[k as keyof Lecture]),
      )
    ) {
      map.set(record.id, next);
      changes++;
    }
  }
  const oldScan = Date.parse(current.importSummary?.scannedAt || '') || 0;
  const newScan = Date.parse(incoming.importSummary?.scannedAt || '') || 0;
  const summary =
    newScan > oldScan ? incoming.importSummary : current.importSummary;
  if (summary !== current.importSummary) changes++;
  return {
    catalogue: {
      ...current,
      lectures: [...map.values()],
      importSummary: summary,
      updatedAt: changes ? new Date().toISOString() : current.updatedAt,
    },
    changes,
  };
}

export function normalizeTags(value: string | string[]): string[] {
  return [
    ...new Map(
      (Array.isArray(value) ? value : value.split(','))
        .map((s) => s.trim().replace(/^#/, ''))
        .filter(Boolean)
        .map((s) => [s.toLocaleLowerCase(), s]),
    ).values(),
  ].slice(0, 50);
}
export function youtubeUrl(value: string): string {
  if (!value.trim()) return '';
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete YouTube video URL.');
  }
  if (u.protocol !== 'https:' || u.username || u.password)
    throw new Error('Use an https:// YouTube video link.');
  const host = u.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'www.youtube-nocookie.com',
    ].includes(host)
  ) {
    id =
      u.pathname === '/watch'
        ? u.searchParams.get('v') || ''
        : /^\/(shorts|embed|live)\/([^/]+)\/?$/.exec(u.pathname)?.[2] || '';
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id))
    throw new Error(
      'Use a YouTube video link, not a channel or playlist link.',
    );
  return `https://www.youtube.com/watch?v=${id}`;
}
export function validateCatalogue(value: unknown): Catalogue {
  const c = value as Catalogue;
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !Array.isArray(c.lectures) ||
    c.lectures.length > 100000 ||
    typeof c.updatedAt !== 'string'
  )
    throw new Error('This is not a supported library backup.');
  const ids = new Set<string>();
  for (const v of c.lectures) {
    // Version 1 catalogues predate progress tracking. Additive defaults keep
    // old encrypted drafts and exports readable without a password reset or
    // destructive schema conversion.
    if (v && v.watchHistory === undefined) v.watchHistory = [];
    if (v && v.progressStatus === undefined)
      v.progressStatus = v.watchHistory?.length ? 'in-progress' : 'unseen';
    if (
      !v ||
      [
        'id',
        'title',
        'course',
        'module',
        'discipline',
        'youtubeUrl',
        'notes',
        'source',
        'relativePath',
        'importedAt',
        'updatedAt',
        'availability',
      ].some((k) => typeof v[k as keyof Lecture] !== 'string') ||
      !v.title.trim() ||
      !v.id ||
      ids.has(v.id) ||
      !DISCIPLINES.includes(v.discipline as (typeof DISCIPLINES)[number]) ||
      !Array.isArray(v.tags) ||
      v.tags.some((t) => typeof t !== 'string') ||
      typeof v.classificationReviewed !== 'boolean' ||
      !['unseen', 'in-progress', 'seen'].includes(v.progressStatus) ||
      !Array.isArray(v.watchHistory) ||
      v.watchHistory.length > MAX_WATCH_HISTORY ||
      v.watchHistory.some(
        (timestamp) =>
          typeof timestamp !== 'string' ||
          !Number.isFinite(Date.parse(timestamp)),
      ) ||
      (v.progressUpdatedAt !== undefined &&
        !Number.isFinite(Date.parse(v.progressUpdatedAt))) ||
      !Number.isFinite(Date.parse(v.updatedAt)) ||
      !Number.isFinite(Date.parse(v.importedAt)) ||
      (v.sourceUpdatedAt !== undefined &&
        !Number.isFinite(Date.parse(v.sourceUpdatedAt))) ||
      (v.youtubeSource !== undefined &&
        v.youtubeSource !== 'uploader' &&
        v.youtubeSource !== 'manual') ||
      (v.youtubeStatus !== undefined &&
        v.youtubeStatus !== 'current' &&
        v.youtubeStatus !== 'unavailable') ||
      (v.youtubePrivacy !== undefined &&
        v.youtubePrivacy !== 'private' &&
        v.youtubePrivacy !== 'unlisted' &&
        v.youtubePrivacy !== 'public') ||
      (v.youtubePreviousUrl !== undefined &&
        typeof v.youtubePreviousUrl !== 'string') ||
      (v.youtubeUnavailableAt !== undefined &&
        !Number.isFinite(Date.parse(v.youtubeUnavailableAt))) ||
      (v.youtubeUpdatedAt !== undefined &&
        !Number.isFinite(Date.parse(v.youtubeUpdatedAt))) ||
      typeof v.bytes !== 'number' ||
      !Number.isFinite(v.bytes) ||
      v.bytes < 0 ||
      !(
        v.duration === null ||
        (typeof v.duration === 'number' &&
          Number.isFinite(v.duration) &&
          v.duration >= 0)
      )
    )
      throw new Error(
        'The library contains an invalid or duplicate lecture record.',
      );
    v.watchHistory = normalizedWatchHistory(v.watchHistory);
    if (v.progressUpdatedAt)
      v.progressUpdatedAt = canonicalTimestamp(v.progressUpdatedAt);
    if (v.youtubeUrl) v.youtubeUrl = youtubeUrl(v.youtubeUrl);
    ids.add(v.id);
  }
  return c;
}
export type LectureSort = 'linked' | 'course' | 'title' | 'updated';
export function compareLectures(
  a: Lecture,
  b: Lecture,
  sort: LectureSort,
): number {
  if (sort === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
  if (sort === 'title')
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  const byCourse =
    a.course.localeCompare(b.course, undefined, { numeric: true }) ||
    a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true });
  if (sort === 'linked') {
    const linkRank = (lecture: Lecture) => {
      if (!lecture.youtubeUrl) return 2;
      return lecture.youtubePrivacy === 'private' ? 1 : 0;
    };
    return linkRank(a) - linkRank(b) || byCourse;
  }
  return byCourse;
}
export function filterLectures(
  lectures: Lecture[],
  filters: {
    query: string;
    discipline: string;
    source: string;
    status: string;
    tag: string;
    course: string;
  },
): Lecture[] {
  const words = filters.query
    .toLocaleLowerCase()
    .trim()
    .replace(/#/g, '')
    .split(/\s+/)
    .filter(Boolean);
  return lectures.filter(
    (v) =>
      (!filters.discipline || v.discipline === filters.discipline) &&
      (!filters.source || v.source === filters.source) &&
      (!filters.course || v.course === filters.course) &&
      (!filters.tag ||
        v.tags.some((t) => t.toLowerCase() === filters.tag.toLowerCase())) &&
      (filters.status !== 'linked' || !!v.youtubeUrl) &&
      (filters.status !== 'pending' || !v.youtubeUrl) &&
      (filters.status !== 'review' || !v.classificationReviewed) &&
      (filters.status !== 'unseen' || v.progressStatus === 'unseen') &&
      (filters.status !== 'in-progress' ||
        v.progressStatus === 'in-progress') &&
      (filters.status !== 'seen' || v.progressStatus === 'seen') &&
      words.every((w) =>
        [v.title, v.course, v.module, v.discipline, v.source, ...v.tags]
          .join(' ')
          .toLocaleLowerCase()
          .includes(w),
      ),
  );
}
