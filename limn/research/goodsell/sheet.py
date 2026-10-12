"""把一轮里所有卡片的出图拼成一张总览，防止只盯着一个模型时别的悄悄变坏。
Tile the pictures of every card from one round into a contact sheet, so that nothing goes bad
unnoticed while one model is being worked on.

图由页面的控制台存到 .cache/snapshots/<轮次>-<卡片 id>.png（见 README 里的 limn.sheet）。
The pictures are saved from the page's console to .cache/snapshots/<round>-<card id>.png (see
limn.sheet in the README).

用法 / usage:  uv run --no-project --with pillow python -I research/goodsell/sheet.py <轮次 / round>
"""
import json
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def main():
    rnd = sys.argv[1]
    cards = json.load(open(os.path.join(ROOT, 'sim.json')))['cards']
    cell, cols = 360, 5
    rows = (len(cards) + cols - 1) // cols
    sheet = Image.new('RGB', (cell * cols, (cell + 14) * rows), 'white')
    draw = ImageDraw.Draw(sheet)
    missing = []
    for k, c in enumerate(cards):
        path = os.path.join(ROOT, '.cache', 'snapshots', f"{rnd}-{c['id']}.png")
        x, y = (k % cols) * cell, (k // cols) * (cell + 14)
        draw.text((x + 3, y + 1), c['id'], fill='black')
        if not os.path.exists(path):
            missing.append(c['id'])
            continue
        im = Image.open(path).convert('RGB')
        im.thumbnail((cell - 6, cell - 6))
        sheet.paste(im, (x + (cell - im.width) // 2, y + 14))
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    out = os.path.join(HERE, 'out', f'sheet-{rnd}.jpg')
    sheet.save(out, quality=84)
    print(out, f'{len(cards) - len(missing)}/{len(cards)}', 'missing: ' + ', '.join(missing) if missing else '')


if __name__ == '__main__':
    main()
