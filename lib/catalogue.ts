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
  youtubePreviousUrl?: string;
  youtubeUnavailableAt?: string;
  youtubeUpdatedAt?: string;
  notes: string;
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
    next = {
      ...next,
      bytes: source.bytes,
      duration: source.duration,
      availability: source.availability,
      sourceUpdatedAt: source.sourceUpdatedAt,
      duplicateGroup: source.duplicateGroup,
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
    if (v.youtubeUrl) v.youtubeUrl = youtubeUrl(v.youtubeUrl);
    ids.add(v.id);
  }
  return c;
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
      words.every((w) =>
        [v.title, v.course, v.module, v.discipline, v.source, ...v.tags]
          .join(' ')
          .toLocaleLowerCase()
          .includes(w),
      ),
  );
}
