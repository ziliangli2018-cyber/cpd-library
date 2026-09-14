"""Build a path-matched YouTube metadata patch for the browser bridge.

The output contains only lecture IDs and YouTube fields. It never writes the
decrypted catalogue and never places OAuth credentials in the patch or stdout.
By default the script refreshes the private channel cache through the existing
desktop OAuth token, then matches uploads using the uploader's exact source
paths. Optional description matching is path-based and rejects ambiguity.
"""
import argparse
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VIDEO_PRIVACY = {'private', 'unlisted', 'public'}
PATCH_FIELDS = (
    'youtubeUrl',
    'youtubeSource',
    'youtubeStatus',
    'youtubePrivacy',
    'youtubeTitle',
    'youtubeUnavailableAt',
    'youtubePreviousUrl',
)


def load_script(filename):
    path = ROOT / 'scripts' / filename
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, separators=(',', ':')),
        encoding='utf-8',
    )
    temporary.replace(path)


def project_path(value):
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def material_update(lecture, desired, refreshed_at):
    """Return the browser bridge's flat update when metadata changed."""
    if not any(lecture.get(key) != desired.get(key) for key in PATCH_FIELDS):
        return None
    return {
        'id': lecture['id'],
        **{key: desired.get(key) for key in PATCH_FIELDS},
        'youtubeUpdatedAt': refreshed_at,
    }


def build_patch(
    config,
    catalogue,
    state,
    channel,
    *,
    allow_description_matches=False,
):
    linker = load_script('link-youtube-uploads.py')
    generated_at = channel.get('refreshed_at') or dt.datetime.now(dt.timezone.utc).isoformat()
    current_videos = {
        video['video_id']: video
        for video in channel.get('videos', [])
        if linker.VIDEO_ID.fullmatch(str(video.get('video_id') or ''))
    }
    current_ids = set(current_videos)

    uploaded = {}
    state_video_ids = set()
    state_current = 0
    for record in state.get('records', {}).values():
        video_id = str(record.get('video_id') or '')
        source_path = str(record.get('source_path') or '')
        if record.get('status') != 'uploaded' or not source_path or video_id not in current_ids:
            continue
        state_current += 1
        state_video_ids.add(video_id)
        key = linker.normalized(source_path)
        previous = uploaded.get(key)
        if previous is None or linker.parse_time(record.get('updated_at')) > linker.parse_time(previous.get('updated_at')):
            uploaded[key] = record

    roots = {
        source['name']: Path(source['path'])
        for source in config.get('sources', [])
        if source.get('name') and source.get('path')
    }
    state_by_lecture = {}
    matched_state_paths = set()
    for lecture in catalogue.get('lectures', []):
        root = roots.get(lecture.get('source'))
        relative = lecture.get('relativePath')
        if root is None or not relative:
            continue
        key = linker.normalized(root / Path(relative))
        record = uploaded.get(key)
        if record is not None:
            state_by_lecture[lecture['id']] = record
            matched_state_paths.add(key)

    description_lookup, description_stats = linker.description_matches(
        catalogue,
        current_videos,
    )
    description_marker_ids = {
        video_id
        for video_id, video in current_videos.items()
        if linker.description_relative_path(video.get('description'))
    }
    description_match_ids = set(description_lookup)
    description_by_lecture = {}
    if allow_description_matches:
        for video_id, (lecture, reason) in description_lookup.items():
            current = description_by_lecture.get(lecture['id'])
            video = current_videos[video_id]
            if current is None or linker.parse_time(video.get('published_at')) > linker.parse_time(current[0].get('published_at')):
                description_by_lecture[lecture['id']] = (video, reason)

    updates = []
    summary = {
        'channelId': channel.get('channel_id', ''),
        'generatedAt': generated_at,
        'currentChannelUploads': len(current_videos),
        'currentUploadsInLocalState': state_current,
        'uniqueCurrentSourcePaths': len(uploaded),
        'exactStateMatches': len(state_by_lecture),
        'descriptionMatchesUsed': 0,
        'descriptionMarkersWithoutState': len(description_marker_ids - state_video_ids),
        'descriptionMatchesWithoutState': len(description_match_ids - state_video_ids),
        'existingLinksRefreshed': 0,
        'newLinks': 0,
        'titlesChanged': 0,
        'visibilityChanged': 0,
        'markedUnavailable': 0,
        'manualLinksPreserved': 0,
        'unchanged': 0,
        'unmatchedCurrentStateRecords': len(uploaded) - len(matched_state_paths),
        **description_stats,
    }

    for lecture in catalogue.get('lectures', []):
        current_url = str(lecture.get('youtubeUrl') or '')
        current_id = linker.video_id_from_url(current_url)
        record = state_by_lecture.get(lecture['id'])
        video = None
        source = ''

        if record is not None:
            proposed_id = record['video_id']
            if lecture.get('youtubeSource') == 'manual' and current_url and current_id != proposed_id:
                summary['manualLinksPreserved'] += 1
                video = current_videos.get(current_id)
                source = 'existing-link' if video is not None else ''
            else:
                video = current_videos[proposed_id]
                source = 'state'
        elif current_id in current_videos:
            video = current_videos[current_id]
            source = 'existing-link'
        elif allow_description_matches and lecture['id'] in description_by_lecture:
            video, _ = description_by_lecture[lecture['id']]
            source = 'description'
            summary['descriptionMatchesUsed'] += 1

        if video is not None:
            video_id = video['video_id']
            next_url = f'https://www.youtube.com/watch?v={video_id}'
            privacy = video.get('privacy_status')
            remote_title = str(video.get('title') or '').strip()
            desired = {
                'youtubeUrl': next_url,
                'youtubeSource': (
                    'manual'
                    if source == 'existing-link' and lecture.get('youtubeSource') == 'manual'
                    else 'uploader'
                ),
                'youtubeStatus': 'current',
                'youtubePrivacy': privacy if privacy in VIDEO_PRIVACY else None,
                'youtubeTitle': remote_title,
                'youtubeUnavailableAt': None,
                'youtubePreviousUrl': None,
            }

            update = material_update(lecture, desired, generated_at)
            if update is None:
                summary['unchanged'] += 1
                continue
            updates.append(update)
            if current_url != next_url:
                summary['newLinks'] += 1
            else:
                summary['existingLinksRefreshed'] += 1
            if remote_title and lecture.get('youtubeTitle') != remote_title:
                summary['titlesChanged'] += 1
            if privacy in VIDEO_PRIVACY and lecture.get('youtubePrivacy') != privacy:
                summary['visibilityChanged'] += 1
            continue

        if (
            lecture.get('youtubeSource') == 'uploader'
            and current_url
            and current_id
            and current_id not in current_ids
        ):
            desired = {
                'youtubeUrl': '',
                'youtubeSource': 'uploader',
                'youtubeStatus': 'unavailable',
                'youtubePrivacy': None,
                'youtubeTitle': str(lecture.get('youtubeTitle') or ''),
                'youtubePreviousUrl': current_url,
                'youtubeUnavailableAt': generated_at,
            }
            update = material_update(lecture, desired, generated_at)
            if update is not None:
                updates.append(update)
                summary['markedUnavailable'] += 1

    summary['updates'] = len(updates)
    return {
        'updates': updates,
        'summary': summary,
    }


