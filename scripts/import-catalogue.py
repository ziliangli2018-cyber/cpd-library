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
DISCIPLINES = {
    'Orthodontics',
    'Restorative dentistry',
    'Prosthodontics',
    'Periodontics',
    'Implant dentistry',
    'Implantology & periodontology',
    'Oral surgery',
    'Oral medicine',
    'Endodontics',
    'Digital dentistry',
    'Orofacial pain & sleep',
    'Paediatric dentistry',
    'Radiology',
    'Practice management',
    'General dentistry',
    'Needs classification',
}
TAG_RULES = [('Clear aligners', r'aligner|invisalign|spark'), ('Implants', r'implant'), ('Soft tissue', r'soft tissue|gingiv|mucosal'), ('Occlusion', r'occlus'), ('Digital workflow', r'digital|cerec|exocad|cad.cam|primescan'), ('Ceramics', r'ceramic|zirconia|porcelain'), ('Composites', r'composite'), ('Surgical technique', r'surger|surgical|sutur|extraction'), ('Treatment planning', r'planning|diagnos'), ('Children & adolescents', r'child|teenager|paediatr|pediatr'), ('Biomechanics', r'biomechanic'), ('Sleep medicine', r'apnea|apnoea|sleep'), ('Root canal treatment', r'root canal|obturation|endodont'), ('Patient education', r'animation|brochur')]

def clean(text):
    return re.sub(r'^\s*\d+(?:[.\-]\d+)*[.\s_\-]+', '', text).replace('_', ' ').strip()

def _path_parts(value):
    return tuple(part for part in value.replace('\\', '/').strip('/').split('/') if part)


def _rule_for(source, directories):
    rules = source.get('hierarchy', {}).get('rules', [])
    candidates = []
    for position, rule in enumerate(rules):
        prefix = _path_parts(rule.get('pathPrefix', ''))
        if tuple(part.casefold() for part in directories[:len(prefix)]) == tuple(
            part.casefold() for part in prefix
        ):
            candidates.append((len(prefix), -position, rule))
    return max(candidates, default=(0, 0, {}), key=lambda item: item[:2])[2]


def _mapped_discipline(rule, directories, course_index):
    discipline_index = rule.get('disciplineIndex', course_index)
    if not isinstance(discipline_index, int) or not 0 <= discipline_index < len(directories):
        return 'Needs classification'
    folder = directories[discipline_index]
    exact = {
        str(key).casefold(): value
        for key, value in rule.get('disciplineMap', {}).items()
    }
    discipline = exact.get(folder.casefold()) or exact.get(clean(folder).casefold())
    if not discipline:
        for prefix, value in sorted(
            rule.get('disciplinePrefixMap', {}).items(),
            key=lambda item: len(str(item[0])),
            reverse=True,
        ):
            if folder.casefold().startswith(str(prefix).casefold()):
                discipline = value
                break
    if not discipline:
        discipline = rule.get('defaultDiscipline', 'Needs classification')
    if discipline not in DISCIPLINES:
        raise ValueError(f'Unsupported discipline {discipline!r} in source hierarchy')
    return discipline


def derive_taxonomy(source, relative_parts, manifest_row=None):
    """Derive one course identity from folders; lecture titles never affect it."""
    directories = tuple(relative_parts[:-1])
    if not directories:
        directories = (Path(source['path']).name,)
    rule = _rule_for(source, directories)
    course_index = rule.get('courseIndex', 0)
    if not isinstance(course_index, int) or course_index < 0:
        raise ValueError('courseIndex must be a non-negative integer')
    if course_index >= len(directories):
        course_index = rule.get('courseFallbackIndex', len(directories) - 1)
    if not isinstance(course_index, int) or not 0 <= course_index < len(directories):
        raise ValueError('courseFallbackIndex must identify a parent folder')
    module_start = rule.get('moduleStartIndex', course_index + 1)
    if not isinstance(module_start, int) or module_start < 0:
        raise ValueError('moduleStartIndex must be a non-negative integer')
    row = manifest_row or {}
    prefer_manifest = bool(rule.get('preferManifestLabels'))
    course = (
        row.get('course')
        if prefer_manifest and row.get('course')
        else clean(directories[course_index])
    )
    module = (
        row.get('module')
        if prefer_manifest and row.get('module')
        else ' / '.join(clean(part) for part in directories[module_start:])
    )
    course_path = '/'.join(directories[:course_index + 1])
    course_key = hashlib.sha256(
        f"{source['name']}:{course_path.casefold()}".encode()
    ).hexdigest()[:24]
    return {
        'course': course,
        'module': module,
        'discipline': _mapped_discipline(rule, directories, course_index),
        'courseKey': course_key,
        'taxonomySource': 'folder',
    }

