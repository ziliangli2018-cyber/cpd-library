"""Audit or change catalogue-linked private YouTube videos to unlisted.

The default mode is read-only. Apply mode requires an exact count confirmation
and updates at most ``--max-updates`` videos per run. Every run reads live video
status from YouTube; rerunning after an interruption therefore skips videos that
were already changed and is safe to resume.
"""

import argparse
import datetime as dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
DEFAULT_MAX_UPDATES = 100
MAX_CONFIGURABLE_UPDATES = 5000
MUTABLE_STATUS_FIELDS = (
    'license',
    'embeddable',
    'publicStatsViewable',
    'selfDeclaredMadeForKids',
    'containsSyntheticMedia',
)
READ_ONLY_STATUS_FIELDS = {
    'uploadStatus',
    'failureReason',
    'rejectionReason',
    'madeForKids',
}
KNOWN_STATUS_FIELDS = {
    'privacyStatus',
    'publishAt',
    *MUTABLE_STATUS_FIELDS,
    *READ_ONLY_STATUS_FIELDS,
}


class YouTubeRequestError(RuntimeError):
    """A redacted YouTube API failure safe to include in a local report."""


def _api_error(error):
    reason = ''
    try:
        payload = json.loads(error.read().decode('utf-8', errors='replace'))
        errors = payload.get('error', {}).get('errors', [])
        if errors and isinstance(errors[0], dict):
            reason = str(errors[0].get('reason', ''))
    except Exception:
        pass
    suffix = f': {reason}' if reason else ''
    return YouTubeRequestError(f'YouTube API request failed ({error.code}{suffix}).')


def request_json(url, token=None, data=None, method=None):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if isinstance(data, dict):
        body = json.dumps(data, separators=(',', ':')).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    else:
        body = data
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise _api_error(error) from None
    except urllib.error.URLError:
        raise YouTubeRequestError('YouTube API request failed because the network was unavailable.') from None


def access_token(token_path):
    credentials = json.loads(token_path.read_text(encoding='utf-8-sig'))
    required = ('client_id', 'client_secret', 'refresh_token')
    if any(not credentials.get(key) for key in required):
        raise RuntimeError('The existing YouTube credentials cannot refresh access. Re-authorise the uploader first.')
    body = urllib.parse.urlencode({
        'client_id': credentials['client_id'],
        'client_secret': credentials['client_secret'],
        'refresh_token': credentials['refresh_token'],
        'grant_type': 'refresh_token',
    }).encode('utf-8')
    refreshed = request_json(
        credentials.get('token_uri', 'https://oauth2.googleapis.com/token'),
        data=body,
        method='POST',
    )
    if not refreshed.get('access_token'):
        raise RuntimeError('Google did not return a refreshed YouTube access token.')
    return refreshed['access_token']


def youtube_get(path, token, **params):
    query = urllib.parse.urlencode(params)
    return request_json(f'https://www.googleapis.com/youtube/v3/{path}?{query}', token=token)


def youtube_update(video_id, status, token):
    query = urllib.parse.urlencode({'part': 'status'})
    return request_json(
        f'https://www.googleapis.com/youtube/v3/videos?{query}',
        token=token,
        data={'id': video_id, 'status': status},
        method='PUT',
    )


def chunks(values, size=50):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def video_id_from_url(value):
    try:
        parsed = urllib.parse.urlparse(str(value or '').strip())
    except ValueError:
        return ''
    host = (parsed.hostname or '').lower()
    if host in {'youtu.be', 'www.youtu.be'}:
        candidate = parsed.path.strip('/').split('/', 1)[0]
        return candidate if VIDEO_ID.fullmatch(candidate) else ''
    if host not in {
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtube-nocookie.com',
        'www.youtube-nocookie.com',
    }:
        return ''
    parts = parsed.path.strip('/').split('/')
    if parsed.path.rstrip('/') == '/watch':
        candidate = urllib.parse.parse_qs(parsed.query).get('v', [''])[0]
    elif len(parts) >= 2 and parts[0] in {'shorts', 'embed', 'live'}:
        candidate = parts[1]
    else:
        candidate = ''
    return candidate if VIDEO_ID.fullmatch(candidate) else ''


