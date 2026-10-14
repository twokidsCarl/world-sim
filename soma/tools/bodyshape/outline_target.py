"""
新头的体形目标包（female-face-target-outline/）：头部的深层包络按新头的外形（head_outline.py）和形变后的颅骨重做，身体沿用 female-face-target。
The body-shape target package for the new head (female-face-target-outline/): the head part of the deep envelope is remade from the
outline of the new head (head_outline.py) and the warped skull; the body keeps that of female-face-target.

    SOMA_HEAD_SNAPSHOT=<快照目录 snapshot dir> bun tools/pipeline/female.ts --out <任意 any>      （头形变之后即停 / stops after the head warp）
    python tools/bodyshape/outline_target.py --snapshot <快照目录 snapshot dir> [--outline female-head-outline-s1606] [--out female-face-target-outline]

顺序 / order
  头的形变（几何管线）先做，骨随之确定；这里读的是管线在“头已形变、体形重塑尚未做”时存下的部件快照（SOMA_HEAD_SNAPSHOT）：
  没有与本次骨架相符的目标包时体形重塑不做，构建随后在上臂外展处报错，所以不能读一次完整构建的导出。包络只取决于新头的外形和形变后的骨，
  不取决于体形重塑的结果，所以不成环。basedOn.key 取快照的 key.json 里的 skeletonKey（体形重塑不动骨）。
  The head warp of the geometry pipeline comes first and settles the bones; what is read here is the part snapshot the pipeline dumps
  with the head warped and the body-shape stage not yet run (SOMA_HEAD_SNAPSHOT): without a target package made for this skeleton the
  body-shape stage does not run and the build then fails at the arm abduction, so the export of a complete build cannot be read. The
  envelope depends on the outline of the new head and on the warped bones only, not on the result of the body-shape stage, so there is
  no loop. basedOn.key is skeletonKey of the snapshot's key.json (the body-shape stage moves no bone).

包络的规则与 face_target_report.py 相同（假定，不是文献值）：t = clip(d - 2.5 mm, 1.5 mm, 6 mm)，d = 皮肤到颅骨、下颌骨的距离；
按新头的接缝权重（fit-state-outline.npz 的 joinWeight）过渡到 female-face-target/deep-envelope.obj。颈部的包络没有改。
The envelope follows the rule of face_target_report.py (an assumption, not from a source): t = clip(d - 2.5 mm, 1.5 mm, 6 mm), d = distance
from the skin to skull or mandible; blended into female-face-target/deep-envelope.obj by the join weight of the new head (joinWeight of
fit-state-outline.npz). The envelope of the neck is not changed.

只写 data/raw/bodyshape/out/<--out>/（名称须以 female-face-target-outline 开头）。
Writes data/raw/bodyshape/out/<--out>/ only (the name must begin with female-face-target-outline).
"""
import hashlib
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import signed_distance  # noqa: E402
from fit_skin import vertex_normals, write_obj  # noqa: E402
from reissue_r2 import load_obj  # noqa: E402

BASE = 'female-face-target'


class Snapshot:
    """管线的部件快照（female.ts 的 writePartSnapshot：parts.json + parts.bin），只提供这里用到的 Body 的几个方法。
    A part snapshot of the pipeline (writePartSnapshot of female.ts: parts.json + parts.bin) with the few methods of Body used here."""

    def __init__(self, d):
        self.parts = [m for m in json.load(open(os.path.join(d, 'parts.json'))) if m['kind'] == 'part']
        self._buf = open(os.path.join(d, 'parts.bin'), 'rb').read()

    def mesh(self, p):
        v = np.frombuffer(self._buf, dtype='<f4', count=p['nv'] * 3, offset=p['po']).reshape(-1, 3).astype(np.float64)
        f = np.frombuffer(self._buf, dtype='<u4', count=p['ni'], offset=p['io']).reshape(-1, 3).astype(np.int64)
        return v, f

    def merged(self, pred):
        vs, fs, n = [], [], 0
        for p in self.parts:
            if pred(p):
                v, f = self.mesh(p)
                vs.append(v)
                fs.append(f + n)
                n += len(v)
        return np.vstack(vs), np.vstack(fs)

    def deep_parts(self):
        return [p for p in self.parts if p['tissue'] in Body.DEEP and p['system'] != 'integumentary']


def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


