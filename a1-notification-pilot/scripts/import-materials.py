"""从归档的原始XLSX/ZIP生成材料JSON；只用Python标准库，不修改来源文件。"""
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import hashlib
import json
import re
import posixpath

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'content/source/2026-10-22'
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

with ZipFile(SOURCE / 'A1通知材料库.xlsx') as z:
    strings = [''.join(n.itertext()) for n in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
    workbook = ET.fromstring(z.read('xl/workbook.xml'))
    sheet = workbook.find('m:sheets/m:sheet', NS)
    rid = sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    target = next(r.attrib['Target'] for r in rels if r.attrib['Id'] == rid)
    part = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
    # 原文件dimension错误地写成A1；直接遍历sheetData，不据此截断有效单元格。
    rows = []
    for row in ET.fromstring(z.read(part)).findall('m:sheetData/m:row', NS):
        cells = {}
        for cell in row.findall('m:c', NS):
            value = cell.find('m:v', NS)
            text = value.text if value is not None else ''
            if cell.attrib.get('t') == 's': text = strings[int(text)]
            elif cell.attrib.get('t') == 'inlineStr': text = ''.join(cell.find('m:is', NS).itertext())
            if text: cells[re.sub(r'\d+', '', cell.attrib['r'])] = text
        if re.fullmatch(r'[123]N-[12]L-\d{2}', cells.get('A', '')): rows.append((row.attrib['r'], cells))

assets = ROOT / 'content/assets/notifications'
assets.mkdir(parents=True, exist_ok=True)
with ZipFile(SOURCE / 'A1刺激材料池.zip') as z:
    images = {}
    for item in z.infolist():
        name = Path(item.filename).name
        if '__MACOSX' in item.filename or not re.fullmatch(r'[123]N-[12]L-\d{2}\.png', name): continue
        if name in images: raise ValueError('重复卡片图: ' + name)
        (assets / name).write_bytes(z.read(item))
        images[name] = item.filename

materials, issues = [], []
for row_number, row in rows:
    identifier = row['A']
    lines = row['D'].replace('\r\n', '\n').replace('\r', '\n').split('\n')
    count = int(row['B'].removesuffix('N'))
    line_count = int(row['L'])
    if len(lines) != line_count: raise ValueError('正文行数与来源声明不符: ' + identifier)
    image = assets / (identifier + '.png')
    if not image.exists(): raise ValueError('卡片图片缺失: ' + identifier)
    options = [row[c] for c in 'FGHI']
    # Excel将17:40/17:20存为日小数，按其时间显示格式恢复，避免显示0.736…。
    for i, c in enumerate('FGHI'):
        if re.fullmatch(r'0\.\d+', options[i]):
            minutes = round(float(options[i]) * 24 * 60)
            options[i] = f'{minutes // 60:02d}:{minutes % 60:02d}'
    units = [row[c].strip() for c in 'MNO' if row.get(c, '').strip()]
    labels = [re.match(r'N\d+', unit).group() for unit in units]
    warnings = []
    if set(labels) != {f'N{i+1}' for i in range(count)}:
        warnings.append('source_unit_labels_nonsequential')
        issues.append({'id': identifier, 'issue': warnings[-1], 'source_labels': labels, 'action': '原样保留，未重编码'})
    materials.append({'id': identifier, 'domain': row['K'], 'source_label': row['C'], 'text_lines': lines,
        'n_count': count, 'line_count': line_count, 'character_count': int(row['P']),
        'character_count_computed': len(re.sub(r'\s+', '', row['D'])), 'n_units': units,
        'question': row['E'], 'options': options, 'correct': 'ABCD'.index(row['J']), 'answer_key': row['J'],
        'synthetic': False, 'render_image': identifier + '.png', 'image_sha256': digest(image),
        'source_ref': {'file': 'content/source/2026-10-22/A1通知材料库.xlsx', 'sheet': sheet.attrib['name'], 'row': int(row_number), 'range': f'A{row_number}:P{row_number}'},
        'source_warnings': warnings})
if len({m['id'] for m in materials}) != len(materials): raise ValueError('材料编号重复')
if set(images) != {m['render_image'] for m in materials}: raise ValueError('表格与图片编号不能一一匹配')
for m in materials:
    if m['character_count'] != m['character_count_computed']: issues.append({'id': m['id'], 'issue': 'character_count_difference', 'source': m['character_count'], 'computed': m['character_count_computed'], 'action': '两值同时保留'})
(ROOT / 'content/materials.json').write_text(json.dumps(materials, ensure_ascii=False, indent=2) + '\n')
manifest = {'material_version': 'a1-library-2026-10-22', 'material_count': len(materials), 'image_count': len(images),
    'sources': [{'file': p.name, 'sha256': digest(p)} for p in sorted(SOURCE.iterdir()) if p.suffix in {'.xlsx', '.zip'}],
    'issues': issues, 'notes': ['使用来源PNG作为模拟眼镜卡片，保留正文换行和来源标题；问题/答案来自XLSX。', 'N编码沿用材料库，不能自动视为原SOP的IU切分。', '原XLSX工作表dimension为A1，但实际包含18行材料；提取直接读取sheetData。']}
(ROOT / 'content/materials.manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f'已导入{len(materials)}条材料、{len(images)}张卡片，来源差异{len(issues)}项。')
