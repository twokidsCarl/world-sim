"""用 GarmentCode（pygarment，MIT）按每副人体的尺寸生成裁片，写到 data/curated/cloth/patterns/<body>-<garment>.json。
Generates sewing patterns with GarmentCode (pygarment, MIT) from each body's measurements and writes them
to data/curated/cloth/patterns/<body>-<garment>.json.

输入 / Input:   data/curated/cloth/bodies/<body>.json（tools/cloth/measure.py 写的 / written by tools/cloth/measure.py）
GarmentCode:    git clone https://github.com/maria-korosteleva/GarmentCode data/raw/cloth/dl/GarmentCode
运行 / Run:     <venv>/bin/python -I tools/cloth/patterns.py [GarmentCode 目录 / directory]

输出是 GarmentCode 自己的“specification”格式（裁片的二维顶点、边与曲率、三维摆放、缝合对），外加我们的
几项说明：每片的布纹方向和所属身体部位、压缩服装的负放松量缩放。
The output is GarmentCode's own "specification" format (2-D panel vertices, edges with curvature, 3-D
placement, stitches) plus a few notes of ours: each panel's grain direction and body part, and the
negative-ease scaling of the compression garments.
"""
import copy
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SOMA = os.path.dirname(os.path.dirname(HERE))
GC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SOMA, 'data', 'raw', 'cloth', 'dl', 'GarmentCode')
sys.path.insert(0, GC)
# 只生成裁片，不画图：cairosvg 依赖系统的 cairo 库，这里用空模块顶替
# patterns only, no drawings: cairosvg needs the system cairo library, so an empty module stands in
sys.modules.setdefault('cairosvg', types.ModuleType('cairosvg'))

import yaml  # noqa: E402
from assets.bodies.body_params import BodyParameters  # noqa: E402
from assets.garment_programs.meta_garment import MetaGarment  # noqa: E402

OUT = os.path.join(SOMA, 'data', 'curated', 'cloth', 'patterns')
BODY_DIR = os.path.join(SOMA, 'data', 'curated', 'cloth', 'bodies')

# 设计参数：在 GarmentCode 的 t-shirt.yaml 之上改动的值（路径 → 值）。
# Design parameters: values changed on top of GarmentCode's t-shirt.yaml (path → value).
#   ease：压缩服装的围度缩放（< 1 为负放松量），沿布纹乘 lengthScale；缩放在 tools/cloth/dress.ts 给裁片
#   划网格时做（先把曲边离散，再缩放，圆弧也不失真）。
#   ease: girth scale of the compression garments (< 1 is negative ease), lengthScale along the grain; the
#   scaling is done when tools/cloth/dress.ts meshes the panels (edges are discretised first, so arcs stay exact).
TOP = {'meta.bottom': None, 'meta.wb': None}
BOTTOM = {'meta.upper': None}
GARMENTS = {
    'tee': {
        'fabric': 'cotton-jersey',
        'design': {**TOP, 'meta.upper': 'Shirt', 'shirt.length': 1.45, 'shirt.width': 1.08, 'shirt.flare': 1.0,
                   'sleeve.sleeveless': False, 'sleeve.length': 0.32, 'sleeve.end_width': 1.0, 'sleeve.sleeve_angle': 10,
                   'collar.f_collar': 'CircleNeckHalf', 'collar.b_collar': 'CircleNeckHalf', 'collar.width': 0.15,
                   'collar.fc_depth': 0.4, 'collar.bc_depth': 0.05},
    },
    'pants': {
        'fabric': 'cotton-twill',
        'design': {**BOTTOM, 'meta.wb': 'StraightWB', 'meta.bottom': 'Pants', 'waistband.width': 0.12, 'waistband.waist': 1.0,
                   'pants.length': 0.9, 'pants.width': 1.08, 'pants.flare': 0.95, 'pants.rise': 0.95},
    },
    'skirt': {
        'fabric': 'cotton-twill',
        'design': {**BOTTOM, 'meta.wb': 'StraightWB', 'meta.bottom': 'PencilSkirt', 'waistband.width': 0.12,
                   'pencil-skirt.length': 0.42, 'pencil-skirt.flare': 1.3, 'pencil-skirt.rise': 0.95},
    },
    'compression-top': {
        'fabric': 'poly-elastane',
        'ease': 0.9, 'lengthScale': 0.98,
        'design': {**TOP, 'meta.upper': 'Shirt', 'shirt.length': 1.3, 'shirt.width': 1.0, 'shirt.flare': 0.95,
                   'sleeve.sleeveless': False, 'sleeve.length': 0.3, 'sleeve.end_width': 0.85, 'sleeve.sleeve_angle': 5,
                   'collar.f_collar': 'CircleNeckHalf', 'collar.b_collar': 'CircleNeckHalf', 'collar.width': 0.0,
                   'collar.fc_depth': 0.3, 'collar.bc_depth': 0.05},
    },
    'sports-bra': {
        'fabric': 'poly-elastane',
        'ease': 0.88, 'lengthScale': 0.98,
        'design': {**TOP, 'meta.upper': 'Shirt', 'shirt.length': 0.78, 'shirt.width': 1.0, 'shirt.flare': 0.9,
                   'sleeve.sleeveless': True, 'sleeve.armhole_shape': 'ArmholeCurve',
                   'collar.f_collar': 'CircleNeckHalf', 'collar.b_collar': 'CircleNeckHalf', 'collar.width': 0.2,
                   'collar.fc_depth': 0.8, 'collar.bc_depth': 0.5},
    },
    'tights': {
        'fabric': 'poly-elastane',
        'ease': 0.88, 'lengthScale': 0.98,
        'design': {**BOTTOM, 'meta.wb': 'StraightWB', 'meta.bottom': 'Pants', 'waistband.width': 0.15, 'waistband.waist': 1.0,
                   'pants.length': 0.9, 'pants.width': 1.0, 'pants.flare': 0.65, 'pants.rise': 1.0},
    },
}
WARDROBE = {
    'male': ['tee', 'pants', 'compression-top', 'tights'],
    'female': ['tee', 'pants', 'skirt', 'sports-bra', 'tights'],
}


