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
      lecture.youtubeSource === 'manual' && update.youtubeSource === 'uploader';
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

type YoutubeBridgeMessage = {
  type?: unknown;
  requestId?: unknown;
  phase?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
};

export function youtubeBridgeMessage(
  value: unknown,
  requestId: string,
): YoutubeBridgeMessage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as YoutubeBridgeMessage;
  if (
    message.type !== 'cpd-library-youtube-sync' ||
    message.requestId !== requestId
  )
    return null;
  if (message.phase === 'ready') return message;
  if (
    message.ok === true &&
    message.result &&
    typeof message.result === 'object'
  )
    return message;
  if (
    message.ok === false &&
    typeof message.error === 'string' &&
    message.error.length <= 1_000
  )
    return message;
  return null;
}

function bridgeRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fetchYoutubeUpdates(): Promise<YoutubeSyncResult> {
  if (typeof window === 'undefined' || typeof document === 'undefined')
    return Promise.reject(
      new Error('YouTube updates are available in the browser.'),
    );

  const requestId = bridgeRequestId();
  const targetName = `cpd-library-youtube-${requestId}`;
  const helperOrigin = new URL(LOCAL_HELPER).origin;

  return new Promise((resolve, reject) => {
    let popup: Window | null = null;
    let settled = false;
    let ready = false;
    let timer = 0;
    let closedPoll = 0;

    function finish(error?: Error, result?: YoutubeSyncResult) {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', receive);
      window.clearTimeout(timer);
      window.clearInterval(closedPoll);
      if (popup && !popup.closed) popup.close();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('The local YouTube updater returned no result.'));
    }

    function receive(event: MessageEvent) {
      if (event.origin !== helperOrigin || event.source !== popup) return;
      const message = youtubeBridgeMessage(event.data, requestId);
      if (!message) return;
      if (message.phase === 'ready') {
        ready = true;
        window.clearTimeout(timer);
        timer = window.setTimeout(
          () => finish(new Error('The YouTube refresh timed out.')),
          10 * 60 * 1_000,
        );
        return;
      }
      if (message.ok === false) {
        finish(new Error(message.error as string));
        return;
      }
      finish(undefined, message.result as YoutubeSyncResult);
    }

    window.addEventListener('message', receive);
    popup = window.open(
      '',
      targetName,
      'popup,width=520,height=430,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      finish(
        new Error(
          'Allow the library to open the local YouTube updater, then try again.',
        ),
      );
      return;
    }

    const link = document.createElement('a');
    link.href = `${LOCAL_HELPER}/cpd-library/youtube-sync?requestId=${requestId}`;
    link.target = targetName;
    link.referrerPolicy = 'origin';
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();

    timer = window.setTimeout(
      () =>
        finish(
          new Error(
            'Open the YouTube Folder Uploader on this computer, then try the live update again.',
          ),
        ),
      10_000,
    );
    closedPoll = window.setInterval(() => {
      if (!popup?.closed || settled) return;
      finish(
        new Error(
          ready
            ? 'The local YouTube updater was closed before it finished.'
            : 'The local YouTube updater could not be opened.',
        ),
      );
    }, 500);
  });
}
