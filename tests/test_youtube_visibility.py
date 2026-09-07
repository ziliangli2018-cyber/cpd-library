import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load_script():
    path = ROOT / 'scripts' / 'set-youtube-unlisted.py'
    spec = importlib.util.spec_from_file_location('set_youtube_unlisted', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def video_id(number):
    return f'V{number:010d}'


class YouTubeVisibilityTests(unittest.TestCase):
    def files(self, root, urls):
        token = root / 'token.json'
        token.write_text('{}', encoding='utf-8')
        config = root / 'sources.json'
        config.write_text(json.dumps({
            'youtubeToken': str(token),
            'youtubeChannelId': 'CHANNEL',
        }), encoding='utf-8')
        catalogue = root / 'catalogue.json'
        catalogue.write_text(json.dumps({
            'lectures': [
                {'id': str(index), 'youtubeUrl': url}
                for index, url in enumerate(urls)
            ],
        }), encoding='utf-8')
        return config, catalogue, root / 'report.json'

    def test_dry_run_batches_live_status_and_selects_only_safe_owned_private_videos(self):
        module = load_script()
        ids = [video_id(index) for index in range(53)]
        urls = [f'https://www.youtube.com/watch?v={item}' for item in ids]
        urls.extend([urls[0], 'https://example.com/not-youtube'])
        batch_sizes = []

        def youtube_get(path, _token, **params):
            if path == 'channels':
                return {'items': [{'id': 'CHANNEL'}]}
            self.assertEqual(path, 'videos')
            requested = params['id'].split(',')
            batch_sizes.append(len(requested))
            items = []
            for item in requested:
                index = ids.index(item)
                channel = 'OTHER' if index == 5 else 'CHANNEL'
                status = {
                    'privacyStatus': 'private',
                    'uploadStatus': 'processed',
                    'license': 'youtube',
                    'embeddable': True,
                    'publicStatsViewable': False,
                    'selfDeclaredMadeForKids': False,
                }
                if index == 1:
                    status['privacyStatus'] = 'unlisted'
                elif index == 2:
                    status['privacyStatus'] = 'public'
                elif index == 3:
                    status['publishAt'] = '2026-10-01T00:00:00Z'
                elif index == 4:
                    status['futureStatusField'] = True
                items.append({'id': item, 'snippet': {'channelId': channel}, 'status': status})
            return {'items': items}

        with tempfile.TemporaryDirectory() as directory:
            config, catalogue, report = self.files(Path(directory), urls)
            stdout = io.StringIO()
            with mock.patch.object(module, 'access_token', return_value='secret-token'), mock.patch.object(
                module, 'youtube_get', side_effect=youtube_get
            ), mock.patch.object(module, 'youtube_update') as update, contextlib.redirect_stdout(stdout):
                summary = module.run(config, catalogue, report, max_updates=10)

            update.assert_not_called()
            self.assertEqual(batch_sizes, [50, 3])
            self.assertEqual(summary['mode'], 'dry-run')
            self.assertEqual(summary['catalogueLinks'], 55)
            self.assertEqual(summary['uniqueValidLinkedVideos'], 53)
            self.assertEqual(summary['duplicateCatalogueLinks'], 1)
            self.assertEqual(summary['invalidYouTubeLinks'], 1)
            self.assertEqual(summary['ownedPrivateEligible'], 48)
            self.assertEqual(summary['ownedPrivateBlocked'], 2)
            self.assertEqual(summary['ownedAlreadyUnlisted'], 1)
            self.assertEqual(summary['ownedAlreadyPublic'], 1)
            self.assertEqual(summary['foreignChannelVideos'], 1)
            self.assertEqual(summary['plannedThisRun'], 10)
            saved = json.loads(report.read_text(encoding='utf-8'))
            self.assertEqual(len(saved['plan']), 10)
            self.assertEqual(
                {item['reason'] for item in saved['blocked']},
                {'scheduled publication', 'unknown status fields: futureStatusField'},
            )

    def test_apply_requires_exact_live_batch_count_before_any_update(self):
        module = load_script()
        ids = [video_id(1), video_id(2)]

        def youtube_get(path, _token, **params):
            if path == 'channels':
                return {'items': [{'id': 'CHANNEL'}]}
            return {'items': [
                {
                    'id': item,
                    'snippet': {'channelId': 'CHANNEL'},
                    'status': {'privacyStatus': 'private'},
                }
                for item in params['id'].split(',')
            ]}

        with tempfile.TemporaryDirectory() as directory:
            urls = [f'https://youtu.be/{item}' for item in ids]
            config, catalogue, report = self.files(Path(directory), urls)
            with mock.patch.object(module, 'access_token', return_value='token'), mock.patch.object(
                module, 'youtube_get', side_effect=youtube_get
            ), mock.patch.object(module, 'youtube_update') as update:
                with self.assertRaisesRegex(RuntimeError, r'live planned batch size \(1\)'):
                    module.run(
                        config,
                        catalogue,
                        report,
                        apply=True,
                        confirm_count=2,
                        max_updates=1,
                    )
            update.assert_not_called()

    def test_apply_preserves_mutable_status_and_records_partial_progress_without_token(self):
        module = load_script()
        ids = [video_id(10), video_id(11)]
        current_status = {
            'privacyStatus': 'private',
            'uploadStatus': 'processed',
            'madeForKids': False,
            'license': 'creativeCommon',
            'embeddable': False,
            'publicStatsViewable': False,
            'selfDeclaredMadeForKids': False,
            'containsSyntheticMedia': True,
        }

        def youtube_get(path, _token, **params):
            if path == 'channels':
                return {'items': [{'id': 'CHANNEL'}]}
            return {'items': [
                {'id': item, 'snippet': {'channelId': 'CHANNEL'}, 'status': current_status}
                for item in params['id'].split(',')
            ]}

        calls = []
        secret = 'do-not-write-this-token'

        def youtube_update(item, status, _token):
            calls.append((item, status))
            if item == ids[1]:
                raise module.YouTubeRequestError(f'update denied {secret}')
            return {'id': item, 'status': {'privacyStatus': 'unlisted'}}

        with tempfile.TemporaryDirectory() as directory:
            urls = [f'https://www.youtube.com/embed/{item}' for item in ids]
            config, catalogue, report = self.files(Path(directory), urls)
            stdout = io.StringIO()
            with mock.patch.object(module, 'access_token', return_value=secret), mock.patch.object(
                module, 'youtube_get', side_effect=youtube_get
            ), mock.patch.object(module, 'youtube_update', side_effect=youtube_update), contextlib.redirect_stdout(stdout):
                summary = module.run(
                    config,
                    catalogue,
                    report,
                    apply=True,
                    confirm_count=2,
                    max_updates=2,
                )

            self.assertEqual(summary['attempted'], 2)
            self.assertEqual(summary['succeeded'], 1)
            self.assertEqual(summary['failed'], 1)
            expected_status = {
                'license': 'creativeCommon',
                'embeddable': False,
                'publicStatsViewable': False,
                'selfDeclaredMadeForKids': False,
                'containsSyntheticMedia': True,
                'privacyStatus': 'unlisted',
            }
            self.assertEqual(calls[0], (ids[0], expected_status))
            saved_text = report.read_text(encoding='utf-8')
            self.assertNotIn(secret, saved_text)
            saved = json.loads(saved_text)
            self.assertEqual(saved['successes'], [ids[0]])
            self.assertEqual(saved['failures'][0]['video_id'], ids[1])

    def test_channel_mismatch_stops_before_video_lookup(self):
        module = load_script()
        with tempfile.TemporaryDirectory() as directory:
            config, catalogue, report = self.files(
                Path(directory),
                [f'https://www.youtube.com/watch?v={video_id(1)}'],
            )
            with mock.patch.object(module, 'access_token', return_value='token'), mock.patch.object(
                module, 'youtube_get', return_value={'items': [{'id': 'WRONG'}]}
            ) as get:
                with self.assertRaisesRegex(RuntimeError, 'did not return the configured channel'):
                    module.run(config, catalogue, report)
            self.assertEqual(get.call_count, 1)
            self.assertFalse(report.exists())


if __name__ == '__main__':
    unittest.main()
