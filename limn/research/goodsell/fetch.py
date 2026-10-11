"""取 David S. Goodsell 的插图，建索引。可以重跑，已有的跳过。
Fetch David S. Goodsell's illustrations and index them. Safe to rerun; what is there is skipped.

来源和许可（取之前在页面上核实过）/ sources and licences (checked on the pages before fetching):

- PDB-101 的 Goodsell Gallery：页面写明 “These illustrations are free for use under CC-BY-4.0
  license. Acknowledgement should be given as shown for each illustration.”
- PDB-101 的 Molecule of the Month：RCSB 的使用政策（https://www.rcsb.org/pages/usage-policy）写明
  “Molecule of the Month illustrations are available under a CC-BY-4.0 license. Attribution should
  be given to David S. Goodsell and the RCSB PDB. Molecule of the Month articles are copyrighted by
  the RCSB PDB and the authors of the article.” 所以只取图，文章的文字（包括图注）不存。
  So only the pictures are taken, and none of the articles' text (captions included) is kept.
- 维基共享资源：每个文件自带许可，只收 CC 和公有领域的。
  Wikimedia Commons: every file carries its licence; only CC and public-domain ones are taken.

图存在 limn/.cache/goodsell/（不入库）；索引写到本目录的 motm/index.json、commons/index.json。
Pictures go to limn/.cache/goodsell/ (not in git); the indexes are written to motm/index.json and
commons/index.json in this directory.

用法 / usage:  python3 -I research/goodsell/fetch.py [motm] [commons] [tif]
"""
import concurrent.futures as cf
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(os.path.dirname(HERE)), '.cache', 'goodsell')
UA = 'limn (local illustration tool; research on drawing style)'


def get(url, timeout=60):
    """用 curl 取：这台机器上 Python 自带的证书库不全 / via curl: this machine's Python lacks a full certificate store"""
    r = subprocess.run(['curl', '-sL', '-m', str(timeout), '-A', UA, url], capture_output=True)
    return r.stdout


def save(url, path, timeout=120):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = get(url, timeout)
    # 只认真的图片：JPEG、PNG、GIF、TIFF 的文件头 / real images only: JPEG, PNG, GIF or TIFF magic numbers
    if not (data[:2] == b'\xff\xd8' or data[:4] == b'\x89PNG' or data[:4] == b'GIF8' or data[:4] in (b'II*\x00', b'MM\x00*')):
        return False
    with open(path, 'wb') as f:
        f.write(data)
    return True


def motm():
    listing = get('https://pdb101.rcsb.org/motm/motm-by-date').decode('utf8', 'ignore')
    ids = sorted({int(m) for m in re.findall(r'href="/motm/(\d+)"', listing)})

    def one(n):
        # 同时取得太多时服务器会回空页，所以少开几个并发，空了就等一下再试
        # the server answers with empty pages when asked for too many at once, hence few workers and a pause before retrying
        page = ''
        for attempt in range(4):
            page = get(f'https://pdb101.rcsb.org/motm/{n}').decode('utf8', 'ignore')
            if '<title>' in page and 'cdn.rcsb.org/pdb101/motm' in page:
                break
            time.sleep(2 + attempt * 3)
        title = re.search(r'<title>(.*?)</title>', page, re.S)
        title = re.sub(r'\s+', ' ', html.unescape(title.group(1))).replace('PDB-101: Molecule of the Month: ', '').strip() if title else ''
        year = re.search(r'Molecule of the Month[^<]{0,40}?(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})', re.sub(r'<[^>]*>', ' ', page))
        # 他的插图：本篇目录下的 JPG，去掉交互查看器的截图 / his illustrations: the JPGs under this article's directory, less the screenshots of the interactive viewer
        # 早期的文章用 GIF，最近的用 PNG；同一张图有几种时取 JPG / early articles use GIF and the latest PNG; where a picture exists in several, the JPG is taken
        found = [m for m in re.findall(rf'https://cdn\.rcsb\.org/pdb101/motm/{n}/([^"\'<> ]+?)\.(jpg|png|gif)', page) if not re.search(r'jmol|jsmol|rasmol', m[0], re.I)]
        ext = {}
        for name, e in found:
            if ext.get(name) != 'jpg' and not (ext.get(name) == 'png' and e == 'gif'):
                ext[name] = e
        images = []
        for name in sorted(ext):
            e = ext[name]
            ok = save(f'https://cdn.rcsb.org/pdb101/motm/{n}/{urllib.parse.quote(name)}.{e}', os.path.join(CACHE, 'motm', str(n), f'{name}.{e}'))
            if ok:
                images.append({'file': f'{n}/{name}.{e}', 'pdb': sorted({p.upper() for p in re.findall(r'(?<![A-Za-z0-9])([0-9][a-z0-9]{3})(?![A-Za-z0-9])', name.lower())})})
        return {'n': n, 'title': title, 'month': f'{year.group(1)} {year.group(2)}' if year else '', 'images': images}

    with cf.ThreadPoolExecutor(3) as ex:
        rows = [r for r in ex.map(one, ids)]
    os.makedirs(os.path.join(HERE, 'motm'), exist_ok=True)
    json.dump({
        'about': 'PDB-101 “每月分子”各篇里 David S. Goodsell 的插图：篇号、标题、图的文件名和文件名里出现的 PDB 编号。图本身不在仓库里，用 fetch.py 取到 limn/.cache/goodsell/motm/；地址是 https://cdn.rcsb.org/pdb101/motm/<file>。许可：RCSB 的使用政策写明这些插图以 CC-BY-4.0 提供，署名 David S. Goodsell 和 RCSB PDB；文章的文字有版权，这里没有存。 / David S. Goodsell\'s illustrations in each PDB-101 Molecule of the Month article: article number, title, image file names and the PDB ids that appear in them. The pictures are not in the repository; fetch.py puts them in limn/.cache/goodsell/motm/, from https://cdn.rcsb.org/pdb101/motm/<file>. Licence: RCSB\'s usage policy states the illustrations are available under CC-BY-4.0, with attribution to David S. Goodsell and the RCSB PDB; the articles\' text is copyrighted and none of it is kept here.',
        'source': 'https://pdb101.rcsb.org/motm/motm-by-date',
        'licence': 'CC BY 4.0',
        'attribution': 'David S. Goodsell and the RCSB PDB',
        'articles': rows,
    }, open(os.path.join(HERE, 'motm', 'index.json'), 'w'), ensure_ascii=False, indent=1)
    n = sum(len(r['images']) for r in rows)
    print(f'motm: {len(rows)} articles, {n} images, {sum(1 for r in rows if not r["images"])} articles with none')


