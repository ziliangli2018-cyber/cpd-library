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
                        'snippet': {
                            'title': 'Current lecture',
                            'description': 'Course: Course A\nOriginal file: lecture.mp4',
                            'publishedAt': '2026-01-01T00:00:00Z',
                        },
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
            self.assertEqual(
                result['videos'][0]['description'],
                'Course: Course A\nOriginal file: lecture.mp4',
            )
            self.assertEqual(result['videos'][0]['privacy_status'], 'unlisted')
            self.assertEqual(result['videos'][0]['upload_status'], 'processed')
            self.assertEqual(result['unavailable'][0]['video_id'], 'BBBBBBBBBBB')
            self.assertEqual(result['unavailable'][0]['reason'], 'deleted_placeholder')


class LinkYouTubeUploadsTests(unittest.TestCase):
    def test_description_path_match_adds_link_title_and_visibility_without_state(self):
        module = load_script('link-youtube-uploads.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / 'media'
            media.mkdir()
            config = root / 'sources.json'
            catalogue = root / 'catalogue.json'
            channel = root / 'channel.json'
            config.write_text(json.dumps({
                'sources': [{'name': 'Source', 'path': str(media)}],
                'youtubeChannelId': 'CHANNEL',
            }), encoding='utf-8')
            original = {
                'schemaVersion': 1,
                'updatedAt': '2026-01-01T00:00:00Z',
                'lectures': [{
                    'id': 'lecture',
                    'title': 'Local filename title',
                    'source': 'Source',
                    'relativePath': 'Orthodontics/Course A/01 lesson.mp4',
                    'youtubeUrl': '',
                    'updatedAt': '2026-01-01T00:00:00Z',
                }],
            }
            catalogue.write_text(json.dumps(original), encoding='utf-8')
            channel.write_text(json.dumps({
                'channel_id': 'CHANNEL',
                'refreshed_at': '2026-02-01T00:00:00Z',
                'videos': [{
                    'video_id': 'AAAAAAAAAAA',
                    'title': 'YouTube lecture title',
                    'description': (
                        'Uploaded from local CPD archive.\n\n'
                        'Course: Course A\nOriginal file: 01 lesson.mp4'
                    ),
                    'privacy_status': 'unlisted',
                    'published_at': '2026-01-15T00:00:00Z',
                }],
            }), encoding='utf-8')

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                module.run(
                    config,
                    catalogue,
                    str(root / 'missing-state.json'),
                    str(channel),
                    allow_description_only=True,
                )

            result = json.loads(catalogue.read_text(encoding='utf-8'))
            lecture = result['lectures'][0]
            self.assertEqual(lecture['youtubeUrl'], 'https://www.youtube.com/watch?v=AAAAAAAAAAA')
            self.assertEqual(lecture['youtubePrivacy'], 'unlisted')
            self.assertEqual(lecture['youtubeStatus'], 'current')
            self.assertEqual(lecture['youtubeUpdatedAt'], '2026-02-01T00:00:00Z')
            self.assertEqual(lecture['title'], 'Local filename title')
            self.assertEqual(lecture['youtubeTitle'], 'YouTube lecture title')
            # YouTube-only metadata must not impersonate a human edit.
            self.assertEqual(lecture['updatedAt'], '2026-01-01T00:00:00Z')
            summary = json.loads(stdout.getvalue())
            self.assertEqual(summary['videosWithPathMarkers'], 1)
            self.assertEqual(summary['descriptionSuffixMatches'], 1)
            self.assertEqual(summary['matchedFromDescriptions'], 1)
            self.assertEqual(summary['newLinks'], 1)
            self.assertEqual(summary['titlesUpdated'], 1)
            self.assertEqual(summary['visibilityUpdated'], 1)

    def test_description_match_is_rejected_when_relative_suffix_is_ambiguous(self):
        module = load_script('link-youtube-uploads.py')
        catalogue = {
            'lectures': [
                {'id': 'one', 'relativePath': 'Root A/Course/lesson.mp4'},
                {'id': 'two', 'relativePath': 'Root B/Course/lesson.mp4'},
            ],
        }
        videos = {
            'AAAAAAAAAAA': {
                'description': 'Course: Course\nOriginal file: lesson.mp4',
            },
        }
        matches, stats = module.description_matches(catalogue, videos)
        self.assertEqual(matches, {})
        self.assertEqual(stats['descriptionAmbiguous'], 1)

    def test_description_path_parser_accepts_youtube_flattened_markers(self):
        module = load_script('link-youtube-uploads.py')
        self.assertEqual(
            module.description_relative_path(
                'Uploaded from local CPD archive. Course: Course A / Module 2 '
                'Original file: 03 Lesson.mp4'
            ),
            'course a/module 2/03 lesson.mp4',
        )

    def test_dry_run_reports_changes_without_writing_catalogue(self):
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
            original = {
                'schemaVersion': 1,
                'updatedAt': '2026-01-01T00:00:00Z',
                'lectures': [{
                    'id': 'lecture', 'title': 'Lecture', 'source': 'Source',
                    'relativePath': 'lecture.mp4', 'youtubeUrl': '',
                    'updatedAt': '2026-01-01T00:00:00Z',
                }],
            }
            catalogue.write_text(json.dumps(original), encoding='utf-8')
            state.write_text(json.dumps({'records': {'lecture': {
                'status': 'uploaded', 'source_path': str(media / 'lecture.mp4'),
                'video_id': 'AAAAAAAAAAA', 'updated_at': '2026-02-01T00:00:00Z',
            }}}), encoding='utf-8')
            channel.write_text(json.dumps({
                'channel_id': 'CHANNEL',
                'videos': [{
                    'video_id': 'AAAAAAAAAAA', 'title': 'Remote title',
                    'privacy_status': 'private',
                }],
            }), encoding='utf-8')

            with contextlib.redirect_stdout(io.StringIO()):
                summary = module.run(
                    config, catalogue, str(state), str(channel), apply=False,
                )

            self.assertEqual(json.loads(catalogue.read_text(encoding='utf-8')), original)
            self.assertFalse(summary['applied'])
            self.assertEqual(summary['newLinks'], 1)

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


class BuildYouTubePatchTests(unittest.TestCase):
    def test_emits_only_youtube_fields_and_keeps_human_timestamp_out(self):
        module = load_script('build-youtube-patch.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / 'media'
            config = {
                'sources': [{'name': 'Source', 'path': str(media)}],
                'youtubeChannelId': 'CHANNEL',
            }
            catalogue = {
                'schemaVersion': 1,
                'updatedAt': '2026-01-01T00:00:00Z',
                'lectures': [{
                    'id': 'lecture',
                    'title': 'Human title',
                    'notes': 'Private notes',
                    'source': 'Source',
                    'relativePath': 'Course/lecture.mp4',
                    'youtubeUrl': '',
                    'updatedAt': '2026-01-01T00:00:00Z',
                }],
            }
            state = {'records': {'lecture': {
                'status': 'uploaded',
                'source_path': str(media / 'Course' / 'lecture.mp4'),
                'video_id': 'AAAAAAAAAAA',
                'updated_at': '2026-01-15T00:00:00Z',
            }}}
            channel = {
                'channel_id': 'CHANNEL',
                'refreshed_at': '2026-02-01T00:00:00Z',
                'videos': [{
                    'video_id': 'AAAAAAAAAAA',
                    'title': 'Current YouTube title',
                    'privacy_status': 'unlisted',
                }],
            }

            result = module.build_patch(config, catalogue, state, channel)

            self.assertEqual([update['id'] for update in result['updates']], ['lecture'])
            update = result['updates'][0]
            self.assertEqual(update['youtubeTitle'], 'Current YouTube title')
            self.assertEqual(update['youtubePrivacy'], 'unlisted')
            self.assertEqual(update['youtubeStatus'], 'current')
            self.assertEqual(
                update['youtubeUrl'],
                'https://www.youtube.com/watch?v=AAAAAAAAAAA',
            )
            self.assertEqual(
                update['youtubeUpdatedAt'],
                '2026-02-01T00:00:00Z',
            )
            self.assertIsNone(update['youtubeUnavailableAt'])
            self.assertIsNone(update['youtubePreviousUrl'])
            self.assertNotIn('title', update)
            self.assertNotIn('notes', update)
            self.assertNotIn('updatedAt', update)
            self.assertEqual(
                set(update),
                {
                    'id',
                    'youtubeUrl', 'youtubeTitle', 'youtubeSource',
                    'youtubeStatus', 'youtubePrivacy', 'youtubeUpdatedAt',
                    'youtubeUnavailableAt', 'youtubePreviousUrl',
                },
            )

    def test_marks_only_uploader_links_unavailable(self):
        module = load_script('build-youtube-patch.py')
        catalogue = {
            'lectures': [
                {
                    'id': 'uploader',
                    'source': 'Source',
                    'relativePath': 'gone.mp4',
                    'youtubeUrl': 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
                    'youtubeSource': 'uploader',
                    'youtubePrivacy': 'private',
                },
                {
                    'id': 'manual',
                    'source': 'Source',
                    'relativePath': 'manual.mp4',
                    'youtubeUrl': 'https://www.youtube.com/watch?v=BBBBBBBBBBB',
                    'youtubeSource': 'manual',
                    'youtubePrivacy': 'unlisted',
                },
            ],
        }
        channel = {
            'channel_id': 'CHANNEL',
            'refreshed_at': '2026-02-01T00:00:00Z',
            'videos': [],
        }

        result = module.build_patch(
            {'sources': []}, catalogue, {'records': {}}, channel,
        )

        self.assertEqual([update['id'] for update in result['updates']], ['uploader'])
        update = result['updates'][0]
        self.assertEqual(update['youtubeStatus'], 'unavailable')
        self.assertEqual(update['youtubeUrl'], '')
        self.assertIsNone(update['youtubePrivacy'])
        self.assertEqual(result['summary']['markedUnavailable'], 1)

    def test_path_description_matching_is_opt_in(self):
        module = load_script('build-youtube-patch.py')
        catalogue = {'lectures': [{
            'id': 'lecture', 'source': 'Source',
            'relativePath': 'Archive/Course/lecture.mp4', 'youtubeUrl': '',
        }]}
        channel = {
            'channel_id': 'CHANNEL',
            'refreshed_at': '2026-02-01T00:00:00Z',
            'videos': [{
                'video_id': 'AAAAAAAAAAA',
                'title': 'Lecture',
                'description': 'Course: Course\nOriginal file: lecture.mp4',
                'privacy_status': 'unlisted',
            }],
        }

        default = module.build_patch(
            {'sources': []}, catalogue, {'records': {}}, channel,
        )
        enabled = module.build_patch(
            {'sources': []}, catalogue, {'records': {}}, channel,
            allow_description_matches=True,
        )

        self.assertEqual(default['updates'], [])
        self.assertEqual(default['summary']['videosWithPathMarkers'], 1)
        self.assertEqual([update['id'] for update in enabled['updates']], ['lecture'])
        self.assertEqual(enabled['summary']['descriptionMatchesUsed'], 1)


if __name__ == '__main__':
    unittest.main()
