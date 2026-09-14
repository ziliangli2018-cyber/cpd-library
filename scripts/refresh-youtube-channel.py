"""Cache IDs currently present on the configured YouTube channel.

OAuth credentials are read locally, sent only to Google's OAuth/API hosts, and
never printed or copied into the catalogue or repository.
"""
import argparse
import datetime as dt
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def request_json(url, token=None, data=None):
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    body = urllib.parse.urlencode(data).encode() if data else None
    request = urllib.request.Request(url, data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get('error', {})
            detail = detail.get('message') if isinstance(detail, dict) else str(detail)
        except Exception:
            detail = None
        raise RuntimeError(f'YouTube API request failed ({error.code})' + (f': {detail}' if detail else '.')) from None


def access_token(token_path):
    credentials = json.loads(token_path.read_text(encoding='utf-8-sig'))
    required = ['client_id', 'client_secret', 'refresh_token']
    if any(not credentials.get(key) for key in required):
        raise RuntimeError('The existing YouTube credentials cannot refresh access. Re-authorise the uploader first.')
    refreshed = request_json(
        credentials.get('token_uri', 'https://oauth2.googleapis.com/token'),
        data={
            'client_id': credentials['client_id'],
            'client_secret': credentials['client_secret'],
            'refresh_token': credentials['refresh_token'],
            'grant_type': 'refresh_token',
        },
    )
    if not refreshed.get('access_token'):
        raise RuntimeError('Google did not return a refreshed YouTube access token.')
    return refreshed['access_token']


def youtube_get(path, token, **params):
    query = urllib.parse.urlencode(params)
    return request_json(f'https://www.googleapis.com/youtube/v3/{path}?{query}', token=token)


def chunks(values, size=50):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def run(config_path, output_path):
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    token_path = Path(config.get('youtubeToken', ''))
    expected_channel = config.get('youtubeChannelId', '')
    if not token_path.is_file() or not expected_channel:
        raise RuntimeError('Set youtubeToken and youtubeChannelId in .private/sources.json.')
    token = access_token(token_path)
    channels = youtube_get('channels', token, part='id,contentDetails', mine='true', maxResults=50).get('items', [])
    channel = next((item for item in channels if item.get('id') == expected_channel), None)
    if channel is None:
        returned = ', '.join(item.get('id', '') for item in channels) or 'none'
        raise RuntimeError(f'The authorised YouTube account did not return the configured channel. Returned: {returned}')
    uploads_id = channel['contentDetails']['relatedPlaylists']['uploads']
    playlist_items = {}
    page_token = None
    while True:
        params = {'part': 'contentDetails,snippet', 'playlistId': uploads_id, 'maxResults': 50}
        if page_token:
            params['pageToken'] = page_token
        page = youtube_get('playlistItems', token, **params)
        for item in page.get('items', []):
            video_id = item.get('contentDetails', {}).get('videoId')
            if video_id and video_id not in playlist_items:
                playlist_items[video_id] = {
                    'video_id': video_id,
                    'title': item.get('snippet', {}).get('title', ''),
                    'published_at': item.get('contentDetails', {}).get('videoPublishedAt'),
                }
        page_token = page.get('nextPageToken')
        if not page_token:
            break

    current = {}
    video_ids = list(playlist_items)
    for group in chunks(video_ids):
        response = youtube_get(
            'videos',
            token,
            part='snippet,status,contentDetails',
            id=','.join(group),
            maxResults=50,
        )
        for item in response.get('items', []):
            video_id = item.get('id', '')
            if video_id not in playlist_items:
                continue
            snippet = item.get('snippet', {})
            status = item.get('status', {})
            details = item.get('contentDetails', {})
            current[video_id] = {
                'video_id': video_id,
                'title': snippet.get('title', playlist_items[video_id]['title']),
                # Uploads made by the local scheduler include exact Course and
                # Original file markers here. Keep the description in this
                # private cache so a sync can recover path-based matches even
                # when the uploader state is unavailable (for example, in CI).
                'description': snippet.get('description', ''),
                'published_at': snippet.get('publishedAt') or playlist_items[video_id]['published_at'],
                'privacy_status': status.get('privacyStatus'),
                'upload_status': status.get('uploadStatus'),
                'duration': details.get('duration'),
            }

    unavailable = []
    for video_id, item in playlist_items.items():
        if video_id in current:
            continue
        title = item.get('title', '')
        if title == 'Deleted video':
            reason = 'deleted_placeholder'
        elif title == 'Private video':
            reason = 'private_placeholder'
        else:
            reason = 'not_returned_by_videos_list'
        unavailable.append({**item, 'reason': reason})

    videos = [current[video_id] for video_id in video_ids if video_id in current]
    result = {
        'channel_id': expected_channel,
        'upload_playlist_id': uploads_id,
        'refreshed_at': dt.datetime.now(dt.timezone.utc).isoformat(),
        'playlist_item_count': len(playlist_items),
        'count': len(videos),
        'unavailable_count': len(unavailable),
        'videos': videos,
        'unavailable': unavailable,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(output_path)
    print(json.dumps({
        'channel': expected_channel,
        'currentUploads': len(videos),
        'unavailableUploads': len(unavailable),
        'uploadPlaylistItems': len(playlist_items),
    }))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--output', default='.private/youtube-channel.json')
    args = parser.parse_args()
    run(Path(args.config), Path(args.output))