def catalogue_video_ids(catalogue):
    linked_count = 0
    invalid_count = 0
    video_ids = set()
    for lecture in catalogue.get('lectures', []):
        value = str(lecture.get('youtubeUrl') or '').strip()
        if not value:
            continue
        linked_count += 1
        video_id = video_id_from_url(value)
        if video_id:
            video_ids.add(video_id)
        else:
            invalid_count += 1
    return sorted(video_ids), linked_count, invalid_count


def verify_channel(token, expected_channel):
    channels = youtube_get('channels', token, part='id', mine='true', maxResults=50).get('items', [])
    returned = {item.get('id') for item in channels if item.get('id')}
    if expected_channel not in returned:
        visible = ', '.join(sorted(returned)) or 'none'
        raise RuntimeError(
            f'The authorised YouTube account did not return the configured channel. Returned: {visible}'
        )


def fetch_videos(video_ids, token):
    videos = {}
    for group in chunks(video_ids):
        response = youtube_get(
            'videos',
            token,
            part='id,snippet,status',
            id=','.join(group),
            maxResults=50,
        )
        requested = set(group)
        for item in response.get('items', []):
            video_id = item.get('id', '')
            if video_id in requested and VIDEO_ID.fullmatch(video_id):
                videos[video_id] = item
    return videos


def preserved_unlisted_status(status):
    unknown = sorted(set(status) - KNOWN_STATUS_FIELDS)
    if unknown:
        return None, f"unknown status fields: {', '.join(unknown)}"
    if status.get('publishAt'):
        return None, 'scheduled publication'
    result = {
        key: status[key]
        for key in MUTABLE_STATUS_FIELDS
        if key in status and status[key] is not None
    }
    result['privacyStatus'] = 'unlisted'
    return result, None


def atomic_write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def safe_error_message(error, token):
    message = str(error)
    if token:
        message = message.replace(token, '[redacted]')
    message = re.sub(r'(?i)bearer\s+[A-Za-z0-9._~-]+', 'Bearer [redacted]', message)
    return message[:300]


def _summary_base(expected_channel, linked_count, video_ids, invalid_count, videos):
    return {
        'channel': expected_channel,
        'catalogueLinks': linked_count,
        'uniqueValidLinkedVideos': len(video_ids),
        'duplicateCatalogueLinks': linked_count - invalid_count - len(video_ids),
        'invalidYouTubeLinks': invalid_count,
        'videosReturned': len(videos),
        'videosNotReturned': len(video_ids) - len(videos),
    }


