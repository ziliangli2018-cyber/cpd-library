"""Metadata-only incremental catalogue import. Never opens, copies or alters media."""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
from collections import Counter
from pathlib import Path

VIDEOS = {'.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.ts', '.mpeg', '.mpg'}
DOCUMENTS = {'.pdf', '.docx', '.doc', '.ppt', '.pptx', '.key', '.epub'}
RULES = [
    ('Orthodontics', r'orthodont|aligner|invisalign|damon|bracket|malocclusion|microimplant|\btads?\b|biomechanic|straight.?wire|twin.?block|gummetal|eodo|retention'),
    ('Periodontics', r'periodont|perio\b|gingiv|mucogingiv|zucchelli|soft tissue|mucosal|pink aesthe'),
    ('Endodontics', r'endodont|endoart|root canal|obturation|orthograde|apical surgery|pulp'),
    ('Implant dentistry', r'implant|sinus lift|sinus augmentation|all.on.[x46]|osseointeg|full.arch'),
    ('Oral surgery', r'oral surgery|exodont|extraction|wisdom|sutur|replantation|surgical extrusion|orthognathic'),
    ('Orofacial pain & sleep', r'\btmj\b|\btmd\b|temporomandibular|orofacial pain|bruxism|apn[eoa]|sleep|occlus|slavicek|sadao sato|condylograph|splint|neuromuscular'),
    ('Radiology', r'radiolog|radiograph|cbct|x.ray|radiodiag'),
    ('Digital dentistry', r'cerec|exocad|cad.?cam|primescan|intraoral scan|3d print|digital workflow|itero'),
    ('Prosthodontics', r'prostho|prosthe|denture|full mouth|full.mouth|rehabilitation|zirconia|ceramic|crown|bridge'),
    ('Restorative dentistry', r'restorat|composite|adhesi|veneer|onlay|inlay|overlay|esthetic|aesthetic|smile|bonding|preparation|bopt|shade'),
    ('Paediatric dentistry', r'paediatr|pediatr|child|teenager|growing patient'),
]
TAG_RULES = [('Clear aligners', r'aligner|invisalign|spark'), ('Implants', r'implant'), ('Soft tissue', r'soft tissue|gingiv|mucosal'), ('Occlusion', r'occlus'), ('Digital workflow', r'digital|cerec|exocad|cad.cam|primescan'), ('Ceramics', r'ceramic|zirconia|porcelain'), ('Composites', r'composite'), ('Surgical technique', r'surger|surgical|sutur|extraction'), ('Treatment planning', r'planning|diagnos'), ('Children & adolescents', r'child|teenager|paediatr|pediatr'), ('Biomechanics', r'biomechanic'), ('Sleep medicine', r'apnea|apnoea|sleep'), ('Root canal treatment', r'root canal|obturation|endodont'), ('Patient education', r'animation|brochur')]

def clean(text):
    return re.sub(r'^\s*\d+(?:[.\-]\d+)*[.\s_\-]+', '', text).replace('_', ' ').strip()

def classify(course, title):
    # Course-level context is generally stronger than a passing mention in a lecture.
    for text in (course, title):
        for discipline, pattern in RULES:
            if re.search(pattern, text, re.I):
                return discipline
    return 'General dentistry'