def set_path(d, path, value):
    keys = path.split('.')
    for k in keys[:-1]:
        d = d[k]
    d[keys[-1]]['v'] = value


def body_params(name):
    """把量好的尺寸交给 GarmentCode 的 BodyParameters（它从 YAML 读）。
    Hand the measurements to GarmentCode's BodyParameters (which reads YAML)."""
    m = json.load(open(os.path.join(BODY_DIR, name + '.json')))
    path = os.path.join(SOMA, 'data', 'raw', 'cloth', 'work', name, 'body.yaml')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    yaml.safe_dump({'body': m['garmentcode']}, open(path, 'w'))
    return BodyParameters(path), m


def panel_part(name):
    """裁片属于身体的哪一部分、布纹（经向）沿裁片的哪根轴。
    Which body part a panel belongs to and along which panel axis its grain (warp) runs."""
    side = 'L' if name.startswith('left') or '_l' in name.split('_')[-1:] else 'R' if name.startswith('right') else None
    if 'sleeve' in name:
        return {'part': 'arm_' + (side or 'L'), 'grain': 'x'}
    if name.startswith('pant'):
        return {'part': 'leg_' + ('L' if name.endswith('_l') else 'R'), 'grain': 'y'}
    return {'part': 'torso', 'grain': 'y'}


def generate(body_name, garment, body):
    g = GARMENTS[garment]
    design = yaml.safe_load(open(os.path.join(GC, 'assets', 'design_params', 't-shirt.yaml')))['design']
    design = copy.deepcopy(design)
    for path, value in g['design'].items():
        set_path(design, path, value)
    mg = MetaGarment(garment, body, design)
    pattern = mg.assembly()
    spec = copy.deepcopy(pattern.spec)
    for name, p in spec['pattern']['panels'].items():
        p.update(panel_part(name))
    spec['soma'] = {
        'schema': 1,
        'body': body_name,
        'garment': garment,
        'fabric': g['fabric'],
        'ease': g.get('ease', 1.0),
        'lengthScale': g.get('lengthScale', 1.0),
        'design': g['design'],
        'units': 'cm',
        'source': 'GarmentCode (pygarment 2.0.2), MIT licence, https://github.com/maria-korosteleva/GarmentCode',
        'selfIntersecting': bool(mg.is_self_intersecting()),
    }
    return spec


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for body_name, garments in WARDROBE.items():
        body, _ = body_params(body_name)
        for garment in garments:
            spec = generate(body_name, garment, body)
            path = os.path.join(OUT, f'{body_name}-{garment}.json')
            json.dump(spec, open(path, 'w'), indent=None, separators=(',', ':'))
            panels = spec['pattern']['panels']
            print(body_name, garment, len(panels), 'panels', len(spec['pattern']['stitches']), 'stitches',
                  'self-intersecting' if spec['soma']['selfIntersecting'] else '')
