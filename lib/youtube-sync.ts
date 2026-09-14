import { youtubeUrl, type Catalogue, type Lecture } from './catalogue.ts';

const LOCAL_HELPER = 'http://127.0.0.1:8765';

export type YoutubeUpdate = {
  id: string;
  youtubeUrl: string;
  youtubeSource: 'uploader' | 'manual';
  youtubeStatus: 'current' | 'unavailable';
  youtubePrivacy?: 'private' | 'unlisted' | 'public' | null;
  youtubeTitle?: string | null;
  youtubeUpdatedAt: string;
  youtubeUnavailableAt?: string | null;
  youtubePreviousUrl?: string | null;
};

export type YoutubeSyncResult = {
  updates: YoutubeUpdate[];
  summary: {
    currentChannelUploads?: number;
    matched?: number;
    newLinks?: number;
    changed?: number;
    privacyChanges?: number;
    titleChanges?: number;
  };
};

function validatedUpdate(value: unknown): YoutubeUpdate {
  const update = value as YoutubeUpdate;
  if (
    !update ||
    typeof update.id !== 'string' ||
    !update.id ||
    update.id.length > 100 ||
    typeof update.youtubeUrl !== 'string' ||
    !['uploader', 'manual'].includes(update.youtubeSource) ||
    !['current', 'unavailable'].includes(update.youtubeStatus) ||
    typeof update.youtubeUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(update.youtubeUpdatedAt)) ||
    (update.youtubePrivacy != null &&
      !['private', 'unlisted', 'public'].includes(update.youtubePrivacy)) ||
    (update.youtubeTitle != null &&
      (typeof update.youtubeTitle !== 'string' ||
        update.youtubeTitle.length > 500)) ||
    (update.youtubeUnavailableAt != null &&
      (typeof update.youtubeUnavailableAt !== 'string' ||
        !Number.isFinite(Date.parse(update.youtubeUnavailableAt)))) ||
    (update.youtubePreviousUrl != null &&
      typeof update.youtubePreviousUrl !== 'string')
  )
    throw new Error('The local YouTube helper returned an invalid update.');
  return {
    ...update,
    youtubeUrl: update.youtubeUrl ? youtubeUrl(update.youtubeUrl) : '',
    youtubeUpdatedAt: new Date(update.youtubeUpdatedAt).toISOString(),
  };
}

export function applyYoutubeUpdates(
  catalogue: Catalogue,
  result: YoutubeSyncResult,
): { catalogue: Catalogue; changes: number } {
  if (!result || !Array.isArray(result.updates) || !result.summary)
    throw new Error('The local YouTube helper returned an invalid response.');
  const updates = new Map(
    result.updates.map((value) => {
      const update = validatedUpdate(value);
      return [update.id, update] as const;
    }),
  );
  let changes = 0;
  const lectures = catalogue.lectures.map((lecture) => {
    const update = updates.get(lecture.id);
    if (!update) return lecture;
    const protectsManualLink =
      lecture.youtubeSource === 'manual' &&
      update.youtubeSource === 'uploader';
    if (protectsManualLink && lecture.youtubeUrl !== update.youtubeUrl)
      return lecture;
    if (
      Date.parse(update.youtubeUpdatedAt) <
      Date.parse(lecture.youtubeUpdatedAt || '')
    )
      return lecture;
    const next: Lecture = {
      ...lecture,
      youtubeUrl: update.youtubeUrl,
      youtubeSource: protectsManualLink ? 'manual' : update.youtubeSource,
      youtubeStatus: update.youtubeStatus,
      youtubeUpdatedAt: update.youtubeUpdatedAt,
    };
    for (const key of [
      'youtubePrivacy',
      'youtubeTitle',
      'youtubeUnavailableAt',
      'youtubePreviousUrl',
    ] as const) {
      const value = update[key];
      if (value == null || value === '') delete next[key];
      else (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (JSON.stringify(next) === JSON.stringify(lecture)) return lecture;
    changes += 1;
    return next;
  });
  return {
    catalogue: changes
      ? { ...catalogue, lectures, updatedAt: new Date().toISOString() }
      : catalogue,
    changes,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok)
      throw new Error(
        body.error || `The local YouTube helper returned ${response.status}.`,
      );
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchYoutubeUpdates(): Promise<YoutubeSyncResult> {
  let session;
  try {
    session = (await fetchJson(
      `${LOCAL_HELPER}/api/cpd-library/session`,
      { method: 'GET' },
      5_000,
    )) as { token?: string };
  } catch {
    throw new Error(
      'Open the YouTube Folder Uploader on this computer, then try the live update again.',
    );
  }
  if (!session.token)
    throw new Error('The local YouTube helper did not start a secure session.');
  return (await fetchJson(
    `${LOCAL_HELPER}/api/cpd-library/youtube-sync`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UI-Token': session.token,
      },
      body: '{}',
    },
    180_000,
  )) as YoutubeSyncResult;
}
