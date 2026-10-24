"""按当前 CSV 和 ZIP 原样导入通知材料；仅依赖 Python 标准库。"""
from pathlib import Path
from zipfile import ZipFile
import csv
import hashlib
import json
import re
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'content/source/2026-10-24'
CSV = SOURCE / 'A1通知材料库 - A1通知材料库.csv'
ZIP = SOURCE / 'A1刺激材料池(1).zip'
VERSION = 'a1-library-2026-10-24'


def digest(data):
    return hashlib.sha256(data).hexdigest()


with CSV.open(encoding='utf-8-sig', newline='') as stream:
    rows = list(csv.reader(stream))
if len(rows) < 3 or rows[0][0] != '卡片编号' or rows[1][4:10] != ['题干', '选项A', '选项B', '选项C', '选项D', '答案']:
    raise ValueError('CSV标题与当前材料表结构不符')
images = {}
with ZipFile(ZIP) as archive:
    for item in archive.infolist():
        name = Path(item.filename).name
        if '__MACOSX' in item.filename or not re.fullmatch(r'[123]N-[12]L-\d{2}\.png', name):
            continue
        if name in images:
            raise ValueError('重复图片编号: ' + name)
        data = archive.read(item)
        if data[:8] != b'\x89PNG\r\n\x1a\n' or len(data) < 24:
            raise ValueError('无效PNG: ' + name)
        images[name] = {'data': data, 'archive_path': item.filename,
                        'size': list(struct.unpack('>II', data[16:24]))}

materials, issues = [], []
for number, row in enumerate(rows[2:], 3):
    if not any(row):
        continue
    if len(row) != 16 or not re.fullmatch(r'[123]N-[12]L-\d{2}', row[0]):
        raise ValueError(f'CSV第{number}行结构或编号无效')
    identifier, n, label, body, question = row[:5]
    count = int(n.removesuffix('N'))
    options, answer, domain = row[5:9], row[9], row[10]
    units = [value for value in row[12:15] if value]
    if count != int(identifier[0]) or len(units) != count or answer not in 'ABCD' or len(answer) != 1 or not all([body, question, domain, *options]):
        raise ValueError('题目、答案或N单元无效: ' + identifier)
    name = identifier + '.png'
    if name not in images:
        raise ValueError('缺少图片: ' + name)
    warnings = []
    labels = [re.match(r'N\d+', value).group() if re.match(r'N\d+', value) else None for value in units]
    if labels != [f'N{i + 1}' for i in range(count)]:
        raise ValueError('N单元标签无效: ' + identifier)
    computed = len(re.sub(r'\s+', '', body))
    if int(row[15]) != computed:
        warnings.append('character_count_difference')
        issues.append({'id': identifier, 'issue': warnings[-1], 'source': int(row[15]), 'computed': computed,
                       'action': '保留表格原值及独立计算值，不改写材料'})
    line_count = int(row[11])
    if line_count not in [1, 2]:
        raise ValueError('正文行数无效: ' + identifier)
    materials.append({'id': identifier, 'material_version': VERSION, 'domain': domain,
        'source_label': label, 'text_lines': body.splitlines(), 'n_count': count,
        'line_count': line_count, 'character_count': int(row[15]), 'character_count_computed': computed,
        'n_units': units, 'question': question, 'options': options, 'correct': 'ABCD'.index(answer),
        'answer_key': answer, 'synthetic': False, 'render_image': name,
        'image_sha256': digest(images[name]['data']),
        'source_ref': {'file': str(CSV.relative_to(ROOT)), 'row': number, 'range': f'A{number}:P{number}'},
        'source_warnings': warnings})
if len({m['id'] for m in materials}) != len(materials):
    raise ValueError('重复材料编号')
if set(images) != {m['render_image'] for m in materials}:
    raise ValueError('CSV与ZIP编号不能一一对应')
if [sum(m['n_count'] == n for m in materials) for n in [1, 2, 3]] != [6, 6, 6]:
    raise ValueError('当前材料应为N1/N2/N3各6条')
manifest = {'material_version': VERSION, 'material_count': len(materials), 'image_count': len(images),
    'sources': [{'file': str(p.relative_to(ROOT)), 'sha256': digest(p.read_bytes())} for p in [CSV, ZIP]],
    'images': [{'file': name, 'sha256': digest(image['data']), 'width': image['size'][0], 'height': image['size'][1]}
               for name, image in sorted(images.items())],
    'issues': issues,
    'notes': ['题干、选项、答案、N单元、正文和声明行数均来自CSV原值。',
              '卡片直接显示ZIP原始PNG，不根据CSV重新排版；CSV未保留图片折行。',
              '字符数差异保留来源值和计算值；不自动修订来源。']}
# 完成全部来源匹配后才替换运行资源，清除不在新库中的卡片。
assets = ROOT / 'content/assets/notifications'
assets.mkdir(parents=True, exist_ok=True)
for name, image in images.items():
    (assets / name).write_bytes(image['data'])
for old in assets.iterdir():
    if old.is_file() and old.name not in images:
        old.unlink()
for name, data in [('materials.json', materials), ('materials.manifest.json', manifest)]:
    (ROOT / 'content' / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'已导入{len(materials)}条材料、{len(images)}张原图；{len(issues)}项来源字符数差异已原样保留。')
