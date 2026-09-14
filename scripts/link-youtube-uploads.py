"""Refresh catalogue YouTube metadata using path-based matches.

The local uploader state is authoritative when available. As a CI-compatible
fallback, descriptions written by the uploader may provide exact ``Course:``
and ``Original file:`` markers. A description match is accepted only when its
relative path identifies one catalogue lecture; titles alone are never used.
"""
import argparse
import datetime as dt
import json
import os
import re
import unicodedata
from pathlib import Path

VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
VIDEO_URL_ID = re.compile(r'(?:[?&]v=|youtu\.be/|/(?:shorts|embed|live)/)([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)')
DESCRIPTION_COURSE = re.compile(r'^Course:\s*(.*?)\s*$', re.IGNORECASE | re.MULTILINE)
DESCRIPTION_FILE = re.compile(r'^Original file:\s*(.*?)\s*$', re.IGNORECASE | re.MULTILINE)
DESCRIPTION_PAIR = re.compile(
    r'(?:^|\s)Course:\s*(.*?)\s+Original file:\s*(.*?)\s*$',
    re.IGNORECASE | re.DOTALL,
)


def normalized(value):
    return os.path.normcase(os.path.normpath(value))


def normalized_relative(value):
    """Normalize a relative media path consistently on Windows and in CI."""
    text = unicodedata.normalize('NFC', str(value or '')).strip().replace('\\', '/')
    parts = []
    for part in text.split('/'):
        part = part.strip()
        if not part or part == '.':
            continue
        if part == '..':
            return ''
        parts.append(part)
    return '/'.join(parts).casefold()


def description_relative_path(description):
    """Return the uploader-recorded relative path, or an empty string."""
    text = str(description or '')
    course_match = DESCRIPTION_COURSE.search(text)
    file_match = DESCRIPTION_FILE.search(text)
    if course_match and file_match:
        course = course_match.group(1).strip()
        filename = file_match.group(1).strip()
    else:
        # YouTube can flatten line breaks in descriptions returned by the API.
        pair_match = DESCRIPTION_PAIR.search(text)
        if not pair_match:
            return ''
        course = pair_match.group(1).strip()
        filename = pair_match.group(2).strip()
    if not filename or '/' in filename or '\\' in filename:
        return ''
    value = filename if course in {'', '.'} else f'{course}/{filename}'
    return normalized_relative(value)


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


def description_matches(catalogue, current_videos):
    """Match channel videos to a unique relative path from their description."""
    by_relative = {}
    for lecture in catalogue.get('lectures', []):
        key = normalized_relative(lecture.get('relativePath'))
        if key:
            by_relative.setdefault(key, []).append(lecture)

    matches = {}
    stats = {
        'videosWithPathMarkers': 0,
        'descriptionExactMatches': 0,
        'descriptionSuffixMatches': 0,
        'descriptionAmbiguous': 0,
        'descriptionUnmatched': 0,
    }
    relative_keys = tuple(by_relative)
    for video_id, video in current_videos.items():
        candidate = description_relative_path(video.get('description'))
        if not candidate:
            continue
        stats['videosWithPathMarkers'] += 1
        possible = by_relative.get(candidate, [])
        reason = 'description-exact'
        if not possible:
            matching_keys = [
                key for key in relative_keys
                if key.endswith('/' + candidate)
            ]
            possible = [lecture for key in matching_keys for lecture in by_relative[key]]
            reason = 'description-suffix'
        if len(possible) == 1:
            matches[video_id] = (possible[0], reason)
            stats[
                'descriptionExactMatches'
                if reason == 'description-exact'
                else 'descriptionSuffixMatches'
            ] += 1
        elif possible:
            stats['descriptionAmbiguous'] += 1
        else:
            stats['descriptionUnmatched'] += 1
    return matches, stats


