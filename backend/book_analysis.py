"""Suggest local PDF music-page groups; users review these before note recognition."""
from collections import Counter
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
if sys.prefix == sys.base_prefix:
    sys.path.insert(0, str(ROOT / 'vendor'))
import re
import statistics

# This module's PDF routines run in dedicated child processes, never server threads.


def clean_title(text):
    text = re.sub(r'\s+', ' ', text).strip(' \t-')
    if not 2 <= len(text) <= 200 or not any(char.isalnum() for char in text):
        return ''
    if re.fullmatch(r'(?:page\s+)?\d{1,3}', text, re.I):
        return ''
    if text.lower() in ('verse', 'chorus', 'bridge', 'intro', 'coda', 'fine', 'd.s. al coda', 'contents', 'table of contents'):
        return ''
    return text


def toc_entries(text):
    entries = []
    for raw in text.splitlines():
        # Positioned music text can contain thousands of spaces; never backtrack over it.
        if len(raw) > 300:
            continue
        line = raw.rstrip()
        number = re.search(r'(\d{1,3})$', line)
        if number is None:
            continue
        prefix = line[:number.start()]
        leader = re.search(r'(?:[.…]{2,}|[ \t]{2,})$', prefix)
        if leader is None:
            continue
        title = clean_title(prefix[:leader.start()])
        if title:
            entries.append((title, int(number[1])))
    return entries if len(entries) >= 2 else []


def _five_lines(lines, tolerance):
    """Return staff top positions for overlapping five-line, equally-spaced groups."""
    lines = sorted(lines)
    merged = []
    for y, left, right in lines:
        if merged and abs(y - merged[-1][0]) <= tolerance:
            old = merged[-1]
            merged[-1] = ((old[0] + y) / 2, min(old[1], left), max(old[2], right))
        else:
            merged.append((y, left, right))
    staves = []
    index = 0
    while index + 4 < len(merged):
        group = merged[index:index + 5]
        gaps = [group[i + 1][0] - group[i][0] for i in range(4)]
        spacing = statistics.median(gaps)
        overlap = min(line[2] for line in group) - max(line[1] for line in group)
        if 1 <= spacing <= 24 and max(abs(gap - spacing) for gap in gaps) <= max(tolerance, spacing * .2) and overlap > 0:
            staves.append(group[0][0])
            index += 5
        else:
            index += 1
    return staves


def vector_staves(page):
    lines = []
    minimum = page.rect.width * .2
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0] == 'l':
                start, end = item[1], item[2]
                if abs(start.y - end.y) <= .6 and abs(start.x - end.x) >= minimum:
                    lines.append(((start.y + end.y) / 2, min(start.x, end.x), max(start.x, end.x)))
            elif item[0] == 're':
                rect = item[1]
                if rect.height <= 1.6 and rect.width >= minimum:
                    lines.append((rect.y0 + rect.height / 2, rect.x0, rect.x1))
    return _five_lines(lines, .65)


def raster_staves(page):
    import pymupdf
    from PIL import Image
    scale = min(1000 / page.rect.width, 1400 / page.rect.height)
    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY, alpha=False)
    image = Image.frombytes('L', (pixmap.width, pixmap.height), pixmap.samples)
    binary = image.point(lambda pixel: 0 if pixel < 170 else 255)
    rows = []
    required = max(30, int(image.width * .2))
    for y in range(binary.height):
        row = binary.crop((0, y, binary.width, y + 1)).tobytes()
        runs = row.split(b'\xff')
        longest = max((len(run) for run in runs), default=0)
        if longest >= required:
            start = row.find(b'\x00' * longest)
            rows.append((y / scale, start / scale, (start + longest) / scale))
    return _five_lines(rows, 1.2 / scale)


def heading(page, data, staff_top):
    width, height = page.rect.width, page.rect.height
    lines = []
    limit = min(height * .2, staff_top - 2)
    for block in data.get('blocks', []):
        for line in block.get('lines', []):
            spans = [span for span in line['spans'] if span['text'].strip() and not re.search(r'musejazz|maestro|bravura|petaluma|opus|music|feta|emmentaler|gonville', span.get('font', ''), re.I)]
            if not spans:
                continue
            text = ' '.join(span['text'].strip() for span in spans)
            title = clean_title(text)
            if not title or text.startswith(('-', '©')) or re.match(r'^(?:words|music|by|arranged|copyright|all rights)\b', text, re.I):
                continue
            x0, y0, x1, y1 = line['bbox']
            size = max(span['size'] for span in spans)
            if y0 > limit or y1 > staff_top or size < 10:
                continue
            center = (x0 + x1) / 2
            centered = abs(center - width / 2) < width * .23
            if size < 12 and not centered:
                continue
            if title.isdigit() and (not centered or size < 14):
                continue
            if x1 < width * .15 or x0 > width * .85:
                continue
            # Song headings precede the staff and usually exceed the composer/body font.
            score = size + (5 if centered else 0) - y0 / height * 12
            lines.append((score, title, size))
    if not lines:
        return ''
    lines.sort(reverse=True)
    return lines[0][1]


