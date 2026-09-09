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
                                'module': 'Module',
                                'discipline': 'General dentistry',
                                'tags': [],
                                'youtubeUrl': '',
                                'notes': '',
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
                {'sources': [{'name': source_name, 'path': str(root)}]},
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


if __name__ == '__main__':
    unittest.main()