def run(
    config_path,
    catalogue_path,
    state_path=None,
    channel_path=None,
    *,
    allow_description_only=False,
    apply=True,
    update_new_titles=True,
):
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    catalogue = json.loads(catalogue_path.read_text(encoding='utf-8-sig'))
    resolved_state = Path(state_path or config.get('youtubeUploadState', ''))
    resolved_channel = Path(channel_path or config.get('youtubeChannelCache', '.private/youtube-channel.json'))
    if not resolved_state.is_file() and not allow_description_only:
        raise FileNotFoundError('Set youtubeUploadState in .private/sources.json or pass --state.')
    if not resolved_channel.is_file():
        raise FileNotFoundError('Refresh the current YouTube channel before linking uploads.')
    state = (
        json.loads(resolved_state.read_text(encoding='utf-8-sig'))
        if resolved_state.is_file()
        else {'records': {}}
    )
    channel = json.loads(resolved_channel.read_text(encoding='utf-8-sig'))
    expected_channel = config.get('youtubeChannelId')
    if expected_channel and channel.get('channel_id') != expected_channel:
        raise RuntimeError('The channel cache belongs to a different YouTube channel.')
    current_videos = {
        video['video_id']: video
        for video in channel.get('videos', [])
        if VIDEO_ID.fullmatch(video.get('video_id', ''))
    }
    current_video_ids = set(current_videos)

    description_lookup, description_stats = description_matches(catalogue, current_videos)

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

    # State records use absolute paths and are the strongest possible match.
    state_by_lecture = {}
    roots = {source['name']: Path(source['path']) for source in config['sources']}
    for lecture in catalogue['lectures']:
        root = roots.get(lecture.get('source'))
        relative = lecture.get('relativePath')
        if root is None or not relative:
            continue
        record = uploaded.get(normalized(root / Path(relative)))
        if record is not None:
            state_by_lecture[lecture['id']] = record

    # Description markers are useful when CI cannot access the local state.
    # They are accepted only for a unique relative-path match.
    description_by_lecture = {}
    for video_id, (lecture, reason) in description_lookup.items():
        existing = description_by_lecture.get(lecture['id'])
        video = current_videos[video_id]
        if existing is None or parse_time(video.get('published_at')) > parse_time(existing[0].get('published_at')):
            description_by_lecture[lecture['id']] = (video, reason)

    matched = 0
    matched_from_state = 0
    matched_from_description = 0
    matched_from_existing_link = 0
    already_linked = 0
    manual_preserved = 0
    stale_links_marked_unavailable = 0
    new_links = 0
    titles_updated = 0
    visibility_updated = 0
    changed = 0
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    refreshed_at = channel.get('refreshed_at') or now
    for lecture in catalogue['lectures']:
        record = state_by_lecture.get(lecture['id'])
        match_reason = ''
        if record is not None:
            video_id = record['video_id']
            video = current_videos[video_id]
            match_reason = 'state'
            matched_from_state += 1
        elif lecture['id'] in description_by_lecture:
            video, match_reason = description_by_lecture[lecture['id']]
            video_id = video['video_id']
            record = {}
            matched_from_description += 1
        else:
            video_id = video_id_from_url(lecture.get('youtubeUrl'))
            video = current_videos.get(video_id)
            if video is not None:
                match_reason = 'existing-link'
                matched_from_existing_link += 1

        if match_reason:
            matched += 1
            url = f"https://www.youtube.com/watch?v={video_id}"
            privacy = video.get('privacy_status')
            if privacy not in {'private', 'unlisted', 'public'}:
                privacy = None
            manual_link = lecture.get('youtubeSource') == 'manual'
            if manual_link and lecture.get('youtubeUrl') != url:
                manual_preserved += 1
                continue
            url_changed = lecture.get('youtubeUrl') != url
            next_title = str(video.get('title') or '').strip()
            title_changed = bool(
                update_new_titles
                and next_title
                and lecture.get('youtubeTitle') != next_title
            )
            privacy_changed = lecture.get('youtubePrivacy') != privacy
            metadata_current = (
                lecture.get('youtubeStatus') == 'current'
                and not privacy_changed
                and 'youtubeUnavailableAt' not in lecture
            )
            if not url_changed and not title_changed and metadata_current:
                already_linked += 1
                continue
            lecture.update(
                youtubeUrl=url,
                youtubeSource='manual' if manual_link else 'uploader',
                youtubeStatus='current',
                youtubeUpdatedAt=refreshed_at,
            )
            if title_changed:
                lecture['youtubeTitle'] = next_title
                titles_updated += 1
            if privacy:
                lecture['youtubePrivacy'] = privacy
            else:
                lecture.pop('youtubePrivacy', None)
            lecture.pop('youtubeUnavailableAt', None)
            if url_changed:
                new_links += 1
            if privacy_changed:
                visibility_updated += 1
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
            )
            lecture.pop('youtubePrivacy', None)
            stale_links_marked_unavailable += 1
            changed += 1

    if changed and apply:
        catalogue['updatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        temporary = catalogue_path.with_suffix('.youtube.tmp')
        temporary.write_text(json.dumps(catalogue, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        temporary.replace(catalogue_path)
    summary = {
        'currentChannelUploads': len(current_video_ids),
        'currentUploadsInLocalState': state_current,
        'uniqueSourcePaths': len(uploaded),
        'exactCatalogueMatches': matched,
        'matchedFromUploaderState': matched_from_state,
        'matchedFromDescriptions': matched_from_description,
        'matchedFromExistingLinks': matched_from_existing_link,
        'newLinks': new_links,
        'titlesUpdated': titles_updated,
        'visibilityUpdated': visibility_updated,
        'catalogueChanges': changed,
        'alreadyLinked': already_linked,
        'manualLinksPreserved': manual_preserved,
        'staleUploaderLinksMarkedUnavailable': stale_links_marked_unavailable,
        'unmatchedCurrentStateRecords': len(uploaded) - matched_from_state,
        **description_stats,
        'applied': apply,
    }
    print(json.dumps(summary))
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--catalogue', default='.private/catalogue.json')
    parser.add_argument('--state')
    parser.add_argument('--channel-cache')
    parser.add_argument(
        '--description-only',
        action='store_true',
        help='Allow matching from uploader description paths without a local upload state.',
    )
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument(
        '--keep-local-titles',
        action='store_true',
        help='Do not copy YouTube titles when adding new links.',
    )
    args = parser.parse_args()
    run(
        Path(args.config),
        Path(args.catalogue),
        args.state,
        args.channel_cache,
        allow_description_only=args.description_only,
        apply=not args.dry_run,
        update_new_titles=not args.keep_local_titles,
    )
