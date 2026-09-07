"""Link current YouTube uploads to catalogue entries by exact source path."""
import argparse
import datetime as dt
import json
import os
import re
from pathlib import Path

VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
VIDEO_URL_ID = re.compile(r'(?:[?&]v=|youtu\.be/|/(?:shorts|embed|live)/)([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)')


def normalized(value):
    return os.path.normcase(os.path.normpath(value))


def parse_time(value):
    if not value:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def video_id_from_url(value):
    match = VIDEO_URL_ID.search(str(value or ''))
    return match.group(1) if match else ''


def run(config_path, catalogue_path, state_path=None, channel_path=None):
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    catalogue = json.loads(catalogue_path.read_text(encoding='utf-8-sig'))
    resolved_state = Path(state_path or config.get('youtubeUploadState', ''))
    resolved_channel = Path(channel_path or config.get('youtubeChannelCache', '.private/youtube-channel.json'))
    if not resolved_state.is_file():
        raise FileNotFoundError('Set youtubeUploadState in .private/sources.json or pass --state.')
    if not resolved_channel.is_file():
        raise FileNotFoundError('Refresh the current YouTube channel before linking uploads.')
    state = json.loads(resolved_state.read_text(encoding='utf-8-sig'))
    channel = json.loads(resolved_channel.read_text(encoding='utf-8-sig'))
    expected_channel = config.get('youtubeChannelId')
    if expected_channel and channel.get('channel_id') != expected_channel:
        raise RuntimeError('The channel cache belongs to a different YouTube channel.')
    current_video_ids = {video['video_id'] for video in channel.get('videos', []) if VIDEO_ID.fullmatch(video.get('video_id', ''))}

    uploaded = {}
    state_current = 0
    for record in state.get('records', {}).values():
        video_id = record.get('video_id', '')
        source_path = record.get('source_path', '')
        if record.get('status') != 'uploaded' or not source_path or video_id not in current_video_ids:
            continue
        state_current += 1
        key = normalized(source_path)
        current = uploaded.get(key)
        if current is None or parse_time(record.get('updated_at')) > parse_time(current.get('updated_at')):
            uploaded[key] = record

    roots = {source['name']: Path(source['path']) for source in config['sources']}
    matched = 0
    already_linked = 0
    manual_preserved = 0
    stale_links_marked_unavailable = 0
    new_links = 0
    changed = 0
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    for lecture in catalogue['lectures']:
        root = roots.get(lecture.get('source'))
        relative = lecture.get('relativePath')
        if root is None or not relative:
            continue
        record = uploaded.get(normalized(root / Path(relative)))
        if record is not None:
            matched += 1
            url = f"https://www.youtube.com/watch?v={record['video_id']}"
            if lecture.get('youtubeSource') == 'manual' and lecture.get('youtubeUrl') != url:
                manual_preserved += 1
                continue
            if lecture.get('youtubeUrl') == url:
                already_linked += 1
                continue
            when = record.get('updated_at') or now
            lecture.update(
                youtubeUrl=url,
                youtubeSource='uploader',
                youtubeStatus='current',
                youtubeUpdatedAt=when,
                updatedAt=when,
            )
            lecture.pop('youtubeUnavailableAt', None)
            new_links += 1
            changed += 1
            continue

        old_url = lecture.get('youtubeUrl', '')
        old_video_id = video_id_from_url(old_url)
        if (
            lecture.get('youtubeSource') == 'uploader'
            and old_url
            and old_video_id
            and old_video_id not in current_video_ids
        ):
            lecture.update(
                youtubeUrl='',
                youtubePreviousUrl=old_url,
                youtubeStatus='unavailable',
                youtubeUnavailableAt=now,
                youtubeUpdatedAt=now,
                updatedAt=now,
            )
            stale_links_marked_unavailable += 1
            changed += 1

    if changed:
        catalogue['updatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        temporary = catalogue_path.with_suffix('.youtube.tmp')
        temporary.write_text(json.dumps(catalogue, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        temporary.replace(catalogue_path)
    print(json.dumps({
        'currentChannelUploads': len(current_video_ids),
        'currentUploadsInLocalState': state_current,
        'uniqueSourcePaths': len(uploaded),
        'exactCatalogueMatches': matched,
        'newLinks': new_links,
        'catalogueChanges': changed,
        'alreadyLinked': already_linked,
        'manualLinksPreserved': manual_preserved,
        'staleUploaderLinksMarkedUnavailable': stale_links_marked_unavailable,
        'unmatchedCurrentStateRecords': len(uploaded) - matched,
    }))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--catalogue', default='.private/catalogue.json')
    parser.add_argument('--state')
    parser.add_argument('--channel-cache')
    args = parser.parse_args()
    run(Path(args.config), Path(args.catalogue), args.state, args.channel_cache)