def main():
    import igl
    outline = arg('--outline', 'female-head-outline-s1606')
    out_name = arg('--out', 'female-face-target-outline')
    assert out_name.startswith('female-face-target-outline'), 'this tool writes female-face-target-outline* directories only'
    out = os.path.join(RAW, 'out', out_name)
    snap = arg('--snapshot')
    assert snap, 'give --snapshot <directory written by the pipeline with SOMA_HEAD_SNAPSHOT>'
    kj = json.load(open(os.path.join(snap, 'key.json')))
    assert kj.get('headWarped'), 'the snapshot was written without the head warp'
    key = arg('--key', kj['skeletonKey'])
    fb = Snapshot(snap)
    od = os.path.join(RAW, 'out', outline)
    T, F = load_obj(os.path.join(od, 'skin-with-new-head.obj'))
    E0, F0 = load_obj(os.path.join(RAW, 'out', BASE, 'deep-envelope.obj'))
    assert len(E0) == len(T) and np.array_equal(F, F0), 'the outline and the base envelope differ in topology'
    b = np.load(os.path.join(od, 'fit-state-outline.npz'))['joinWeight'].astype(float)
    A = ES.adjacency(len(T), F)
    C = np.ascontiguousarray

    # ---- 头的深层包络 / deep envelope of the head
    SV, SF = fb.merged(lambda p: p['tissue'] == 'bone' and p['name'] not in ('Hyoid bone', 'Atlas', 'Axis') and 'vertebra' not in p['name'].lower())
    d = np.sqrt(igl.point_mesh_squared_distance(C(T), C(SV), C(SF))[0])
    t = np.clip(d - 0.0025, 0.0015, 0.006)
    for _ in range(4):
        t = 0.5 * t + 0.5 * (A @ t)
    n = vertex_normals(T, F)
    for _ in range(3):
        n = 0.5 * n + 0.5 * (A @ n)
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    E = E0 + b[:, None] * ((T - t[:, None] * n) - E0)
    hd = b > 0.9
    env = {'rule': 't = clip(d - 2.5 mm, 1.5 mm, 6 mm), d = distance from the skin of the new head to the warped skull or mandible; smoothed; blended by the join weight of the head outline into '
                   f'{BASE}/deep-envelope.obj; the rule is the assumption of face_target_report.py',
           'thicknessOnHeadMm': {'p10': round(float(np.percentile(t[hd], 10) * 1000), 1), 'p50': round(float(np.median(t[hd]) * 1000), 1), 'p90': round(float(np.percentile(t[hd], 90) * 1000), 1)},
           'verticesChangedFromTheBase': int((np.linalg.norm(E - E0, axis=1) > 1e-6).sum())}

    # ---- 冲突清单：头颈的深部结构相对包络（体形重塑之前）/ conflict list: deep parts of head and neck against the envelope (before the body-shape stage)
    ymin = T[hd][:, 1].min() - 0.07
    rows = []
    for p in fb.deep_parts():
        v = fb.mesh(p)[0]
        if v[:, 1].max() < ymin or v[:, 1].mean() < ymin:
            continue
        s = signed_distance(v, E, F) * 1000
        if (s > 0).any():
            ss = signed_distance(v, T, F) * 1000
            rows.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutsideEnvelope': round(float((s > 0).mean()), 3), 'p50Mm': round(float(np.median(s[s > 0])), 1),
                         'p95Mm': round(float(np.percentile(s, 95)), 1), 'maxMm': round(float(s.max()), 1), 'shareOutsideTargetSkin': round(float((ss > 0).mean()), 3), 'maxOutsideTargetSkinMm': round(float(ss.max()), 1)})
    rows.sort(key=lambda r: -r['shareOutsideEnvelope'] * max(r['p95Mm'], 0.1))

    # ---- 唇：两个唇部件和口轮匝肌在新唇面下应有的覆盖（规则同 face_target_report.py）/ lips: the cover both lip parts and orbicularis oris should have under the new lip surface (rule of face_target_report.py)
    lips = []
    for nm, want in (('Lip', 0.5), ('Orbicularis oris', 3.0)):
        ps = [p for p in fb.deep_parts() if p['name'] == nm or (nm == 'Lip' and p['name'] in ('Upper lip', 'Lower lip')) or (nm == 'Orbicularis oris' and 'orbicularis oris' in p['name'].lower())]
        for p in ps:
            v = fb.mesh(p)[0]
            v = v[v[:, 2] > np.percentile(v[:, 2], 67)]
            c = -signed_distance(v, T, F) * 1000
            lips.append({'id': p['id'], 'name': p['name'], 'medianCoverMm': round(float(np.median(c)), 1), 'leastCoverMm': round(float(c.min()), 1), 'coverWantedMm': want,
                         'forwardDisplacementNeededMm': round(max(float(np.median(c)) - want, 0.0), 1)})
    assert sum(1 for x in lips if x['name'] in ('Upper lip', 'Lower lip', 'Lip')) >= 1 and any('orbicularis' in x['name'].lower() for x in lips), 'lip parts not found in the export'

    # ---- 写 / write
    os.makedirs(out, exist_ok=True)
    write_obj(os.path.join(out, 'deep-envelope.obj'), E, F, f'female TARGET deep envelope for the new head: head from {outline} and the warped skull (thickness rule in the manifest), blended by the join weight; body as in {BASE}/deep-envelope.obj')
    write_obj(os.path.join(out, 'skin.obj'), T, F, f'{outline}/skin-with-new-head.obj, copied: the target skin of the new head; MHR LOD0 topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    json.dump({'envelope': env, 'lipParts': lips, 'conflicts': rows}, open(os.path.join(out, 'conflict-list.json'), 'w'), ensure_ascii=False, indent=1)
    old = json.load(open(os.path.join(RAW, 'out', BASE, 'manifest.json')))
    sha = lambda f: hashlib.sha1(open(f, 'rb').read()).hexdigest()[:16]
    json.dump({
        'schema': 1, 'kind': 'target',
        'what': {'zh': '女性目标包（体形重塑用）：头部的深层包络按新头的外形和形变后的颅骨重做，身体沿用 female-face-target；skin.obj 是新头的外形本身，没有为包住任何深部结构而外推。不是可安装的皮肤包。',
                 'en': 'female target package for the body-shape stage: the head part of the deep envelope remade from the outline of the new head and the warped skull, the body as in female-face-target; '
                       'skin.obj is the outline of the new head itself, with nothing pushed out to enclose any deep part. Not an installable skin package.'},
        'source': old['source'], 'basedOn': {'body': 'female', 'key': key}, 'frame': old['frame'],
        'statureM': round(float(np.ptp(T[:, 1])), 4),
        'envelope': env,
        'madeFrom': {'outline': outline, 'outlineSkinSha1': sha(os.path.join(od, 'skin-with-new-head.obj')), 'baseEnvelope': f'{BASE}/deep-envelope.obj', 'baseEnvelopeSha1': sha(os.path.join(RAW, 'out', BASE, 'deep-envelope.obj')),
                     'bones': 'part snapshot of the pipeline with the head warped and the body-shape stage not yet run (SOMA_HEAD_SNAPSHOT)', 'headWarpOutline': kj.get('outline')},
        'files': {'skin.obj': 'target skin, MHR LOD0 topology and vertex order', 'deep-envelope.obj': 'deep envelope, same topology',
                  'conflict-list.json': 'lipParts (both lip parts and orbicularis oris with the cover wanted) and the deep parts of head and neck outside the envelope before the body-shape stage',
                  'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution'},
    }, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    for f in ('LICENSE-MHR.txt', 'NOTICE-MHR.txt'):
        shutil.copy(os.path.join(od, f), os.path.join(out, f))
    print(f'written {out_name}/: basedOn.key {key}; envelope {env}; {len(rows)} deep parts of head and neck outside the envelope; lip parts:')
    for x in lips:
        print(f'  {x["name"]:20s} median cover {x["medianCoverMm"]:5.1f} mm, least {x["leastCoverMm"]:5.1f}, wanted {x["coverWantedMm"]} -> forward by about {x["forwardDisplacementNeededMm"]} mm')
    for r in rows[:12]:
        print(f'  {100 * r["shareOutsideEnvelope"]:5.1f} %  p95 {r["p95Mm"]:5.1f} max {r["maxMm"]:5.1f} mm   outside the skin {100 * r["shareOutsideTargetSkin"]:5.1f} % {r["maxOutsideTargetSkinMm"]:5.1f} mm   {r["name"]} [{r["tissue"]}]')


if __name__ == '__main__':
    main()