def run(config, output):
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    old = json.loads(output.read_text(encoding='utf-8-sig')) if output.exists() else {'schemaVersion': 1, 'lectures': []}
    records = {v['id']: v for v in old['lectures']}
    found = set()
    sources = []
    skipped = 0
    documents = 0
    taxonomy_changes = 0
    hierarchy_changes = 0
    needs_classification = set()
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
                taxonomy = derive_taxonomy(source, parts, row)
                course = taxonomy['course']
                title = row.get('lesson') or clean(path.stem)
                module = taxonomy['module']
                existing = records.get(record_id)
                if existing:
                    # Manual taxonomy survives rescans. Folder-derived taxonomy is refreshed.
                    existing.setdefault('watchHistory', [])
                    existing.setdefault('progressStatus', 'in-progress' if existing['watchHistory'] else 'unseen')
                    taxonomy_changed = False
                    if existing.get('classificationReviewed'):
                        existing.setdefault('courseKey', taxonomy['courseKey'])
                        existing.setdefault('taxonomySource', 'manual')
                        existing.setdefault('taxonomyUpdatedAt', existing.get('updatedAt', now))
                    else:
                        hierarchy_changed = any(
                            existing.get(key) != taxonomy[key]
                            for key in ('course', 'module', 'discipline')
                        )
                        taxonomy_changed = any(
                            existing.get(key) != value for key, value in taxonomy.items()
                        ) or not existing.get('taxonomyUpdatedAt')
                        existing.update(taxonomy)
                        existing['classificationReviewed'] = False
                        if taxonomy_changed:
                            existing['taxonomyUpdatedAt'] = now
                            taxonomy_changes += 1
                        if hierarchy_changed:
                            hierarchy_changes += 1
                        if taxonomy['discipline'] == 'Needs classification':
                            needs_classification.add((source['name'], taxonomy['courseKey'], course))
                    before = (existing.get('bytes'), existing.get('availability'), existing.get('duration'))
                    existing.update(bytes=stat.st_size, availability='Source file found')
                    if row.get('duration_seconds'):
                        existing['duration'] = row['duration_seconds']
                    if taxonomy_changed or before != (existing['bytes'], existing['availability'], existing['duration']) or not existing.get('sourceUpdatedAt'):
                        existing['sourceUpdatedAt'] = now
                    continue
                if taxonomy['discipline'] == 'Needs classification':
                    needs_classification.add((source['name'], taxonomy['courseKey'], course))
                text = f'{course} {module} {title}'
                records[record_id] = dict(id=record_id, title=title, **taxonomy, taxonomyUpdatedAt=now, tags=[tag for tag, regex in TAG_RULES if re.search(regex, text, re.I)], youtubeUrl='', notes='', progressStatus='unseen', watchHistory=[], source=source['name'], relativePath=relative, duration=row.get('duration_seconds') or None, bytes=stat.st_size, importedAt=now, updatedAt=now, sourceUpdatedAt=now, classificationReviewed=False, availability='Source file found')
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
    result = {**old, 'schemaVersion': 1, 'updatedAt': now, 'lectures': sorted(records.values(), key=lambda v: (v['source'], v['relativePath'])), 'importSummary': {'scannedAt': now, 'sources': sources, 'documents': documents, 'skipped': skipped, 'taxonomyChanges': taxonomy_changes, 'hierarchyChanges': hierarchy_changes, 'coursesNeedingClassification': len(needs_classification)}}
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix('.tmp')
    temp.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temp.replace(output)
    print(json.dumps({'lectures': len(records), 'sources': sources, 'documentsReservedForLater': documents, 'recentOrPartialFilesSkipped': skipped, 'taxonomyChanges': taxonomy_changes, 'hierarchyChanges': hierarchy_changes, 'coursesNeedingClassification': len(needs_classification), 'disciplines': dict(Counter(v['discipline'] for v in records.values()))}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='.private/sources.json')
    parser.add_argument('--output', default='.private/catalogue.json')
    args = parser.parse_args()
    run(json.loads(Path(args.config).read_text(encoding='utf-8-sig')), Path(args.output))