def ocr_heading(page, staff_top, tessdata):
    import pymupdf
    if not tessdata or not (Path(tessdata) / 'eng.traineddata').is_file():
        return ''
    crop = pymupdf.Rect(0, 0, page.rect.width, min(staff_top, page.rect.height * .2))
    if crop.height < 12:
        return ''
    with pymupdf.open() as header:
        target = header.new_page(width=crop.width, height=crop.height)
        target.insert_image(target.rect, pixmap=page.get_pixmap(clip=crop, matrix=pymupdf.Matrix(1.5, 1.5), alpha=False))
        textpage = target.get_textpage_ocr(language='eng', dpi=150, full=True, tessdata=str(tessdata))
        return heading(page, target.get_text('dict', textpage=textpage), staff_top)


def _key(title):
    return ''.join(char for char in title.lower() if char.isalnum())


def analyse(path, progress=None, tessdata=None, cancelled=None):
    import pymupdf
    records, contents, warnings = [], [], []
    ocr_count = 0
    with pymupdf.open(path) as document:
        if document.needs_pass:
            raise ValueError('Password-protected PDFs are not supported.')
        if not 1 <= len(document) <= 500:
            raise ValueError('Choose a PDF with 1 to 500 pages.')
        for index, page in enumerate(document):
            if cancelled and cancelled():
                raise InterruptedError('Book analysis was interrupted.')
            text = page.get_text('text', sort=True)
            staves = vector_staves(page)
            entries = toc_entries(text) if not staves else []
            contents.extend(entries)
            evidence = 'vector'
            if not staves and not entries:
                staves = raster_staves(page)
                evidence = 'scan'
            title, title_source = '', ''
            if staves:
                title = heading(page, page.get_text('dict'), min(staves))
                title_source = 'heading' if title else ''
                if not title and page.get_images() and not re.search(r'[A-Za-z]{3,}', text) and ocr_count < 50:
                    ocr_count += 1
                    try:
                        title = ocr_heading(page, min(staves), tessdata)
                        title_source = 'ocr' if title else ''
                    except Exception:
                        if 'Scanned headings could not be read. Review unnamed pieces.' not in warnings:
                            warnings.append('Scanned headings could not be read. Review unnamed pieces.')
            records.append({'page': index + 1, 'music': bool(staves), 'title': title, 'title_source': title_source, 'evidence': evidence})
            if progress:
                progress(index + 1, len(document))
    # Derive printed-page offset only from headings that agree with contents entries.
    offsets = []
    for title, page in contents:
        matches = [record for record in records if record['music'] and _key(record['title']) == _key(title)]
        if len(matches) == 1:
            offsets.append(matches[0]['page'] - page)
    counts = Counter(offsets)
    offset = counts.most_common(1)[0][0] if counts else 0
    offset_confirmed = bool(counts and counts[offset] >= 2)
    toc = {page + offset: title for title, page in contents if 1 <= page + offset <= len(records)}
    candidates, current = [], None
    for record in records:
        if not record['music']:
            current = None
            continue
        page = record['page']
        title = record['title'] or toc.get(page, '')
        if current and (not title or _key(title) == _key(current['title'])):
            current['pages'].append(page)
            continue
        source = record['title_source']
        matched_toc = page in toc and _key(toc[page]) == _key(title)
        high = bool(source == 'heading' and (record['evidence'] == 'vector' or matched_toc and offset_confirmed))
        reason = 'Title heading and music staff lines.' if source == 'heading' else 'Scanned heading: check spelling and page range.' if source == 'ocr' else 'Contents entry: check the page range.' if title else 'Music detected; no readable title. Set the song name and check where it ends.'
        current = {'title': title or 'Untitled piece ' + str(len(candidates) + 1), 'pages': [page], 'confidence': 'high' if high else 'review', 'reason': reason}
        candidates.append(current)
    for candidate in candidates:
        identity = candidate['title'] + ':' + ','.join(map(str, candidate['pages']))
        candidate['id'] = hashlib.sha256(identity.encode()).hexdigest()[:16]
    if ocr_count >= 50:
        warnings.append('Heading OCR is limited to 50 scanned music pages. Review the remaining page groups.')
    return {'candidates': candidates, 'music_pages': [record['page'] for record in records if record['music']],
            'skipped_pages': [record['page'] for record in records if not record['music']], 'analysis_warnings': warnings}


def preview(path, page_number, max_edge=1400):
    import pymupdf
    with pymupdf.open(path) as document:
        if type(page_number) is not int or not 1 <= page_number <= len(document):
            raise ValueError('Choose a page inside this book.')
        page = document[page_number - 1]
        scale = min(max_edge / page.rect.width, max_edge / page.rect.height, 2)
        return page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes('png')


def main():
    import contextlib
    import json
    import pymupdf
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    protocol = sys.stdout
    try:
        mode, path = sys.argv[1:3]
        with contextlib.redirect_stdout(sys.stderr):
            if mode == 'analyse':
                def progress(done, total):
                    protocol.write(json.dumps({'progress': {'done': done, 'total': total}}) + '\n')
                    protocol.flush()
                result = analyse(path, progress=progress, tessdata=sys.argv[3] if len(sys.argv) > 3 else None)
            elif mode == 'preview':
                result = preview(path, int(sys.argv[3]))
            else:
                raise ValueError('Invalid book analysis command.')
        if mode == 'preview':
            protocol.buffer.write(result)
            protocol.buffer.flush()
        else:
            protocol.write(json.dumps({'result': result}) + '\n')
            protocol.flush()
    except Exception as error:
        print(json.dumps({'error': str(error)}), file=protocol, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
