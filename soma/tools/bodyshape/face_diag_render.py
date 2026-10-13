"""
脸的“瘦削”从哪来：三种组合的正面和四分之三侧面渲染，并排。
Where the gauntness of the face comes from: front and three-quarter renders of three combinations, side by side.

    (a) 身份系数在先验均值 + 变形   identity at the prior mean + warp      -> female-face-diag-a/
    (b) 拟合的身份系数，不做变形     fitted identity, no warp               -> female-face-diag-b/
    (c) 两者都做                     both                                   -> female-face-target/
    python tools/bodyshape/face_diag_render.py   -> female-face-target/diagnostic-front.png, diagnostic-threequarter.png
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402


def main():
    from PIL import Image
    out = os.path.join(RAW, 'out', 'female-face-target')
    Vs = [np.load(os.path.join(RAW, 'out', d, 'target-shape.npz'))['V'] for d in ('female-face-diag-a', 'female-face-diag-b', 'female-face-target')]
    F = mhrlib.faces(0)
    fb = Body('female')
    eye = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
    top = max(V[:, 1].max() for V in Vs)
    Fh = F[(Vs[2][:, 1] > top - 0.34)[F].all(1)]
    c0 = np.array([eye[0], 0.0, eye[2] - 0.08])
    for tag, ang in (('front', 0.0), ('threequarter', -35.0)):
        a = np.radians(ang)
        R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
        ims = []
        for V in Vs:
            p = os.path.join(out, '_tmp.png')
            render_closeup([((V - c0) @ R.T + c0, Fh, (0.87, 0.72, 0.62))], p, [eye[0] - 0.13, top - 0.27, -1.0], [eye[0] + 0.13, top + 0.01, 1.0], views=('front',), height=900)
            ims.append(Image.open(p).convert('RGB'))
            os.remove(p)
        W = Image.new('RGB', (sum(i.width for i in ims), max(i.height for i in ims)), 'white')
        x = 0
        for i in ims:
            W.paste(i, (x, 0))
            x += i.width
        W.save(os.path.join(out, f'diagnostic-{tag}.png'))


if __name__ == '__main__':
    main()