def run(args):
    config_path = project_path(args.config)
    catalogue_path = project_path(args.catalogue)
    config = read_json(config_path)
    state_path = project_path(args.state or config.get('youtubeUploadState', ''))
    channel_path = project_path(
        args.channel_cache
        or config.get('youtubeChannelCache', '.private/youtube-channel.json')
    )
    output_path = project_path(args.output)
    if not state_path.is_file() and not args.allow_description_matches:
        raise FileNotFoundError(
            'The private uploader state is required for exact new-link matching.'
        )

    if not args.skip_refresh:
        refresh = load_script('refresh-youtube-channel.py')
        # The underlying command reports counts only, but keep this command's
        # stdout to one deliberately small, non-catalogue summary.
        with contextlib.redirect_stdout(io.StringIO()):
            refresh.run(config_path, channel_path)

    catalogue = read_json(catalogue_path)
    channel = read_json(channel_path)
    expected_channel = str(config.get('youtubeChannelId') or '')
    if expected_channel and channel.get('channel_id') != expected_channel:
        raise RuntimeError('The channel cache belongs to a different YouTube channel.')
    patch = build_patch(
        config,
        catalogue,
        read_json(state_path) if state_path.is_file() else {'records': {}},
        channel,
        allow_description_matches=args.allow_description_matches,
    )
    atomic_json(output_path, patch)
    print(json.dumps({
        'output': str(output_path),
        'generatedAt': patch['summary']['generatedAt'],
        'summary': patch['summary'],
    }))
    return patch


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--catalogue', default='.private/catalogue.json')
    parser.add_argument('--state')
    parser.add_argument('--channel-cache')
    parser.add_argument('--output', default='.private/youtube-sync-patch.json')
    parser.add_argument(
        '--skip-refresh',
        action='store_true',
        help='Use the existing private channel cache (intended for tests or offline audits).',
    )
    parser.add_argument(
        '--allow-description-matches',
        action='store_true',
        help='Also use unique Course/Original file paths embedded in upload descriptions.',
    )
    run(parser.parse_args())