def commons():
    api = 'https://commons.wikimedia.org/w/api.php?'
    titles, cont = [], ''
    for _ in range(10):
        q = api + urllib.parse.urlencode({'action': 'query', 'list': 'search', 'srsearch': '"David S. Goodsell"', 'srnamespace': 6, 'srlimit': 50, 'format': 'json', **({'sroffset': cont} if cont else {})})
        d = json.loads(get(q))
        titles += [h['title'] for h in d.get('query', {}).get('search', [])]
        cont = d.get('continue', {}).get('sroffset')
        if not cont:
            break
    rows, skipped = [], []
    for i in range(0, len(titles), 25):
        q = api + urllib.parse.urlencode({'action': 'query', 'titles': '|'.join(titles[i:i + 25]), 'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata', 'iiurlwidth': 1200, 'format': 'json'})
        for p in json.loads(get(q)).get('query', {}).get('pages', {}).values():
            info = (p.get('imageinfo') or [{}])[0]
            meta = info.get('extmetadata', {})
            text = lambda k: re.sub(r'<[^>]*>', '', html.unescape(meta.get(k, {}).get('value', ''))).strip()
            licence, artist = text('LicenseShortName'), text('Artist')
            free = bool(re.match(r'(CC[ -]|Public domain|PD)', licence, re.I))
            # 只收作者一栏写着他的 / only files whose author field names him
            if not free or 'goodsell' not in artist.lower() or not re.search(r'\.(jpe?g|png|tiff?)$', p['title'], re.I):
                skipped.append({'title': p['title'], 'licence': licence, 'artist': artist[:80]})
                continue
            name = re.sub(r'[^A-Za-z0-9._-]+', '_', p['title'].replace('File:', ''))
            thumb = info.get('thumburl') or info.get('url')
            name = os.path.splitext(name)[0] + ('.png' if thumb.lower().endswith('.png') else '.jpg')
            if save(thumb, os.path.join(CACHE, 'commons', name)):
                rows.append({'file': name, 'title': p['title'], 'licence': licence, 'artist': artist[:120], 'credit': text('Credit')[:200], 'page': info.get('descriptionurl', ''), 'width': info.get('width'), 'height': info.get('height')})
    os.makedirs(os.path.join(HERE, 'commons'), exist_ok=True)
    json.dump({
        'about': '维基共享资源上作者一栏写着 David S. Goodsell、许可是 CC 或公有领域的图：文件名、许可、署名、出处页。图本身不在仓库里，用 fetch.py 取到 limn/.cache/goodsell/commons/（宽 1200 像素的版本）。skipped 是搜到但没收的，以及原因所在的字段。 / Files on Wikimedia Commons whose author field names David S. Goodsell and whose licence is CC or public domain: file name, licence, credit, description page. The pictures are not in the repository; fetch.py puts them (at 1200 pixels wide) in limn/.cache/goodsell/commons/. `skipped` lists what the search found and was not taken, with the fields that decided it.',
        'source': 'https://commons.wikimedia.org/',
        'files': sorted(rows, key=lambda r: r['file']),
        'skipped': sorted(skipped, key=lambda r: r['title']),
    }, open(os.path.join(HERE, 'commons', 'index.json'), 'w'), ensure_ascii=False, indent=1)
    print(f'commons: {len(titles)} found, {len(rows)} taken, {len(skipped)} skipped')


def tif():
    """对照用的那几幅水彩的原尺寸图 / the full-size originals of the paintings used in pairs"""
    pairs = json.load(open(os.path.join(HERE, 'pairs.json')))['pairs']
    names = sorted({p['ref'][:-4] for p in pairs if p.get('ref', '').endswith('.jpg') and '/' not in p['ref']})
    ok = [n for n in names if save(f'https://cdn.rcsb.org/pdb101/goodsell/tif/{n}.tif', os.path.join(CACHE, 'tif', n + '.tif'), 600)]
    print(f'tif: {len(ok)}/{len(names)}: {", ".join(ok)}')


if __name__ == '__main__':
    todo = sys.argv[1:] or ['motm', 'commons', 'tif']
    for what in todo:
        {'motm': motm, 'commons': commons, 'tif': tif}[what]()