def run(config, output):
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    old = json.loads(output.read_text(encoding='utf-8-sig')) if output.exists() else {'schemaVersion': 1, 'lectures': []}
    records = {v['id']: v for v in old['lectures']}
    found = set()
    sources = []
    skipped = 0
    documents = 0
    for source in config['sources']:
        root = Path(source['path'])
        if not root.is_dir():
            sources.append({'name': source['name'], 'count': 0, 'unavailable': True})
            continue
        manifest = {}
        manifest_path = root / 'Dent-S download manifest.json'
        if manifest_path.exists():
            data = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
            manifest = {os.path.normcase(r['destination']): r for r in data.get('rows', []) if r.get('destination')}
        count = 0
        for folder, dirs, filenames in os.walk(root):
            dirs[:] = [d for d in dirs if d not in {'.git', '$RECYCLE.BIN', '.tmp'}]
            for filename in filenames:
                path = Path(folder) / filename
                ext = path.suffix.lower()
                if ext in DOCUMENTS:
                    documents += 1
                if ext not in VIDEOS:
                    continue
                stat = path.stat()
                row = manifest.get(os.path.normcase(str(path)), {})
                # Avoid cataloguing active/partial downloads as complete recordings.
                if stat.st_size == 0 or (row.get('expected_size_bytes') and stat.st_size < row['expected_size_bytes']) or dt.datetime.now().timestamp() - stat.st_mtime < 180:
                    skipped += 1
                    continue
                relative = path.relative_to(root).as_posix()
                record_id = hashlib.sha256((source['name'] + ':' + relative.casefold()).encode()).hexdigest()[:24]
                found.add(record_id)
                count += 1
                parts = path.relative_to(root).parts
                course = row.get('course') or clean(parts[0] if len(parts) > 1 else root.name)
                title = row.get('lesson') or clean(path.stem)
                module = row.get('module') or ' / '.join(clean(p) for p in parts[1:-1])
                existing = records.get(record_id)
                if existing:
                    # All user-edited fields survive rescans. File metadata alone is refreshed.
                    before = (existing.get('bytes'), existing.get('availability'), existing.get('duration'))
                    existing.update(bytes=stat.st_size, availability='Source file found')
                    if row.get('duration_seconds'):
                        existing['duration'] = row['duration_seconds']
                    if before != (existing['bytes'], existing['availability'], existing['duration']) or not existing.get('sourceUpdatedAt'):
                        existing['sourceUpdatedAt'] = now
                    continue
                text = f'{course} {module} {title}'
                records[record_id] = dict(id=record_id, title=title, course=course, module=module, discipline=classify(course, title), tags=[tag for tag, regex in TAG_RULES if re.search(regex, text, re.I)], youtubeUrl='', notes='', source=source['name'], relativePath=relative, duration=row.get('duration_seconds') or None, bytes=stat.st_size, importedAt=now, updatedAt=now, sourceUpdatedAt=now, classificationReviewed=False, availability='Source file found')
        sources.append({'name': source['name'], 'count': count})
    for record in records.values():
        if record['id'] not in found and record.get('relativePath') and record.get('availability') != 'Source not confirmed on latest scan':
            record['availability'] = 'Source not confirmed on latest scan'
            record['sourceUpdatedAt'] = now
    # Flag possible duplicates; do not delete or merge unrelated files based on names.
    duplicate_keys = Counter((Path(v['relativePath']).name.casefold(), v['bytes']) for v in records.values() if v.get('relativePath'))
    for v in records.values():
        key = (Path(v['relativePath']).name.casefold(), v['bytes'])
        duplicate = hashlib.sha256(repr(key).encode()).hexdigest()[:12] if v.get('relativePath') and duplicate_keys[key] > 1 else None
        if duplicate != v.get('duplicateGroup'):
            v['sourceUpdatedAt'] = now
            if duplicate:
                v['duplicateGroup'] = duplicate
            else:
                v.pop('duplicateGroup', None)
    result = {**old, 'schemaVersion': 1, 'updatedAt': now, 'lectures': sorted(records.values(), key=lambda v: (v['source'], v['relativePath'])), 'importSummary': {'scannedAt': now, 'sources': sources, 'documents': documents, 'skipped': skipped}}
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temp.replace(output)
    print(json.dumps({'lectures': len(records), 'sources': sources, 'documentsReservedForLater': documents, 'recentOrPartialFilesSkipped': skipped, 'disciplines': dict(Counter(v['discipline'] for v in records.values()))}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--output', default='.private/catalogue.json')
    args = parser.parse_args()
    run(json.loads(Path(args.config).read_text(encoding='utf-8-sig')), Path(args.output))