def run(
    config_path,
    catalogue_path,
    report_path,
    *,
    apply=False,
    confirm_count=None,
    max_updates=DEFAULT_MAX_UPDATES,
):
    if max_updates < 1 or max_updates > MAX_CONFIGURABLE_UPDATES:
        raise RuntimeError(f'--max-updates must be between 1 and {MAX_CONFIGURABLE_UPDATES}.')
    if apply and confirm_count is None:
        raise RuntimeError('--apply also requires --confirm-count with the exact planned batch size.')
    if not apply and confirm_count is not None:
        raise RuntimeError('--confirm-count is only valid with --apply.')

    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    catalogue = json.loads(catalogue_path.read_text(encoding='utf-8-sig'))
    token_path = Path(config.get('youtubeToken', ''))
    expected_channel = str(config.get('youtubeChannelId', '')).strip()
    if not token_path.is_file() or not expected_channel:
        raise RuntimeError('Set youtubeToken and youtubeChannelId in .private/sources.json.')

    video_ids, linked_count, invalid_count = catalogue_video_ids(catalogue)
    token = access_token(token_path)
    verify_channel(token, expected_channel)
    videos = fetch_videos(video_ids, token)

    eligible = []
    foreign = []
    already_unlisted = []
    already_public = []
    other_privacy = []
    blocked = []
    for video_id in video_ids:
        video = videos.get(video_id)
        if not video:
            continue
        channel_id = video.get('snippet', {}).get('channelId')
        if channel_id != expected_channel:
            foreign.append(video_id)
            continue
        status = video.get('status', {})
        privacy = status.get('privacyStatus')
        if privacy == 'unlisted':
            already_unlisted.append(video_id)
        elif privacy == 'public':
            already_public.append(video_id)
        elif privacy != 'private':
            other_privacy.append(video_id)
        else:
            update_status, reason = preserved_unlisted_status(status)
            if reason:
                blocked.append({'video_id': video_id, 'reason': reason})
            else:
                eligible.append({'video_id': video_id, 'status': update_status})

    plan = eligible[:max_updates]
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    summary = {
        **_summary_base(expected_channel, linked_count, video_ids, invalid_count, videos),
        'mode': 'apply' if apply else 'dry-run',
        'checkedAt': now,
        'ownedPrivateEligible': len(eligible),
        'ownedPrivateBlocked': len(blocked),
        'ownedAlreadyUnlisted': len(already_unlisted),
        'ownedAlreadyPublic': len(already_public),
        'ownedOtherPrivacy': len(other_privacy),
        'foreignChannelVideos': len(foreign),
        'maxUpdates': max_updates,
        'plannedThisRun': len(plan),
        'remainingAfterPlannedBatch': len(eligible) - len(plan),
        'attempted': 0,
        'succeeded': 0,
        'failed': 0,
    }
    report = {
        'schemaVersion': 1,
        'summary': summary,
        'plan': [item['video_id'] for item in plan],
        'blocked': blocked,
        'failures': [],
        'successes': [],
    }

    if not apply:
        atomic_write_json(report_path, report)
        print(json.dumps(summary, separators=(',', ':')))
        return summary

    if confirm_count != len(plan):
        raise RuntimeError(
            f'--confirm-count must equal the live planned batch size ({len(plan)}); no videos were changed.'
        )

    atomic_write_json(report_path, report)
    for item in plan:
        video_id = item['video_id']
        summary['attempted'] += 1
        try:
            response = youtube_update(video_id, item['status'], token)
            response_status = response.get('status', {}).get('privacyStatus')
            if response.get('id') != video_id or response_status != 'unlisted':
                raise YouTubeRequestError('YouTube did not confirm the requested unlisted status.')
            report['successes'].append(video_id)
            summary['succeeded'] += 1
        except (RuntimeError, ValueError) as error:
            report['failures'].append({
                'video_id': video_id,
                'error': safe_error_message(error, token),
            })
            summary['failed'] += 1
        report['summary'] = summary
        atomic_write_json(report_path, report)

    print(json.dumps(summary, separators=(',', ':')))
    return summary


def main():
    parser = argparse.ArgumentParser(
        description='Dry-run or change catalogue-linked private YouTube videos to unlisted.',
    )
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--catalogue', default='.private/catalogue.json')
    parser.add_argument('--report', default='.private/youtube-unlisted-report.json')
    parser.add_argument('--apply', action='store_true', help='Perform the planned visibility updates.')
    parser.add_argument(
        '--confirm-count',
        type=int,
        help='Required with --apply; must equal plannedThisRun from a fresh dry run.',
    )
    parser.add_argument(
        '--max-updates',
        type=int,
        default=DEFAULT_MAX_UPDATES,
        help=f'Maximum updates in one run (default {DEFAULT_MAX_UPDATES}).',
    )
    args = parser.parse_args()
    try:
        run(
            Path(args.config),
            Path(args.catalogue),
            Path(args.report),
            apply=args.apply,
            confirm_count=args.confirm_count,
            max_updates=args.max_updates,
        )
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
