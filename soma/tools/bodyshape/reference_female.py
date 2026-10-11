"""女性皮肤的一键重建：对 public/anatomy/female/ 的当前内容重新拟合 MHR 并生成体型场。
One command to rebuild the female skin against whatever public/anatomy/female/ now contains:
refits MHR and regenerates the shape fields.

    python tools/bodyshape/reference_female.py [--bmi 21.6]
    -> data/raw/bodyshape/out/female-skin/   skin.obj, weights.bin, joints.json, fit.json/.txt,
       shape-*.f32, shape-fields.json, previews, LICENSE-MHR.txt, NOTICE-MHR.txt, manifest.json

步骤 / steps: export-parts.ts female -> measure.py female（骨性标志）-> fit_skin.py female --mode targets（有 rig.json 时用其关节中心）
-> shape_fields.py female。男性同理：fit_skin.py male; shape_fields.py male。
The same for the male: fit_skin.py male; shape_fields.py male.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    bmi = sys.argv[sys.argv.index('--bmi') + 1] if '--bmi' in sys.argv else '21.6'
    py = sys.executable
    # 先重新导出，免得用到旧的网格 / re-export first so that no stale meshes are used
    for cmd in (['bun', os.path.join(HERE, 'export-parts.ts'), 'female'],
                [py, '-I', os.path.join(HERE, 'measure.py'), 'female'],
                [py, os.path.join(HERE, 'fit_skin.py'), 'female', '--mode', 'targets', '--bmi', bmi],
                [py, os.path.join(HERE, 'shape_fields.py'), 'female']):
        print('>>', ' '.join(os.path.basename(c) if os.path.exists(c) else c for c in cmd), flush=True)
        subprocess.run(cmd, check=True)


if __name__ == '__main__':
    main()
