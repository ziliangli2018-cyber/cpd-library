import hashlib
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'import-catalogue.py'
SPEC = importlib.util.spec_from_file_location('import_catalogue', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ImportCatalogueProgressTests(unittest.TestCase):
    def test_rescan_preserves_progress_and_new_lectures_get_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            existing_path = root / 'Course' / 'Module' / 'Watched.mp4'
            new_path = root / 'Course' / 'Module' / 'New.mp4'
            existing_path.parent.mkdir(parents=True)
            existing_path.write_bytes(b'existing video metadata placeholder')
            new_path.write_bytes(b'new video metadata placeholder')
            old_mtime = time.time() - 600
            os.utime(existing_path, (old_mtime, old_mtime))
            os.utime(new_path, (old_mtime, old_mtime))

            source_name = 'Test source'
            relative_path = existing_path.relative_to(root).as_posix()
            record_id = hashlib.sha256(
                f'{source_name}:{relative_path.casefold()}'.encode()
            ).hexdigest()[:24]
            output = Path(directory) / 'catalogue.json'
            output.write_text(
                json.dumps(
                    {
                        'schemaVersion': 1,
                        'updatedAt': '2026-09-09T00:00:00Z',
                        'lectures': [
                            {
                                'id': record_id,
                                'title': 'Watched',
                                'course': 'Course',
                                'courseKey': 'legacy-course',
                                'module': 'Module',
                                'discipline': 'General dentistry',
                                'tags': [],
                                'youtubeUrl': 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
                                'notes': 'Keep this private note',
                                'progressStatus': 'seen',
                                'watchHistory': ['2026-09-09T01:00:00.000Z'],
                                'progressUpdatedAt': '2026-09-09T01:00:00.000Z',
                                'source': source_name,
                                'relativePath': relative_path,
                                'duration': None,
                                'bytes': 1,
                                'importedAt': '2026-09-09T00:00:00Z',
                                'updatedAt': '2026-09-09T01:00:00Z',
                                'classificationReviewed': False,
                                'availability': 'Source file found',
                            }
                        ],
                    }
                ),
                encoding='utf-8',
            )

            MODULE.run(
                {
                    'sources': [
                        {
                            'name': source_name,
                            'path': str(root),
                            'hierarchy': {
                                'rules': [
                                    {
                                        'courseIndex': 0,
                                        'moduleStartIndex': 1,
                                        'disciplineIndex': 0,
                                        'disciplineMap': {
                                            'Course': 'Orthodontics'
                                        },
                                    }
                                ]
                            },
                        }
                    ]
                },
                output,
            )
            records = {
                record['title']: record
                for record in json.loads(output.read_text(encoding='utf-8'))[
                    'lectures'
                ]
            }
            self.assertEqual(records['Watched']['progressStatus'], 'seen')
            self.assertEqual(
                records['Watched']['watchHistory'],
                ['2026-09-09T01:00:00.000Z'],
            )
            self.assertEqual(records['New']['progressStatus'], 'unseen')
            self.assertEqual(records['New']['watchHistory'], [])
            self.assertEqual(records['Watched']['notes'], 'Keep this private note')
            self.assertEqual(
                records['Watched']['youtubeUrl'],
                'https://www.youtube.com/watch?v=AAAAAAAAAAA',
            )
            self.assertEqual(
                records['Watched']['updatedAt'], '2026-09-09T01:00:00Z'
            )
            self.assertEqual(records['Watched']['discipline'], 'Orthodontics')
            self.assertEqual(records['Watched']['taxonomySource'], 'folder')
            self.assertNotEqual(records['Watched']['courseKey'], 'legacy-course')

    def test_folder_rules_keep_courses_intact_and_ignore_lesson_keywords(self):
        with tempfile.TemporaryDirectory() as directory:
            dent_root = Path(directory) / 'dent'
            move = dent_root / '075. Move Teeth or Restore' / 'Module 1'
            move.mkdir(parents=True)
            for name in ('Endodontics.mp4', 'Implant surgery.mp4'):
                path = move / name
                path.write_bytes(b'video metadata placeholder')
                old_mtime = time.time() - 600
                os.utime(path, (old_mtime, old_mtime))

            ripe_root = Path(directory) / 'one-drive'
            mini = (
                ripe_root
                / 'Ripe Global Videos'
                / 'Aligner & Orthodontics'
                / 'Introduction to Mini Screw Implants'
            )
            mini.mkdir(parents=True)
            for name in ('Mini Screw.ts', 'Endodontic risk.ts', 'Anatomy.ts'):
                path = mini / name
                path.write_bytes(b'video metadata placeholder')
                old_mtime = time.time() - 600
                os.utime(path, (old_mtime, old_mtime))

            output = Path(directory) / 'catalogue.json'
            MODULE.run(
                {
                    'sources': [
                        {
                            'name': 'Dent-S',
                            'path': str(dent_root),
                            'hierarchy': {
                                'rules': [
                                    {
                                        'courseIndex': 0,
                                        'moduleStartIndex': 1,
                                        'disciplineIndex': 0,
                                        'disciplinePrefixMap': {
                                            '075': 'Orthodontics'
                                        },
                                    }
                                ]
                            },
                        },
                        {
                            'name': 'OneDrive CPD',
                            'path': str(ripe_root),
                            'hierarchy': {
                                'rules': [
                                    {
                                        'pathPrefix': 'Ripe Global Videos',
                                        'courseIndex': 2,
                                        'courseFallbackIndex': 1,
                                        'moduleStartIndex': 3,
                                        'disciplineIndex': 1,
                                        'disciplineMap': {
                                            'Aligner & Orthodontics': 'Orthodontics'
                                        },
                                    }
                                ]
                            },
                        },
                    ]
                },
                output,
            )
            records = json.loads(output.read_text(encoding='utf-8'))['lectures']
            move_records = [record for record in records if record['source'] == 'Dent-S']
            mini_records = [
                record for record in records if record['source'] == 'OneDrive CPD'
            ]
            self.assertEqual({record['discipline'] for record in move_records}, {'Orthodontics'})
            self.assertEqual(len({record['courseKey'] for record in move_records}), 1)
            self.assertEqual({record['course'] for record in move_records}, {'Move Teeth or Restore'})
            self.assertEqual({record['discipline'] for record in mini_records}, {'Orthodontics'})
            self.assertEqual(len({record['courseKey'] for record in mini_records}), 1)
            self.assertEqual(
                {record['course'] for record in mini_records},
                {'Introduction to Mini Screw Implants'},
            )
            self.assertEqual({record['module'] for record in mini_records}, {''})

    def test_reviewed_taxonomy_survives_rescan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            video = root / 'Course' / 'Module' / 'Lecture.mp4'
            video.parent.mkdir(parents=True)
            video.write_bytes(b'video metadata placeholder')
            old_mtime = time.time() - 600
            os.utime(video, (old_mtime, old_mtime))
            source_name = 'Test source'
            relative_path = video.relative_to(root).as_posix()
            record_id = hashlib.sha256(
                f'{source_name}:{relative_path.casefold()}'.encode()
            ).hexdigest()[:24]
            output = Path(directory) / 'catalogue.json'
            output.write_text(
                json.dumps(
                    {
                        'schemaVersion': 1,
                        'updatedAt': '2026-09-09T00:00:00Z',
                        'lectures': [
                            {
                                'id': record_id,
                                'title': 'Lecture',
                                'course': 'Manually corrected course',
                                'courseKey': 'manual-course-key',
                                'module': 'Manual module',
                                'discipline': 'Endodontics',
                                'tags': [],
                                'youtubeUrl': '',
                                'notes': '',
                                'progressStatus': 'unseen',
                                'watchHistory': [],
                                'source': source_name,
                                'relativePath': relative_path,
                                'duration': None,
                                'bytes': 1,
                                'importedAt': '2026-09-09T00:00:00Z',
                                'updatedAt': '2026-09-09T01:00:00Z',
                                'classificationReviewed': True,
                                'taxonomySource': 'manual',
                                'taxonomyUpdatedAt': '2026-09-09T01:00:00Z',
                                'availability': 'Source file found',
                            }
                        ],
                    }
                ),
                encoding='utf-8',
            )
            MODULE.run(
                {
                    'sources': [
                        {
                            'name': source_name,
                            'path': str(root),
                            'hierarchy': {
                                'rules': [
                                    {
                                        'courseIndex': 0,
                                        'moduleStartIndex': 1,
                                        'disciplineIndex': 0,
                                        'disciplineMap': {'Course': 'Orthodontics'},
                                    }
                                ]
                            },
                        }
                    ]
                },
                output,
            )
            record = json.loads(output.read_text(encoding='utf-8'))['lectures'][0]
            self.assertEqual(record['course'], 'Manually corrected course')
            self.assertEqual(record['courseKey'], 'manual-course-key')
            self.assertEqual(record['module'], 'Manual module')
            self.assertEqual(record['discipline'], 'Endodontics')
            self.assertEqual(record['updatedAt'], '2026-09-09T01:00:00Z')

    def test_unmapped_folder_uses_needs_classification_for_the_whole_course(self):
        taxonomy_a = MODULE.derive_taxonomy(
            {'name': 'Source', 'hierarchy': {'rules': [{}]}},
            ('Unknown course', 'Module A', 'Endodontics.mp4'),
        )
        taxonomy_b = MODULE.derive_taxonomy(
            {'name': 'Source', 'hierarchy': {'rules': [{}]}},
            ('Unknown course', 'Module B', 'Implants.mp4'),
        )
        self.assertEqual(taxonomy_a['discipline'], 'Needs classification')
        self.assertEqual(taxonomy_b['discipline'], 'Needs classification')
        self.assertEqual(taxonomy_a['courseKey'], taxonomy_b['courseKey'])


if __name__ == '__main__':
    unittest.main()
