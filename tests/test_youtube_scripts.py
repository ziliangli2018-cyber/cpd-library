import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    path = ROOT / 'scripts' / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RefreshYouTubeChannelTests(unittest.TestCase):
    def test_validates_playlist_ids_and_flags_deleted_placeholders(self):
        module = load_script('refresh-youtube-channel.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / 'token.json'
            token.write_text('{}', encoding='utf-8')
            config = root / 'sources.json'
            output = root / 'channel.json'
            config.write_text(json.dumps({
                'youtubeToken': str(token),
                'youtubeChannelId': 'CHANNEL',
            }), encoding='utf-8')

            def youtube_get(path, _token, **params):
                if path == 'channels':
                    return {'items': [{
                        'id': 'CHANNEL',
                        'contentDetails': {'relatedPlaylists': {'uploads': 'UPLOADS'}},
                    }]}
                if path == 'playlistItems':
                    return {'items': [
                        {
                            'contentDetails': {'videoId': 'AAAAAAAAAAA', 'videoPublishedAt': '2026-01-01T00:00:00Z'},
                            'snippet': {'title': 'Current lecture'},
                        },
                        {
                            'contentDetails': {'videoId': 'BBBBBBBBBBB', 'videoPublishedAt': '2026-01-02T00:00:00Z'},
                            'snippet': {'title': 'Deleted video'},
                        },
                        {
                            'contentDetails': {'videoId': 'AAAAAAAAAAA', 'videoPublishedAt': '2026-01-01T00:00:00Z'},
                            'snippet': {'title': 'Duplicate playlist row'},
                        },
                    ]}
                if path == 'videos':
                    self.assertEqual(params['id'], 'AAAAAAAAAAA,BBBBBBBBBBB')
                    return {'items': [{
                        'id': 'AAAAAAAAAAA',
                        'snippet': {'title': 'Current lecture', 'publishedAt': '2026-01-01T00:00:00Z'},
                        'status': {'privacyStatus': 'unlisted', 'uploadStatus': 'processed'},
                        'contentDetails': {'duration': 'PT10M'},
                    }]}
                self.fail(f'Unexpected endpoint: {path}')

            with mock.patch.object(module, 'access_token', return_value='access-token'), mock.patch.object(
                module, 'youtube_get', side_effect=youtube_get
            ), contextlib.redirect_stdout(io.StringIO()):
                module.run(config, output)

            result = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(result['playlist_item_count'], 2)
            self.assertEqual(result['count'], 1)
            self.assertEqual(result['unavailable_count'], 1)
            self.assertEqual(result['videos'][0]['video_id'], 'AAAAAAAAAAA')
            self.assertEqual(result['videos'][0]['privacy_status'], 'unlisted')
            self.assertEqual(result['videos'][0]['upload_status'], 'processed')
            self.assertEqual(result['unavailable'][0]['video_id'], 'BBBBBBBBBBB')
            self.assertEqual(result['unavailable'][0]['reason'], 'deleted_placeholder')


class LinkYouTubeUploadsTests(unittest.TestCase):
    def test_marks_only_stale_uploader_links_unavailable(self):
        module = load_script('link-youtube-uploads.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / 'media'
            media.mkdir()
            config = root / 'sources.json'
            catalogue = root / 'catalogue.json'
            state = root / 'state.json'
            channel = root / 'channel.json'
            config.write_text(json.dumps({
                'sources': [{'name': 'Source', 'path': str(media)}],
                'youtubeChannelId': 'CHANNEL',
            }), encoding='utf-8')
            catalogue.write_text(json.dumps({
                'schemaVersion': 1,
                'updatedAt': '2026-01-01T00:00:00Z',
                'lectures': [
                    {
                        'id': 'stale', 'source': 'Source', 'relativePath': 'stale.mp4',
                        'youtubeUrl': 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
                        'youtubeSource': 'uploader', 'updatedAt': '2026-01-01T00:00:00Z',
                    },
                    {
                        'id': 'manual', 'source': 'Source', 'relativePath': 'manual.mp4',
                        'youtubeUrl': 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
                        'youtubeSource': 'manual', 'updatedAt': '2026-01-01T00:00:00Z',
                    },
                    {
                        'id': 'replacement', 'source': 'Source', 'relativePath': 'replacement.mp4',
                        'youtubeUrl': 'https://www.youtube.com/watch?v=CCCCCCCCCCC',
                        'youtubeSource': 'uploader', 'youtubeStatus': 'unavailable',
                        'youtubeUnavailableAt': '2026-01-01T00:00:00Z',
                        'updatedAt': '2026-01-01T00:00:00Z',
                    },
                    {
                        'id': 'hydrated', 'source': 'Source', 'relativePath': 'hydrated.mp4',
                        'youtubeUrl': 'https://www.youtube.com/watch?v=GGGGGGGGGGG',
                        'youtubeSource': 'uploader', 'updatedAt': '2026-01-01T00:00:00Z',
                    },
                ],
            }), encoding='utf-8')
            state.write_text(json.dumps({'records': {
                'manual': {
                    'status': 'uploaded',
                    'source_path': str(media / 'manual.mp4'),
                    'video_id': 'EEEEEEEEEEE',
                    'updated_at': '2026-02-01T00:00:00Z',
                },
                'replacement-older': {
                    'status': 'uploaded',
                    'source_path': str(media / 'replacement.mp4'),
                    'video_id': 'FFFFFFFFFFF',
                    'updated_at': '2026-01-15T00:00:00Z',
                },
                'replacement': {
                    'status': 'uploaded',
                    'source_path': str(media / 'replacement.mp4'),
                    'video_id': 'DDDDDDDDDDD',
                    'updated_at': '2026-02-01T00:00:00Z',
                },
                'hydrated': {
                    'status': 'uploaded',
                    'source_path': str(media / 'hydrated.mp4'),
                    'video_id': 'GGGGGGGGGGG',
                    'updated_at': '2026-02-01T00:00:00Z',
                },
            }}), encoding='utf-8')
            channel.write_text(json.dumps({
                'channel_id': 'CHANNEL',
                'videos': [
                    {'video_id': 'DDDDDDDDDDD', 'privacy_status': 'unlisted'},
                    {'video_id': 'EEEEEEEEEEE', 'privacy_status': 'private'},
                    {'video_id': 'FFFFFFFFFFF', 'privacy_status': 'public'},
                    {'video_id': 'GGGGGGGGGGG', 'privacy_status': 'unlisted'},
                ],
            }), encoding='utf-8')

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                module.run(config, catalogue, str(state), str(channel))

            result = json.loads(catalogue.read_text(encoding='utf-8'))
            lectures = {lecture['id']: lecture for lecture in result['lectures']}
            self.assertEqual(lectures['stale']['youtubeUrl'], '')
            self.assertEqual(
                lectures['stale']['youtubePreviousUrl'],
                'https://www.youtube.com/watch?v=AAAAAAAAAAA',
            )
            self.assertEqual(lectures['stale']['youtubeStatus'], 'unavailable')
            self.assertIn('youtubeUnavailableAt', lectures['stale'])
            self.assertEqual(
                lectures['manual']['youtubeUrl'],
                'https://www.youtube.com/watch?v=BBBBBBBBBBB',
            )
            self.assertNotIn('youtubeStatus', lectures['manual'])
            self.assertEqual(
                lectures['replacement']['youtubeUrl'],
                'https://www.youtube.com/watch?v=DDDDDDDDDDD',
            )
            self.assertEqual(lectures['replacement']['youtubeStatus'], 'current')
            self.assertEqual(lectures['replacement']['youtubePrivacy'], 'unlisted')
            self.assertNotIn('youtubeUnavailableAt', lectures['replacement'])
            self.assertEqual(lectures['hydrated']['youtubeStatus'], 'current')
            self.assertEqual(lectures['hydrated']['youtubePrivacy'], 'unlisted')
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary['staleUploaderLinksMarkedUnavailable'], 1)
            self.assertEqual(summary['manualLinksPreserved'], 1)
            self.assertEqual(summary['newLinks'], 1)
            self.assertEqual(summary['catalogueChanges'], 3)


if __name__ == '__main__':
    unittest.main()
