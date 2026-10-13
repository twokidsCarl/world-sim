# 女性外阴的皮肤：Wu 等 2015 标本的会阴皮肤（46_Skin.obj，CC BY 4.0），按已装入的 WU_* 部件定位到本体上。
# 由 graft.py 的 vulva 步骤调用。
# The female vulvar skin: the perineal skin of the specimen of Wu et al. 2015 (46_Skin.obj, CC BY 4.0), placed in the
# body by the installed WU_* parts. Called by the vulva step of graft.py.

import json
import os
import re

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import scipy.sparse.linalg as spla
from scipy.spatial import cKDTree

from open_skin import MM, TAGS, boundary_loops, graph, half_edge_map, read_obj, unique_edges, write_obj
from graft import fill_holes, graft, ordered_loop, single_loop_region, vertex_graph
from genital import face_components, intersecting_pairs, islands
from remesh import cut_by_level, edge_table

# 收窄到裂的“顶”时用的数（都写进报告）/ the numbers used in narrowing the patch to the roof of the cleft (all recorded in the report)
TRIM_ABOVE_PLANE_MM = 3.0   # 外缘从标本截面向上让开这么高（沿真实皮肤切）/ the outer rim is taken this far above the specimen's cut plane (cut through real skin)
TRIM_REACH_MM = 6.0         # 只在离截面上那段外缘这么近（沿面）的范围内按高度切 / the cut by height applies only this close (along the surface) to the stretch of rim on the plane
WALL_FROM_MIDLINE_MM = 18.0 # 沿面离中线这么远以外、又朝向中线的面算裂的壁（大腿内侧）/ surface further than this from the midline (along the surface) and facing the midline counts as a wall of the cleft (medial thigh)
WALL_FACING = -0.3          # 朝向中线：外法线的横向分量（背离中线为正）小于它 / facing the midline: lateral component of the outward normal (positive away from the midline) below this

# ── 步骤：女性外阴的皮肤 / step: the female vulvar skin ──────────────────────────────────────────

# Wu 等 2015 的原始文件名（数据集里固定的名字）→ 管线里的部件 id（去掉 WU_ 和左右后缀）
# raw file names of Wu et al. 2015 (fixed names of the dataset) → part id in the pipeline (without WU_ and the side suffix)
WU_FILES = {
    'cavernous_body_of_clitoris': '39_Cavernous_body_of_clitoris', 'vestibular_bulb': '38_Vestibular_bulb', 'vaginal_wall': '21_Vaginal_wall',
    'uterine_and_vaginal_lumen': '19_Uterine_and_vaginal_lumen', 'submucous_layer_of_urethra': '35_Submucous_layer_of_urethra',
    'urethral_sphincter_proper': '31_Urethral_sphincter_proper', 'perineal_body': '24_Perineal_body', 'external_anal_sphincter': '13_External_anal_sphincter',
    'internal_anal_sphincter': '11_Internal_anal_sphincter_', 'bulbospongiosus_muscle': '37_Bulbospongiosus_muscle', 'ischiocavernous_muscle': '36_Ischiocavernous_muscle',
    'bartholin_gland': '22_Bartholin_s_gland', 'superficial_transverse_perineal_muscle': '26_Superficial_transverse_perineal_muscle',
    'deep_perineal_muscle': '25_Deep_perineal_muscle', 'urethro_vaginal_sphincter': '34_Urethro_vaginal_sphincter', 'urethral_compressor_muscle': '33_Urethral_compressor_muscle',
}
WU_SOURCE = {'name': 'Wu et al. 2015, female pelvic floor (PLoS ONE 10(7): e0132226; correction e0140736)', 'url': 'https://doi.org/10.1371/journal.pone.0132226', 'license': 'CC BY 4.0', 'file': '46_Skin.obj'}
KREKLAU = {'source': 'Kreklau et al. 2018, BJOG, doi:10.1111/1471-0528.15387, n = 657; mean ± SD, mm',
           'labiaMajoraLength': [79.7, 15.3], 'labiaMinoraLength': [42.5, 16.3], 'labiaMinoraWidth': [13.8, 7.8], 'clitorisToUrethralOrifice': [22.6, 7.7], 'introitus': [27.9, 10.4], 'perineum': [21.3, 8.5]}


def fit_specimen_map(raw, shipped):
    """
    原始标本坐标 → 本体坐标的映射：先仿射（由各结构的质心起步，再按最近点迭代），再加一个平滑的残差场。
    从发布的 WU_* 部件对原始 OBJ 求得，不重做管线的骨场。
    The map from raw specimen coordinates to the body: an affine map (started from the centroids of the
    structures, refined by closest points) plus a smooth residual field. Derived from the shipped WU_* parts
    against the raw OBJ files; the pipeline's bone field is not re-implemented.
    """
    stems = sorted(set(raw) & set(shipped))
    A = np.c_[np.array([raw[s].mean(0) for s in stems]), np.ones(len(stems))]
    X = np.linalg.lstsq(A, np.array([shipped[s].mean(0) for s in stems]), rcond=None)[0]
    trees = {s: cKDTree(shipped[s]) for s in stems}
    rng = np.random.RandomState(0)
    sub = {s: raw[s][rng.choice(len(raw[s]), min(len(raw[s]), 1500), replace=False)] for s in stems}
    for _ in range(12):
        P, Q = [], []
        for s in stems:
            t = np.c_[sub[s], np.ones(len(sub[s]))] @ X
            d, j = trees[s].query(t)
            keep = d < np.percentile(d, 90)
            P.append(sub[s][keep])
            Q.append(shipped[s][j[keep]])
        P, Q = np.concatenate(P), np.concatenate(Q)
        X = np.linalg.lstsq(np.c_[P, np.ones(len(P))], Q, rcond=None)[0]
    res_affine = {}
    ctr, vec = [], []
    for s in stems:
        t = np.c_[sub[s], np.ones(len(sub[s]))] @ X
        d, j = trees[s].query(t)
        res_affine[s] = round(float(np.median(d)) / MM, 2)
        ctr.append(t)
        vec.append(shipped[s][j] - t)
    ctr, vec = np.concatenate(ctr), np.concatenate(vec)
    sigma = 0.012
    tree = cKDTree(ctr)

    def residual(Y):
        out = np.zeros_like(Y)
        for i, nb in enumerate(tree.query_ball_point(Y, 3 * sigma)):
            if nb:
                w = np.exp(-((ctr[nb] - Y[i]) ** 2).sum(1) / (2 * sigma ** 2))
                # 离锚点远处场衰减到 0，不外推 / the field fades to nothing away from the anchors: no extrapolation
                out[i] = (w[:, None] * vec[nb]).sum(0) / (w.sum() + 5.0)
        return out

    def apply(Y):
        t = np.c_[Y, np.ones(len(Y))] @ X
        return t + residual(t)

    res_final = {}
    for s in stems:
        d = trees[s].query(apply(sub[s]))[0]
        res_final[s] = round(float(np.median(d)) / MM, 2)
    L = X[:3].T
    U_, sv_, _ = np.linalg.svd(L)
    info = {'anchors': stems, 'scale': round(float(abs(np.linalg.det(L)) ** (1 / 3)) * 1000, 4), 'singularValues': [round(float(v) * 1000, 4) for v in sv_],
            'principalScales': [{'scale': round(float(sv_[i]) * 1000, 4), 'directionInBodyFrame': [round(float(v), 3) for v in U_[:, i]]} for i in range(3)],
            'scaleAlongBodyAxes': {'what': 'length of a unit raw vector after the map, measured for the raw directions that land on body X (width), Y (height), Z (depth)', 'x': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 0])), 4), 'y': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 1])), 4), 'z': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 2])), 4)},
            'scaleNote': 'the map is anisotropic. Width is explained: the pipeline enlarges the specimen x 1.096 and the standardisation of the skeleton narrows the pelvis x 0.8857 (pipeline-report.json, standard.scales.pelvisWidth), together 0.971. Height and depth are NOT explained by the report: it states only trunk x 0.9948 for height (expected 1.090, found about 1.036, i.e. 0.950 of the expected) and no scale at all for depth (expected 1.096, found about 0.937, i.e. 0.855 of the expected). The report says the Wu parts are carried by a blend of the rigid pose and standardisation maps of both hip bones and the sacrum (wu.carriage), which is not a similarity and may account for the difference; this was not verified. All dimension checks use the installed size',
            'medianResidualMm': {'affine': res_affine, 'withSmoothField': res_final},
            'overallMedianResidualMm': {'affine': round(float(np.median(list(res_affine.values()))), 2), 'withSmoothField': round(float(np.median(list(res_final.values()))), 2)}}
    return apply, info


def taubin(V, F, fixed, iterations=10, lam=0.5, mu=-0.53):
    """Taubin 平滑：去掉台阶而不整体收缩；fixed 的顶点不动 / Taubin smoothing: removes the stair-steps without overall shrinkage; `fixed` vertices stay"""
    A, _ = vertex_graph(len(V), F)
    deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
    P = V.copy()
    for _ in range(iterations):
        for f in (lam, mu):
            d = (A @ P) / deg[:, None] - P
            d[fixed] = 0
            P = P + f * d
    return P


def step_vulva(pk, deep, wu_dir, out_dir, max_rim_mm=5.0):
    import igl
    if (pk.manifest.get('fittedTo') or {}).get('body') != 'female':
        raise SystemExit('step vulva is for the female body')
    parts = [p for p in (deep or {}).get('parts', []) if p['group'] == 'wuAnchor']
    if len(parts) < 6:
        raise SystemExit('step vulva needs the WU_* anchor parts in deep-face.json (tools/skinopen/export-deep.ts)')
    shipped = {}
    for p in parts:
        stem = re.sub(r'^WU_|_[LR]$', '', p['id'])
        shipped.setdefault(stem, []).append(np.array(p['positions']).reshape(-1, 3))
    shipped = {k: np.concatenate(v) for k, v in shipped.items()}
    raw = {}
    for stem, fn in WU_FILES.items():
        f = os.path.join(wu_dir, fn + '.obj')
        if stem in shipped and os.path.exists(f):
            raw[stem] = read_obj(f)[0]
    apply, fit = fit_specimen_map(raw, shipped)
    SV, SF, _ = read_obj(os.path.join(wu_dir, WU_SOURCE['file']))
    # 切面盖：标本的皮肤块被一个平面截断，平面上的三角形不是皮肤 / the cap: the slab of specimen skin ends at a flat cut plane, whose triangles are not skin
    # 皮肤块的两头都可能是平的截面：某个坐标的极值处有 100 个以上三角形共面的，都算截面
    # either end of the slab may be a flat cut: wherever more than 100 triangles lie in the plane of an extreme coordinate, that is a cut plane
    on_cap = np.zeros(len(SV), bool)
    caps, cap_masks = [], []
    for ax in range(3):
        for end in (SV[:, ax].min(), SV[:, ax].max()):
            m = np.abs(SV[:, ax] - end) < 0.3
            nf = int(m[SF].all(1).sum())
            if nf > 100:
                on_cap |= m
                cap_masks.append(m)
                caps.append({'axis': 'xyz'[ax], 'atRaw': round(float(end), 2), 'triangles': nf})
    cap_faces = on_cap[SF].all(1)
    SFn = SF[~cap_faces]
    DV = apply(SV)
    vol = float(np.einsum('ij,ij->i', DV[SF[:, 0]], np.cross(DV[SF[:, 1]], DV[SF[:, 2]])).sum() / 6)
    if vol < 0:
        SFn = SFn[:, ::-1]
    # 会阴部的一片：离外阴深层结构 35 mm 以内的皮肤 / the perineal patch: skin within 35 mm of the deep structures of the vulva
    ext = np.concatenate([shipped[k] for k in ('cavernous_body_of_clitoris', 'vestibular_bulb', 'bartholin_gland', 'bulbospongiosus_muscle', 'perineal_body', 'external_anal_sphincter') if k in shipped])
    used = np.zeros(len(DV), bool)
    used[SFn] = True
    Ad, _ = vertex_graph(len(DV), SFn)
    sel = used & (cKDTree(ext).query(DV)[0] < 35 * MM)
    idx = np.where(sel)[0]
    ncomp, lab = csgraph.connected_components(Ad[idx][:, idx], directed=False)
    reg = np.zeros(len(DV), bool)
    reg[idx[lab == np.argmax(np.bincount(lab))]] = True
    reg = fill_holes(reg, Ad, used)
    # 这一片可能碰到标本皮肤自己的边（截面把皱襞的顶削掉的地方）：那样它就不是只有一个边界环的圆盘，不能移植，只能量
    # the patch may reach the specimen skin's own edge (where the cut plane sliced the crests of the folds off): it is then not a disc with one boundary loop and can be measured but not grafted
    try:
        reg = single_loop_region(reg, SFn, Ad, 'specimen skin')
        disc = True
    except RuntimeError:
        disc = False
    pf = SFn[reg[SFn].all(1)]
    pv = np.unique(pf)
    local = -np.ones(len(DV), np.int64)
    local[pv] = np.arange(len(pv))
    P0 = DV[pv]
    Fp = local[pf]
    hmp = half_edge_map(Fp)
    bedges = np.array([(a, b) for (a, b) in hmp if (b, a) not in hmp])
    rim = np.unique(bedges)
    on_cut = on_cap[pv]
    loops0 = boundary_loops(Fp, len(pv))
    fixed = np.zeros(len(pv), bool)
    fixed[rim] = True
    P = taubin(P0, Fp, fixed)
    moved = np.linalg.norm(P - P0, axis=1)
    n_spec = len(P)
    # 截面在本体坐标系里的法线，指向尾侧（背离深层结构）/ the normal of the cut plane in the body frame, pointing caudally (away from the deep structures)
    # 取这一片的边缘所在的那个截面（标本块两头各有一个）/ the cut plane the rim of the patch lies on (the slab has one at either end)
    cap_m = max(cap_masks, key=lambda m_: int(m_[pv].sum()))
    cp = DV[cap_m]
    nc = np.linalg.svd(cp - cp.mean(0))[2][2]
    if (ext.mean(0) - cp.mean(0)) @ nc > 0:
        nc = -nc
    truncation_full = cut_plane_runs(P, Fp, on_cut, nc, cp.mean(0))
    full = {'vertices': int(len(P)), 'triangles': int(len(Fp)), 'boundaryVertices': int(len(rim)), 'boundaryVerticesOnACutPlane': int(on_cut[rim].sum()), 'note': 'boundary = the outer rim and the small holes on the cut plane together', 'nonManifoldEdges': int((unique_edges(Fp, len(P))[1] > 2).sum())}
    # ── 收窄到裂的顶（第 13 节）；做不成就退回整片，并写明原因 ──
    # ── narrowed to the roof of the cleft (section 13); if that cannot be done the full patch is kept and the reason recorded ──
    xm0 = float(np.median(np.concatenate([shipped[k] for k in ('perineal_body', 'external_anal_sphincter', 'cavernous_body_of_clitoris') if k in shipped])[:, 0]))
    rim_kind = np.zeros(len(P), np.int64)
    try:
        P, Fp, on_cut, rim_kind, narrowing = narrow_to_roof(P, Fp, on_cut, nc, cp.mean(0), xm0)
        narrowing['fullPatch'] = full
        narrowing['cutPlaneRunsOfTheFullPatch'] = truncation_full
        n_spec = len(P)
    except RuntimeError as err:
        narrowing = {'failed': str(err), 'fullPatch': full}
    truncation = cut_plane_runs(P, Fp, on_cut, nc, cp.mean(0))
    # ── 封闭：片内落在截面上的小洞（皱襞的最低处被截面削掉的地方）用光顺的小盖补上，是构造物 ──
    # ── closure: small holes of the patch lying on the cut plane (where the plane sliced the lowest point of a fold off) are closed with a fair cap; construction ──
    P, Fp, closure = close_inner_loops(P, Fp, on_cut, nc)
    n_disc = len(P)
    on_cut = np.r_[on_cut, np.zeros(n_disc - n_spec, bool)]
    hmp = half_edge_map(Fp)
    bedges = np.array([(a, b) for (a, b) in hmp if (b, a) not in hmp])
    rim = np.unique(bedges)
    loops_now = boundary_loops(Fp, n_disc)
    disc = len(loops_now) == 1
    cut_edges = int((on_cut[bedges[:, 0]] & on_cut[bedges[:, 1]]).sum())
    # 与现有皮肤的差距 / the mismatch against the present skin
    Vc, Fc = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[pk.groups['skin']])
    s = igl.signed_distance(np.ascontiguousarray(P), Vc, Fc)[0]
    edge = np.linalg.norm(P[Fp][:, [0, 1, 2]] - P[Fp][:, [1, 2, 0]], axis=2)
    stats = {
        'specimenMap': fit,
        'cutPlanes': {'what': 'flat cut planes of the specimen slab (not skin), removed', 'planes': caps, 'trianglesRemoved': int(cap_faces.sum()), 'caudalPlaneInBodyFrame': {'point': [round(float(v), 4) for v in cp.mean(0)], 'normalPointingCaudally': [round(float(v), 3) for v in nc]}},
        'patch': {'vertices': int(n_disc), 'triangles': int(len(Fp)), 'specimenVertices': int(n_spec), 'rimVertices': int(len(rim)), 'boundaryLoopsOfTheSpecimenSkinAlone': loops0, 'boundaryLoops': loops_now, 'isDiscWithOneLoop': disc, 'boundaryEdgesOnACutPlane': cut_edges, 'medianEdgeMm': round(float(np.median(edge)) / MM, 2),
                  'rule': 'specimen skin within 35 mm of clitoral body, vestibular bulbs, greater vestibular glands, bulbospongiosus, perineal body and external anal sphincter (as installed)'},
        'narrowing': narrowing,
        'truncation': truncation,
        'closure': closure,
        'smoothing': {'method': 'Taubin, 10 iterations (λ 0.5, μ −0.53), rim fixed', 'movedMm': {'median': round(float(np.median(moved)) / MM, 2), 'p95': round(float(np.percentile(moved, 95)) / MM, 2), 'max': round(float(moved.max()) / MM, 2)}},
        'againstPresentSkinMm': {
            'what': 'signed distance of the fitted patch from the present closed skin; negative = inside the body (above the skin of the crotch)',
            'rim': {'median': round(float(np.median(s[rim])) / MM, 1), 'min': round(float(s[rim].min()) / MM, 1), 'max': round(float(s[rim].max()) / MM, 1), 'medianAbs': round(float(np.median(np.abs(s[rim]))) / MM, 1)},
            'whole': {'median': round(float(np.median(s)) / MM, 1), 'min': round(float(s.min()) / MM, 1), 'max': round(float(s.max()) / MM, 1)},
        },
    }
    # ── 开口：阴道口、尿道口、肛门。从腔的末端沿腔的轴线接到皮肤面上的一条盲管，全是构造物 ──
    # ── orifices: vaginal, urethral, anal. A blind canal from the end of each lumen along its axis to the skin surface; all of it construction ──
    lumens = []
    if 'uterine_and_vaginal_lumen' in shipped:
        lumens.append(('vaginalOrifice', 'WU_uterine_and_vaginal_lumen', 'shipped part', shipped['uterine_and_vaginal_lumen']))
    uf = os.path.join(wu_dir, '30_Bladder_and_urethral_lumen.obj')
    if os.path.exists(uf):
        lumens.append(('urethralOrifice', '30_Bladder_and_urethral_lumen.obj', 'raw file of the same specimen mapped by the specimen map: the urethral lumen is not shipped as a part of its own (it lies inside WU_submucous_layer_of_urethra)', apply(read_obj(uf)[0])))
    rect = [np.array(p_['positions']).reshape(-1, 3) for p_ in (deep or {}).get('parts', []) if p_['id'] == 'WU_rectal_lumen']
    if rect:
        lumens.append(('analOrifice', 'WU_rectal_lumen', 'shipped part', rect[0]))
    Po, groups, orifices = P.copy(), [('vulvaSkin', Fp[(Fp < n_spec).all(1)]), ('vulvaClosure', Fp[~(Fp < n_spec).all(1)])], {}
    Fo = Fp.copy()
    ptag = np.r_[np.zeros(n_spec, np.int64), np.ones(n_disc - n_spec, np.int64)]  # 0 标本皮肤 / specimen skin; 1 构造物 / construction
    centres = {}
    for name, src, how, L in lumens:
        res = open_orifice(Po, Fo, L, nc, n_spec)
        info = res[3]
        info.update({'lumen': src, 'lumenSource': how})
        if name == 'analOrifice' and 'external_anal_sphincter' in shipped and res[0] is not None:
            eas = shipped['external_anal_sphincter']
            c_ = np.array(info['openingCentre'])
            info['externalAnalSphincter'] = {'closestToTheOpeningCentreMm': round(float(cKDTree(eas).query(c_)[0]) / MM, 1), 'transverseExtentMm': round(float(np.ptp(eas[:, 0])) / MM, 1), 'openingLiesWithinItsFootprint': bool(eas[:, 0].min() < c_[0] < eas[:, 0].max() and eas[:, 2].min() < c_[2] < eas[:, 2].max())}
        orifices[name] = info
        if res[0] is None:
            continue
        Po, Fo, canal = res[0], res[1], res[2]
        ptag = np.r_[ptag, np.ones(len(Po) - len(ptag), np.int64)]
        centres[name] = np.array(info['openingCentre'])
    if len(Po) > n_disc or len(Fo) != len(Fp):
        isnew = np.arange(len(Po)) >= n_disc
        spec_f = (Fo < n_spec).all(1)
        clo_f = ~spec_f & ~isnew[Fo].any(1)
        groups = [('vulvaSkin', Fo[spec_f]), ('vulvaClosure', Fo[clo_f]), ('vulvaOrificeCanals', Fo[isnew[Fo].any(1)])]
    stats['orifices'] = orifices
    area = lambda V_, F_: float(np.linalg.norm(np.cross(V_[F_[:, 1]] - V_[F_[:, 0]], V_[F_[:, 2]] - V_[F_[:, 0]]), axis=1).sum() / 2)
    con_f = ptag[Fo].any(1)
    nm_spec = int((unique_edges(Fp[(Fp < n_spec).all(1)], n_spec)[1] > 2).sum())
    nm_all = int((unique_edges(Fo, len(Po))[1] > 2).sum())
    xp = intersecting_pairs(Po, Fo)
    x_con = int(con_f[xp].any(1).sum()) if len(xp) else 0
    stats['construction'] = {'vertices': int(ptag.sum()), 'triangles': int(con_f.sum()), 'areaMm2': round(area(Po, Fo[con_f]) / MM ** 2, 1), 'specimenSkinAreaMm2': round(area(Po, Fo[~con_f]) / MM ** 2, 1),
                             'boundaryLoopsWithCanals': boundary_loops(Fo, len(Po)),
                             'nonManifoldEdges': {'what': 'edges used by more than two triangles', 'inTheSpecimenSkin': nm_spec, 'inThePatchWithConstruction': nm_all, 'note': 'those of the specimen skin are in 46_Skin.obj itself (the walls of the midline cleft touch); construction adds none'},
                             'intersectingTrianglePairs': {'all': int(len(xp)), 'involvingConstruction': x_con}}
    # 尺寸（见 measure_vulva）/ dimensions (see measure_vulva)
    stats['dimensions'] = measure_vulva(P[:n_spec], Fp[(Fp < n_spec).all(1)], shipped, fit['scale'])
    stats['dimensions'].update(surface_measures(centres, shipped, P[:n_spec]))
    rim_abs = float(np.median(np.abs(s[rim]))) / MM
    # 交给皮肤作者的目标：这一片的外缘（有序的环）、各点的位置和向外的法线，以及这一片在各 WU_* 结构上的覆盖厚度
    # the hand-off to the skin's author: the outer rim of the patch (an ordered loop) with positions and outward normals, and the cover the patch gives over each WU_* structure
    outer = ordered_loop(Fp) if disc else max(walk_loops(bedges), key=len)
    fnp = np.cross(P[Fp[:, 1]] - P[Fp[:, 0]], P[Fp[:, 2]] - P[Fp[:, 0]])
    vn = np.zeros_like(P)
    for k_ in range(3):
        np.add.at(vn, Fp[:, k_], fnp)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    # 向外 = 背离深层结构 / outward = away from the deep structures
    if np.mean(np.einsum('ij,ij->i', vn, P - ext.mean(0))) < 0:
        vn = -vn
    Pp, Fpp = np.ascontiguousarray(P), np.ascontiguousarray(Fp)
    need = {}
    kd = cKDTree(P)
    for p_ in parts:
        Q = np.ascontiguousarray(np.array(p_['positions']).reshape(-1, 3))
        d_ = np.sqrt(igl.point_mesh_squared_distance(Q, Pp, Fpp)[0])
        j_ = kd.query(Q)[1]
        side_ = np.einsum('ij,ij->i', Q - P[j_], vn[j_])
        need[p_['id']] = {'closestToPatchMm': round(float(d_.min()) / MM, 2), 'shareOfVerticesOnTheOuterSide': round(float((side_[d_ < 0.01] > 0).mean()) if (d_ < 0.01).any() else 0.0, 3)}
    n_cut_rim = int(sum(bool(on_cut[i]) for i in outer))
    KIND = ['edgeOfSelection', 'cutAboveThePlane', 'groove']
    rk = np.r_[rim_kind, np.zeros(len(P) - len(rim_kind), np.int64)]
    seg = np.linalg.norm(P[outer] - P[outer[1:] + outer[:1]], axis=1)
    kseg = np.maximum(rk[outer], rk[outer[1:] + outer[:1]])  # 一段边缘的种类：两端里编号大的 / the kind of a rim segment: the greater of its two ends
    by_kind = {}
    for k_, name_ in enumerate(KIND):
        m_ = kseg == k_
        row = {'points': int((rk[outer] == k_).sum()), 'lengthMm': round(float(seg[m_].sum()) / MM, 1)}
        if m_.any():
            zz = P[np.array(outer)[m_], 2]
            row['zRangeM'] = [round(float(zz.min()), 4), round(float(zz.max()), 4)]
            row['absDistanceFromPresentSkinMm'] = {'median': round(float(np.median(np.abs(s[np.array(outer)[rk[outer] == k_]]))) / MM, 1) if (rk[outer] == k_).any() else None}
        by_kind[name_] = row
    stats['rimByKind'] = {'what': {'edgeOfSelection': 'where the 35 mm selection of specimen skin ends (in front on the mons, behind in the cleft between the buttocks): real skin that simply continues',
                                   'cutAboveThePlane': 'a cut through real specimen skin %g mm above the specimen\'s cut plane: the wall of the cleft, or the bottom of a fold, continued below it. Not a natural border; it stands in for the groove where fold and thigh merge at the plane and along the cleft behind the folds. No surface was built there (constructed area 0)' % TRIM_ABOVE_PLANE_MM,
                                   'groove': 'where the wall lateral to the roof is cut off: along the top of the groove between fold and thigh (where the surface normal turns over), a natural border; behind the folds a few points lie on the wall of the cleft between the buttocks at the stated distance from its apex line instead'}, 'kinds': by_kind}
    target = {
        'what': {'zh': '女性会阴皮肤片（Wu 等 2015 标本的皮肤，按已装入的 WU_* 结构定位并平滑；片内被截面削出的小洞已用构造物补上）的外缘：皮肤作者把拟合皮肤的会阴抬高时要到达的位置。环是单一的、有序的；位置和法线在本体坐标系里（米，Y 向上，+Z 向前，+X 为身体左侧）；法线指向体外。这一片已收窄到裂的“顶”（两侧并拢的大腿内侧的壁已去掉，见 graft-report.json 的 vulva.narrowing）；rimLoop.kind 说明每个点属于哪种边缘：groove 是皱襞与大腿之间的沟（天然的边界），cutAboveThePlane 是在标本截面之上几毫米处沿真实皮肤切出的线（不是天然边界），edgeOfSelection 是所取皮肤范围的尽头（皮肤在那里照常延续）。onCutPlane 为 true 的点在标本皮肤块的截面上：那里的面是标本并拢的大腿内侧（或皱襞的外侧面）陡直向下延续的地方，不是真实的皮肤边缘，不要当作目标（见 cutPlaneRuns）。',
                 'en': 'The outer rim of the female perineal skin patch (the skin of the specimen of Wu et al. 2015, positioned by the installed WU_* structures and smoothed; small holes the cut plane sliced into the patch are closed by construction): where the crotch of the fitted skin has to arrive when its author raises it. The loop is single and ordered; positions and normals are in the body frame (metres, Y up, +Z anterior, +X the body\'s left); normals point out of the body. The patch is narrowed to the roof of the cleft (the walls on either side, the medial sides of the adducted thighs, are removed; see vulva.narrowing in graft-report.json); rimLoop.kind says what kind of rim each point is: groove is the groove between fold and thigh (a natural border), cutAboveThePlane a line cut through real skin a few millimetres above the specimen\'s cut plane (not a natural border), edgeOfSelection the end of the stretch of skin taken (the skin simply continues there). Points with onCutPlane true lie on a cut plane of the specimen slab: there the surface is the medial side of the specimen\'s adducted thighs (or the lateral face of a fold) running steeply on downwards; they are not a real edge of skin and are not targets (see cutPlaneRuns).'},
        'source': WU_SOURCE, 'toleranceForGraftingMm': max_rim_mm,
        'graftRule': 'grafted automatically only when (1) the rim lies a median of at most toleranceForGraftingMm from the present skin, (2) the patch is a disc with one boundary loop, (3) no part of the rim lies on a cut plane of the specimen and (4) no edge of the patch is used by more than two triangles; refused otherwise, with the reasons',
        'presentMismatchMm': {'medianAbs': round(rim_abs, 1), 'max': round(float(np.abs(s[rim]).max()) / MM, 1), 'sign': 'the patch lies inside the present skin (the present crotch is too low)'},
        'rimLoop': {'vertices': len(outer), 'isTheOnlyBoundaryLoop': disc, 'positions': [[round(float(v), 5) for v in P[i]] for i in outer], 'outwardNormals': [[round(float(v), 4) for v in vn[i]] for i in outer], 'onCutPlane': [bool(on_cut[i]) for i in outer], 'kind': [KIND[int(rk[i])] for i in outer], 'kinds': stats['rimByKind'],
                    'signedDistanceFromPresentSkinMm': [round(float(s[i]) / MM, 1) for i in outer], 'pointsOnACutPlane': n_cut_rim},
        'cutPlaneRuns': truncation,
        'coverOverDeepParts': {'what': 'closest approach of each installed WU_* anchor part to the patch (mm): the cover the patch gives, which a skin meeting this rim should not undercut', 'parts': need},
        'orifices': {k: {kk: v[kk] for kk in ('built', 'openingCentre', 'lumenEnd', 'lumenEndToSurfaceMm') if kk in v} for k, v in orifices.items()},
        'patchFile': 'vulva-patch.obj', 'patchGroups': {'vulvaSkin': 'specimen skin', 'vulvaClosure': 'construction closing holes on the cut plane', 'vulvaOrificeCanals': 'construction: blind canals from the surface to the ends of the lumina'},
    }
    os.makedirs(out_dir, exist_ok=True)
    json.dump(target, open(os.path.join(out_dir, 'vulva-rim-target.json'), 'w'), ensure_ascii=False, indent=1)
    stats['rimTarget'] = {'file': 'vulva-rim-target.json', 'loopVertices': len(outer), 'onCutPlane': n_cut_rim, 'singleLoop': disc}
    write_obj(os.path.join(out_dir, 'vulva-patch.obj'), Po, [g_ for g_ in groups if len(g_[1])], ['# perineal skin of the specimen of Wu et al. 2015 (CC BY 4.0), 46_Skin.obj, mapped to the installed WU_* parts and smoothed by tools/skinopen/vulva.py; groups vulvaClosure and vulvaOrificeCanals are construction, not specimen; metres, body frame'])
    # 检查图：单独的这一片，从下方、斜下方，以及过中线的矢状切片（带 WU_* 部件）；构造物用别的颜色
    # check render: the patch alone from below and obliquely, and a sagittal slab through the midline with the WU_* parts; construction in other colours
    xm = float(np.median(shipped['perineal_body'][:, 0])) if 'perineal_body' in shipped else 0.0
    c_ = [round(xm, 4), round(float(ext[:, 1].min()) - 0.005, 4), round(float(0.5 * (P[:, 2].min() + P[:, 2].max())), 4)]
    palette = [[190, 80, 80], [200, 120, 160], [230, 200, 90], [120, 170, 120], [110, 150, 200], [160, 120, 190], [220, 150, 90], [120, 190, 190]]
    items = [{'obj': 'vulva-patch.obj', 'color': [226, 178, 156], 'groups': ['vulvaSkin']}, {'obj': 'vulva-patch.obj', 'color': [90, 150, 230], 'groups': ['vulvaClosure']}, {'obj': 'vulva-patch.obj', 'color': [70, 190, 110], 'groups': ['vulvaOrificeCanals']}]
    items += [{'positions': p_['positions'], 'indices': p_['indices'], 'color': palette[i_ % len(palette)]} for i_, p_ in enumerate(parts)]
    half = round(float(0.55 * np.ptp(P[:, 2])), 4)
    views = [{'yaw': 0, 'pitch': -89, 'center': c_, 'halfHeight': half, 'width': 620, 'height': 620, 'items': [0, 1, 2]},
             {'yaw': 35, 'pitch': -50, 'center': c_, 'halfHeight': half, 'width': 620, 'height': 620, 'items': [0, 1, 2]},
             {'yaw': 0, 'pitch': 89, 'center': c_, 'halfHeight': half, 'width': 620, 'height': 620, 'items': [0, 1, 2]},
             {'yaw': 90, 'pitch': 0, 'center': [round(float(np.mean([v_[0] for v_ in centres.values()])), 4) if centres else c_[0], round(float(ext[:, 1].min()) + 0.022, 4), round(float(np.median(ext[:, 2])), 4)], 'halfHeight': 0.05, 'width': 620, 'height': 620, 'slab': [-0.003, 0.003]}]
    pk.render_specs['vulva'] = {'out': 'renders/vulva.png', 'columns': 4, 'items': items, 'views': views,
                                'note': 'the patch alone: from below, obliquely from below, from above (the inner side, showing the canals), and a sagittal slab 6 mm thick through the openings (anterior to the left or right according to the renderer; the canals run from the cleft up to the ends of the lumina) with the WU_* anchor parts; specimen skin in skin colour, closure blue, canals green'}
    reasons = []
    if rim_abs > max_rim_mm:
        reasons.append('the rim of the patch lies a median %.1f mm from the present skin (limit %.1f mm): the crotch of the fitted skin must first be raised to her perineal structures; a blend across this distance was not attempted' % (rim_abs, max_rim_mm))
    if not disc:
        reasons.append('the patch is not a disc with one boundary loop (loops: %s)' % loops_now)
    if n_cut_rim:
        reasons.append('%d of the %d points of its rim lie on a cut plane of the specimen slab; there the specimen surface runs on steeply below the plane (medial thighs of the adducted specimen, lateral faces of the folds) and cannot be closed by a small constructed surface, so the rim there is not a real edge of skin' % (n_cut_rim, len(outer)))
    if nm_all:
        reasons.append('%d edges of the patch are used by more than two triangles (they are in the specimen skin itself, where the walls of the midline cleft touch): the skin would not be a closed manifold' % nm_all)
    if reasons:
        stats['grafted'] = False
        stats['notGraftedBecause'] = '; '.join(reasons)
        pk.pending.append({
            'name': 'vulvaSkin', 'status': 'fitted, not grafted', 'file': 'vulva-patch.obj', 'rimTarget': 'vulva-rim-target.json', 'reason': stats['notGraftedBecause'],
            'source': WU_SOURCE,
            'construction': {'zh': '文件里的 vulvaClosure 和 vulvaOrificeCanals 两组是构造物，不是标本皮肤：前者补上皱襞最低处被标本截面削出的小洞（%d 个，共 %.1f mm²）；后者是从皮肤面通到阴道腔、尿道腔、直肠腔末端的盲管。构造物共 %.1f mm²，标本皮肤 %.1f mm²。' % (closure['holesClosed'], closure['areaMm2'], stats['construction']['areaMm2'], stats['construction']['specimenSkinAreaMm2']),
                             'en': 'The groups vulvaClosure and vulvaOrificeCanals of the file are construction, not specimen skin: the first closes the small holes the specimen\'s cut plane sliced into the lowest points of the folds (%d, %.1f mm² in all); the second are blind canals from the skin surface to the ends of the vaginal, urethral and rectal lumina. Construction %.1f mm² in all, specimen skin %.1f mm².' % (closure['holesClosed'], closure['areaMm2'], stats['construction']['areaMm2'], stats['construction']['specimenSkinAreaMm2'])},
            'what': {'zh': '女性会阴部皮肤（取自 Wu 等 2015 标本的皮肤面，按已装入的 WU_* 部件定位，去台阶平滑）。目前没有接进皮肤，原因见 reason。文件 vulva-patch.obj 是定位后的这一片。', 'en': 'The female perineal skin (the skin surface of the specimen of Wu et al. 2015, positioned by the installed WU_* parts and smoothed). Not grafted for now; see reason. vulva-patch.obj holds the positioned patch.'},
        })
    else:
        info, gstats, ids, geo = graft(pk, Po, Fo, ext, 'vulvaSkin', rigid_joint=None, tag_patch='graftScanned')
        pv_ = info.pop('_donorIndex')
        con = ids[ptag[pv_] > 0]
        pk.tags[con[pk.tags[con] != TAGS['graftBlend']]] = TAGS['graftConstruction']
        stats['grafted'] = True
        stats['graft'] = gstats
        info.update({'provenance': 'curated', 'source': WU_SOURCE, 'constructionVertices': [int(v) for v in con],
                     'what': {'zh': '女性会阴部皮肤：取自另一位女性标本（Wu 等 2015）的皮肤面，经放大、按骨配准并平滑，所以不是 scanned。constructionVertices 是构造物：皱襞最低处被标本截面削掉的小洞的封盖，以及通到阴道腔、尿道腔、直肠腔末端的盲管。', 'en': 'The female perineal skin: the skin surface of another woman\'s specimen (Wu et al. 2015), enlarged, fitted by bone and smoothed, hence not scanned. constructionVertices are construction: the caps over the small holes the specimen\'s cut plane sliced into the lowest points of the folds, and the blind canals to the ends of the vaginal, urethral and rectal lumina.'}})
        pk.grafts.append(info)
    pk.report['vulva'] = stats


def split_nonmanifold(P, F):
    """
    把被两个以上三角形共用的边拆开：这种边的端点处，围着它的三角形按“只经过恰好两个三角形共用的边相连”分成几簇，
    每多一簇就复制一个顶点（位置不变）。返回 (P, F, 每个顶点原来的下标, 剩下的非流形边数)。
    标本皮肤上这种边在中线裂两壁相贴的地方：两张面在那里共用了一条边。拆开后两张面仍然贴着，但各有各的顶点。
    Undoes edges shared by more than two triangles: at an end of such an edge the triangles round the vertex are
    grouped into fans connected through edges shared by exactly two triangles, and the vertex is duplicated (same
    position) for every fan beyond the first. Returns (P, F, the old index of every vertex, non-manifold edges left).
    In the specimen skin these edges are where the two walls of the midline cleft touch: two sheets share an edge
    there. Afterwards the sheets still touch but each has vertices of its own.
    """
    F = np.array(F, np.int64)
    n = len(P)
    E, cnt = unique_edges(F, n)
    bad = set(map(tuple, E[cnt > 2].tolist()))
    if not bad:
        return P, F, np.arange(n), 0
    origin = list(range(n))
    vf = {}
    for v in sorted(set(int(v) for e in bad for v in e)):
        vf[v] = np.where((F == v).any(1))[0]
    for v, fs in vf.items():
        # 围着 v 的三角形：经过含 v 的流形边相连 / triangles round v, connected through manifold edges containing v
        par = {int(f): int(f) for f in fs}

        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a

        by_other = {}
        for f in fs:
            for u in F[f]:
                if u != v:
                    by_other.setdefault(int(u), []).append(int(f))
        for u, lst in by_other.items():
            if len(lst) == 2 and (min(u, v), max(u, v)) not in bad:
                par[find(lst[0])] = find(lst[1])
        roots = sorted(set(find(int(f)) for f in fs))
        for r in roots[1:]:
            k = len(origin)
            origin.append(origin[v])
            for f in fs:
                if find(int(f)) == r:
                    F[f][F[f] == v] = k
    origin = np.array(origin)
    P2 = P[origin]
    left = int((unique_edges(F, len(P2))[1] > 2).sum())
    return P2, F, origin, left


def narrow_to_roof(P, F, on_cut, nc, plane_pt, xm):
    """
    把这一片收窄到裂的“顶”：不要两侧的壁（并拢的大腿内侧），外缘不落在标本的截面上。
      1. 非流形边拆开（split_nonmanifold）。
      2. 落在截面上的那段外缘：沿真实皮肤、在截面之上 TRIM_ABOVE_PLANE_MM 处切开（等值线切，三角形在自己的平面内被切）。
      3. 皱襞与大腿之间有沟的地方：沿沟切开，去掉沟外侧的大腿壁。壁 = 朝向中线、沿面离中线超过 WALL_FROM_MIDLINE_MM、
         并与第 2 步的切线连着的面；它的指示函数在面上平滑几次，取 0.5 等值线（落在沟顶法线转向的地方）。
    返回新的 (P, F, on_cut)、每个外缘顶点属于哪种边缘（kind）和报告。不构造任何面。
    Narrows the patch to the roof of the cleft: without the walls on either side (medial sides of the adducted
    thighs), and with no part of the outer rim on the specimen's cut plane.
      1. Non-manifold edges are undone (split_nonmanifold).
      2. The stretch of outer rim on the cut plane: cut through real skin TRIM_ABOVE_PLANE_MM above the plane (a cut along
         a level line; triangles are cut in their own plane).
      3. Where there is a groove between fold and thigh: cut along the groove, removing the thigh wall lateral to it.
         Wall = surface facing the midline, further than WALL_FROM_MIDLINE_MM from the midline along the surface and
         connected to the cut of step 2; its indicator is smoothed over the surface a few times and the 0.5 level line is
         taken (it lands where the normal turns over at the top of the groove).
    Returns the new (P, F, on_cut), the kind of rim each outer rim vertex belongs to, and a report. No surface is built.
    """
    n_in = len(P)
    P, F, origin, nm_left = split_nonmanifold(P, F)
    nm_split = len(P) - n_in
    on_cut = on_cut[origin]
    was_rim = np.zeros(len(P), bool)
    hm = half_edge_map(F)
    was_rim[[a for (a, b) in hm if (b, a) not in hm]] = True
    h = -(P - plane_pt) @ nc
    # 截面上的外缘（不算片内落在截面上的小洞）/ the outer rim on the plane (small holes of the patch on the plane are not counted)
    loops = walk_loops(np.array([(a, b) for (a, b) in hm if (b, a) not in hm]))
    small = set()
    for lp in loops:
        if len(lp) <= 12 and on_cut[lp].all():
            small.update(lp)
    op = np.array([v for v in np.where(was_rim & on_cut)[0] if v not in small], np.int64)
    if not len(op):
        raise RuntimeError('vulva: no part of the outer rim lies on a cut plane; nothing to narrow')
    E, _ = unique_edges(F, len(P))
    G = graph(len(P), E, np.linalg.norm(P[E[:, 0]] - P[E[:, 1]], axis=1))
    d_op = csgraph.dijkstra(G, indices=op, min_only=True)
    d_op = np.where(np.isfinite(d_op), d_op, 1.0)
    f1 = (h - TRIM_ABOVE_PLANE_MM * MM) + 0.5 * np.maximum(0.0, d_op - TRIM_REACH_MM * MM)
    f1[list(small)] = np.maximum(f1[list(small)], 1e-4)
    V1, Fp1, _, born1, _, _ = cut_by_level(P, F, f1)
    area = lambda V_, F_: np.linalg.norm(np.cross(V_[F_[:, 1]] - V_[F_[:, 0]], V_[F_[:, 2]] - V_[F_[:, 0]]), axis=1) / 2
    lab = face_components(Fp1, len(V1))
    main = np.argmax(np.bincount(lab, weights=area(V1, Fp1)))
    F1 = Fp1[lab == main]
    kind = np.zeros(len(V1), np.int64)  # 0 不在新切线上 / not on a new cut; 1 截面之上的切线 / the cut above the plane; 2 沟 / groove
    hm1 = half_edge_map(F1)
    rim1 = np.unique([a for (a, b) in hm1 if (b, a) not in hm1])
    old_rim = np.r_[was_rim, np.zeros(len(V1) - len(P), bool)]
    kind[rim1[~old_rim[rim1]]] = 1
    # 壁：朝向中线、离中线远、与第 2 步的切线连着 / walls: facing the midline, far from it, connected to the cut of step 2
    fn = np.cross(V1[F1[:, 1]] - V1[F1[:, 0]], V1[F1[:, 2]] - V1[F1[:, 0]])
    vn = np.zeros_like(V1)
    for k in range(3):
        np.add.at(vn, F1[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    used1 = np.zeros(len(V1), bool)
    used1[F1] = True
    if (vn[used1] @ nc).mean() < 0:
        vn = -vn  # 外法线：顶朝尾侧 / outward normals: the roof faces caudally
    E1, _ = unique_edges(F1, len(V1))
    G1 = graph(len(V1), E1, np.linalg.norm(V1[E1[:, 0]] - V1[E1[:, 1]], axis=1))
    # 中线取这一片自己的：每 4 mm 一片，中央 ±12 mm 以内最高的那一点（裂的顶），沿前后方向取中值后插值。
    # 深层结构的中位 x 不能用：标本的裂偏在它的一侧几毫米。
    # The midline is taken from the patch itself: in slices of 4 mm, the highest point within ±12 mm of the centre (the apex
    # of the cleft), median-filtered along the fore-aft direction and interpolated. The median x of the deep structures
    # will not do: the specimen's cleft lies a few millimetres to one side of it.
    xc = float(np.median(V1[used1, 0]))
    h1 = -(V1 - plane_pt) @ nc
    zs, xa = [], []
    for z0 in np.arange(V1[used1, 2].min(), V1[used1, 2].max(), 0.004):
        m_ = np.where(used1 & (V1[:, 2] >= z0) & (V1[:, 2] < z0 + 0.004) & (np.abs(V1[:, 0] - xc) < 0.012))[0]
        if len(m_):
            zs.append(z0 + 0.002)
            xa.append(V1[m_[np.argmax(h1[m_])], 0])
    xa = np.array(xa)
    xa = np.array([np.median(xa[max(0, i - 2):i + 3]) for i in range(len(xa))])
    xm = np.interp(V1[:, 2], np.array(zs), xa)
    mid = np.where(used1 & (np.abs(V1[:, 0] - xm) < 2.5 * MM))[0]
    g = csgraph.dijkstra(G1, indices=mid, min_only=True)
    g = np.where(np.isfinite(g), g, 1.0)
    lateral = np.sign(V1[:, 0] - xm)
    wall0 = used1 & (vn[:, 0] * lateral < WALL_FACING) & (g > WALL_FROM_MIDLINE_MM * MM)
    A1 = graph(len(V1), E1, np.ones(len(E1)))
    idx = np.where(wall0)[0]
    _, wl = csgraph.connected_components(A1[idx][:, idx], directed=False)
    touch = np.unique(wl[np.isin(idx, rim1[kind[rim1] == 1])])
    wall = np.zeros(len(V1), bool)
    wall[idx[np.isin(wl, touch)]] = True
    w = wall.astype(np.float64)
    deg = np.maximum(np.asarray(A1.sum(1)).ravel(), 1)
    for _ in range(3):
        w = 0.5 * w + 0.5 * (A1 @ w) / deg
    if os.environ.get('SKINOPEN_DEBUG'):
        np.savez(os.path.join(os.environ['SKINOPEN_DEBUG'], 'vulva-debug.npz'), V1=V1, F1=F1, wall0=wall0, wall=wall, w=w, g=g, vn=vn, P=P, F=F, f1=f1, xm=xm, h=h)
    V2, Fp2, Fn2, born2, _, _ = cut_by_level(V1, F1, 0.5 - w)
    lab2 = face_components(Fp2, len(V2))
    main2 = np.argmax(np.bincount(lab2, weights=area(V2, Fp2)))
    isl = islands(Fp2[lab2 == main2], Fn2, face_components(Fn2, len(V2)), len(V2)) if len(Fn2) else np.zeros(0, bool)
    # 被圈在里面的小岛并回去；大块的壁不并 / islets enclosed by the kept piece are returned to it; the large pieces of wall are not
    if len(Fn2):
        ln2 = face_components(Fn2, len(V2))
        touch_rim = np.zeros(len(V2), bool)
        touch_rim[rim1] = True
        keep_isl = np.zeros(len(Fn2), bool)
        for c in np.unique(ln2[isl]):
            m = ln2 == c
            if not touch_rim[Fn2[m]].any():
                keep_isl |= m
        F2 = np.vstack([Fp2[lab2 == main2], Fn2[keep_isl]])
    else:
        F2 = Fp2[lab2 == main2]
    kind = np.r_[kind, np.zeros(len(V2) - len(V1), np.int64)]
    hm2 = half_edge_map(F2)
    rim2 = np.unique([a for (a, b) in hm2 if (b, a) not in hm2])
    was1 = np.zeros(len(V2), bool)
    was1[rim1] = True
    kind[rim2[~was1[rim2]]] = 2
    # 压缩顶点编号 / compact the vertex numbering
    keep = np.unique(F2)
    remap = -np.ones(len(V2), np.int64)
    remap[keep] = np.arange(len(keep))
    Pn, Fn_ = V2[keep], remap[F2]
    on_cut_n = np.r_[on_cut, np.zeros(len(V2) - len(P), bool)][keep]
    kind_n = kind[keep]
    a_in, a_out = float(area(P, F).sum()), float(area(Pn, Fn_).sum())
    rep = {'what': 'the patch narrowed to the roof of the cleft: no wall of the cleft lateral to a groove, no rim on the cut plane; nothing is built, real specimen skin is only cut away',
           'rules': {'cutAboveThePlane': 'within %g mm (along the surface) of the stretch of outer rim on the cut plane, the surface less than %g mm above the plane is cut away along that level line' % (TRIM_REACH_MM, TRIM_ABOVE_PLANE_MM),
                     'groove': 'wall = surface whose outward normal has a lateral component below %g (i.e. facing the midline), lying more than %g mm along the surface from the midline band (within 2.5 mm of the apex line of the cleft, taken from the patch itself) and connected to the cut above the plane; its indicator is averaged over the mesh 3 times and the patch is cut along the 0.5 level line' % (WALL_FACING, WALL_FROM_MIDLINE_MM)},
           'nonManifoldEdges': {'verticesDuplicatedToUndoThem': int(nm_split), 'left': int(nm_left)},
           'specimenSkinAreaMm2': {'before': round(a_in / MM ** 2, 1), 'kept': round(a_out / MM ** 2, 1), 'cutAway': round((a_in - a_out) / MM ** 2, 1)},
           'pointsPutOnSpecimenEdgesByTheCuts': int((keep >= len(P)).sum())}
    return Pn, Fn_, on_cut_n, kind_n, rep


def walk_loops(bedges):
    """边界边连成的各条链 / the chains the boundary edges form"""
    nxt = {}
    for a_, b_ in bedges:
        nxt.setdefault(int(a_), []).append(int(b_))
    loops, seen = [], set()
    for st in sorted(nxt):
        if st in seen:
            continue
        lp, cur = [st], st
        seen.add(st)
        while True:
            cand = [q for q in nxt.get(cur, []) if q not in seen]
            if not cand:
                break
            cur = cand[0]
            seen.add(cur)
            lp.append(cur)
        loops.append(lp)
    return loops


def cut_plane_runs(P, F, on_cut, nc, plane_pt):
    """
    这一片的边界落在标本截面上的各段：在哪里、面与截面的夹角、面朝截面转弯的曲率，以及按等曲率外推，它在截面之外还要走多深才合拢。
    The stretches of the patch boundary that lie on the specimen's cut plane: where they are, the angle between surface and
    plane, the curvature with which the surface turns towards the plane and, extrapolating with that curvature held
    constant, how far beyond the plane it would run before closing.
    """
    hm = half_edge_map(F)
    be = np.array([(a, b) for (a, b) in hm if (b, a) not in hm])
    ce = be[on_cut[be].all(1)]
    if not len(ce):
        return {'runs': [], 'note': 'no boundary edge on a cut plane'}
    fn = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
    vn = np.zeros_like(P)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    phi = np.degrees(np.arccos(np.clip(vn @ nc, -1, 1)))  # 0° = 面朝尾侧（皱襞的底）；90° = 竖直的壁 / 0° = facing caudally (the bottom of a fold); 90° = a vertical wall
    E, _ = unique_edges(F, len(P))
    G = graph(len(P), E, np.linalg.norm(P[E[:, 0]] - P[E[:, 1]], axis=1))
    n, lab = csgraph.connected_components(graph(len(P), ce, np.ones(len(ce))), directed=False)
    runs = []
    for c in np.unique(lab[ce[:, 0]]):
        vs = np.unique(ce[lab[ce[:, 0]] == c])
        ee = ce[lab[ce[:, 0]] == c]
        dist, _, src = csgraph.dijkstra(G, indices=vs, min_only=True, return_predecessors=True)
        up = np.where((dist > 0.004) & (dist < 0.007))[0]
        closed = len(ee) == len(vs)
        row = {'boundaryEdges': int(len(ee)), 'closedLoop': bool(closed), 'lengthMm': round(float(np.linalg.norm(P[ee[:, 0]] - P[ee[:, 1]], axis=1).sum()) / MM, 1),
               'centre': [round(float(v), 4) for v in P[vs].mean(0)], 'from': [round(float(v), 4) for v in P[vs].min(0)], 'to': [round(float(v), 4) for v in P[vs].max(0)],
               'side': 'left' if P[vs, 0].mean() > 0.004 else 'right' if P[vs, 0].mean() < -0.004 else 'midline',
               'surfaceToPlaneAngleDeg': {'what': 'angle between the outward surface normal at the rim and the caudal normal of the plane: 0 = the bottom of a fold facing down, 90 = a vertical wall', 'median': round(float(np.median(phi[vs])), 0), 'p10': round(float(np.percentile(phi[vs], 10)), 0), 'p90': round(float(np.percentile(phi[vs], 90)), 0)}}
        shallow = vs[phi[vs] < 45]
        if closed:
            rad = float(np.linalg.norm(P[vs] - P[vs].mean(0), axis=1).mean())
            h = rad * np.tan(np.radians(min(float(np.median(phi[vs])), 80.0)) / 2)
            row['kind'] = 'a closed facet: the lowest point of a fold, sliced off by the plane'
            row['estimatedContinuationBeyondThePlaneMm'] = {'value': round(h / MM, 2), 'range': [round(0.5 * h / MM, 2), round(2 * h / MM, 2)], 'rule': 'sagitta of a circular arc over the facet (mean radius %.1f mm) leaving its rim at the angle the surface has there' % (rad / MM)}
            runs.append(row)
            continue
        if len(shallow):
            # 这一段里面朝下的部分（夹角 < 45°）：成对皱襞的底贴着截面的地方 / the part of the run that faces down (angle < 45°): where the bottom of a paired fold lies against the plane
            row['partFacingDown'] = {'what': 'rim vertices where the angle is under 45°: the bottom of a paired fold lying against the plane, its lowest part sliced off and merged with the cut face of the thigh', 'vertices': int(len(shallow)), 'from': [round(float(v), 4) for v in P[shallow].min(0)], 'to': [round(float(v), 4) for v in P[shallow].max(0)], 'medianAngleDeg': round(float(np.median(phi[shallow])), 0)}
        if len(up):
            # 曲率：离边缘 4–7 mm 处的夹角与边缘处的夹角之差 ÷ 弧长；正 = 朝合拢的方向转
            # curvature: the angle 4–7 mm up the surface minus the angle at the rim, per arc length; positive = turning towards closing
            kap = np.radians(np.median(phi[up]) - np.median(phi[vs])) / float(np.median(dist[up]))
            row['turningTowardsClosingRadPerMm'] = round(float(kap) * MM, 4)
            ph0 = np.radians(float(np.median(phi[vs])))
            if kap * MM > 0.01:
                r = 1.0 / kap
                h = r * (1 - np.cos(ph0))
                row['estimatedContinuationBeyondThePlaneMm'] = {'value': round(float(h) / MM, 1), 'range': [round(float(0.5 * h) / MM, 1), round(float(2 * h) / MM, 1)], 'radiusOfCurvatureMm': round(float(r) / MM, 1)}
                row['kind'] = 'the surface is turning towards the plane: a fold whose bottom the plane sliced off'
            else:
                row['estimatedContinuationBeyondThePlaneMm'] = None
                row['kind'] = 'the surface meets the plane steeply and is not turning towards closing: it runs on below the plane (medial side of an adducted thigh or buttock, or the lateral face of a fold); no closing depth can be estimated'
        runs.append(row)
    runs.sort(key=lambda r: -r['lengthMm'])
    return {'what': 'stretches of the patch boundary on the caudal cut plane of the specimen slab', 'runs': runs,
            'estimate': 'continuation = r (1 − cos φ) with r the radius of curvature measured over the last 4–7 mm of surface above the plane and φ the angle at the plane, i.e. the same curvature continued until the surface faces straight down. This is an extrapolation of a few millimetres of stair-stepped, smoothed surface; the range given is a factor of two either way and is a judgement, not a measured error',
            'reading': 'in this specimen the thighs are adducted and the vulva and perineum form the roof of a narrow cleft between them; the plane cuts the walls of that cleft all along, and touches the lowest points of the paired folds of the roof'}


def close_inner_loops(P, F, on_cut, nc):
    """
    除最长的外缘以外的边界环（都很小、都在截面上）各用一个光顺的盖封上：环心加一个顶点，放在沿环的切向延续出去的高度上。
    Every boundary loop except the longest (the outer rim) — all small and all on the cut plane — is closed with a cap: one
    vertex at the centre of the loop, placed at the height the surface reaches when continued tangentially from the loop.
    """
    hm = half_edge_map(F)
    be = np.array([(a, b) for (a, b) in hm if (b, a) not in hm])
    nxt = {int(a): int(b) for a, b in be}
    loops, seen = [], set()
    for st in sorted(nxt):
        if st in seen:
            continue
        lp, cur = [st], nxt[st]
        seen.add(st)
        while cur != st and cur not in seen:
            lp.append(cur)
            seen.add(cur)
            cur = nxt[cur]
        loops.append(lp)
    loops.sort(key=len)
    fn = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
    vn = np.zeros_like(P)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    newP, newF, rows, area = [], [], [], 0.0
    for lp in loops[:-1]:
        c = P[lp].mean(0)
        rad = float(np.linalg.norm(P[lp] - c, axis=1).mean())
        # 盖顶的高度：按环上的面与截面的夹角，圆弧合拢的矢高 / the height of the cap: the sagitta of a circular arc closing at the angle the surface has at the loop
        ph = np.radians(float(np.median(np.degrees(np.arccos(np.clip(vn[lp] @ nc, -1, 1))))))
        h = rad * np.tan(min(ph, np.radians(80)) / 2)
        apex = c + h * nc
        k = len(P) + len(newP)
        newP.append(apex)
        tris = [[lp[(i + 1) % len(lp)], lp[i], k] for i in range(len(lp))]
        newF += tris
        a_ = sum(float(np.linalg.norm(np.cross(P[t[1]] - P[t[0]], apex - P[t[0]])) / 2) for t in tris)
        area += a_
        rows.append({'loopEdges': len(lp), 'onTheCutPlane': bool(on_cut[lp].all()), 'centre': [round(float(v), 4) for v in c], 'meanRadiusMm': round(rad / MM, 2), 'surfaceToPlaneAngleDeg': round(float(np.degrees(ph)), 0), 'capHeightBeyondThePlaneMm': round(float(h) / MM, 2), 'areaMm2': round(a_ / MM ** 2, 1)})
    if not newP:
        return P, F, {'holesClosed': 0, 'areaMm2': 0.0, 'caps': []}
    return np.vstack([P, np.array(newP)]), np.vstack([F, np.array(newF)]), {
        'what': 'holes of the patch other than its outer rim, closed by construction (tag graftConstruction if grafted; group vulvaClosure of vulva-patch.obj): one apex vertex per hole, at the sagitta of a circular arc that leaves the rim of the hole at the angle the specimen surface has there',
        'holesClosed': len(rows), 'areaMm2': round(area / MM ** 2, 1), 'caps': rows}


def open_orifice(P, F, L, nc, n_spec, surface_radius_mm=4.0, ring_mm=2.5):
    """
    从腔 L 的末端沿它的轴线到皮肤面，造一条盲管：皮肤面上挖一个洞（半径不超过 surface_radius_mm，也不超过腔末端的等效半径），
    洞缘与腔末端的截面（椭圆）之间布若干圈顶点，末端用一个扇形封住。返回新的顶点、三角形、盲管的三角形和报告。
    A blind canal from the end of lumen L along its axis to the skin surface: a hole is cut in the surface (radius at most
    surface_radius_mm and at most the equivalent radius of the lumen's end), rings of vertices run from its rim to the
    cross-section of the lumen's end (an ellipse), and a fan closes the deep end. Returns the new vertices and triangles,
    the triangles of the canal and a report.
    """
    t = L @ nc
    tip_slab = L[t > t.max() - 0.003]
    deeper = L[(t < t.max() - 0.006) & (t > t.max() - 0.014)]
    if len(deeper) < 3:
        return None, None, None, {'built': False, 'reason': 'the lumen has no stretch 6–14 mm above its end to take an axis from'}
    a = tip_slab.mean(0) - deeper.mean(0)
    a /= np.linalg.norm(a)
    sa = (L - tip_slab.mean(0)) @ a
    tip = tip_slab.mean(0) + sa.max() * a
    sec = L[(sa > sa.max() - 0.006) & (sa < sa.max() - 0.002)]  # 末端之上 2–6 mm 的一段：避开收尖的端头 / the stretch 2–6 mm above the end, clear of the tapering tip
    e1 = np.cross(a, [0.0, 0.0, 1.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(a, e1)
    q = np.stack([(sec - tip) @ e1, (sec - tip) @ e2], 1)
    q -= q.mean(0)
    r1, r2 = (np.percentile(q, 95, axis=0) - np.percentile(q, 5, axis=0)) / 2
    r1, r2 = max(float(r1), 0.0005), max(float(r2), 0.0005)
    info = {'lumenEnd': [round(float(v), 4) for v in tip], 'axis': [round(float(v), 3) for v in a], 'lumenEndCrossSectionMm': {'transverse': round(2 * r1 / MM, 1), 'foreAft': round(2 * r2 / MM, 1), 'what': 'full extent (5th–95th percentile) of the lumen 2–6 mm above its end, across its axis'}}
    # 开口放在皮肤面上离腔末端最近的那一点（中线裂的顶）。腔的轴线延长出去不一定碰得到那条只有两三毫米宽的裂，所以不用轴线求交。
    # the opening goes where the skin surface is closest to the lumen's end (the apex of the midline cleft). The lumen's axis continued need not
    # meet a cleft two or three millimetres wide, so no ray along the axis is used.
    # 只在标本皮肤的顶点里找（不找已经造好的别的盲管）/ searched among the vertices of the specimen skin only (not among canals already built)
    cand_v = np.unique(F[(F < n_spec).all(1)])
    near_v = int(cand_v[np.argmin(np.linalg.norm(P[cand_v] - tip, axis=1))])
    centre = P[near_v]
    t_hit = float(np.linalg.norm(centre - tip))
    ac = (centre - tip) / t_hit
    info.update({'openingCentre': [round(float(v_), 4) for v_ in centre], 'lumenEndToSurfaceMm': round(t_hit / MM, 1), 'angleBetweenCanalAndLumenAxisDeg': round(float(np.degrees(np.arccos(np.clip(ac @ a, -1, 1)))), 0)})
    if t_hit > 0.03:
        info.update({'built': False, 'reason': 'the lumen ends %.1f mm from the patch: too far for an opening to be placed from it' % (t_hit / MM)})
        return None, None, None, info
    rho = min(surface_radius_mm * MM, float(np.sqrt(r1 * r2)))
    H = (np.linalg.norm(P - centre, axis=1) < rho) & (np.arange(len(P)) < n_spec)
    E, _ = unique_edges(F, len(P))
    A = graph(len(P), E, np.ones(len(E)))
    H[near_v] = True
    idx = np.where(H)[0]
    _, lab = csgraph.connected_components(A[idx][:, idx], directed=False)
    H[:] = False
    H[idx[lab == lab[np.where(idx == near_v)[0][0]]]] = True
    loop = None
    for trial in (H, np.isin(np.arange(len(P)), [near_v])):
        rem = trial[F].any(1)
        try:
            loop = ordered_loop(F[rem])
            break
        except RuntimeError:
            continue
    if loop is None:
        info.update({'built': False, 'reason': 'no simple hole could be cut round the point where the axis meets the surface'})
        return None, None, None, info
    n = len(loop)
    ring0 = P[loop]
    f1 = e1 - (e1 @ ac) * ac
    f1 /= np.linalg.norm(f1)
    f2 = np.cross(ac, f1)
    rel = ring0 - ring0.mean(0)
    ang = np.arctan2(rel @ f2, rel @ f1)
    seg = np.linalg.norm(ring0 - np.roll(ring0, -1, 0), axis=1)
    frac = np.r_[0, np.cumsum(seg)[:-1]] / seg.sum()
    sgn = 1.0 if np.sum(np.sin(np.roll(ang, -1) - ang)) > 0 else -1.0
    th = ang[0] + sgn * 2 * np.pi * frac
    end_ring = tip + r1 * np.cos(th)[:, None] * e1 + r2 * np.sin(th)[:, None] * e2
    m = max(2, int(np.ceil(t_hit / (ring_mm * MM))))
    newP, rings = [], [np.array(loop)]
    base = len(P)
    for k in range(1, m + 1):
        s_ = k / m
        w = s_ * s_ * (3 - 2 * s_)  # 管径由洞口平滑过渡到腔的截面 / the bore eases from the hole to the lumen's cross-section
        ctr = ring0.mean(0) * (1 - s_) + tip * s_
        shape = (ring0 - ring0.mean(0)) * (1 - w) + (end_ring - tip) * w
        newP.append(ctr + shape)
        rings.append(np.arange(base + (k - 1) * n, base + k * n))
    apex = base + m * n
    tris = []
    for k in range(m):
        A_, B_ = rings[k], rings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            tris += [[A_[i], A_[j], B_[i]], [A_[j], B_[j], B_[i]]]
    tris += [[rings[m][i], rings[m][(i + 1) % n], apex] for i in range(n)]
    Pn = np.vstack([P] + newP + [tip[None]])
    canal = np.array(tris)
    Fn = np.vstack([F[~rem], canal])
    hole_r = float(np.linalg.norm(ring0 - ring0.mean(0), axis=1).mean())
    info.update({'built': True, 'specimenTrianglesRemoved': int(rem.sum()), 'specimenVerticesRemoved': int((~np.isin(np.arange(len(P)), np.unique(F[~rem])) & np.isin(np.arange(len(P)), np.unique(F[rem]))).sum()),
                 'openingAtTheSurface': {'rimVertices': n, 'meanRadiusMm': round(hole_r / MM, 2), 'rule': 'the surface vertex closest to the lumen end and the surface vertices within min(%g mm, equivalent radius of the lumen end) of it; the cleft is closed in the specimen, so a wider hole would remove the surfaces of the folds' % surface_radius_mm},
                 'canal': {'rings': m, 'lengthMm': round(t_hit / MM, 1), 'vertices': int(m * n + 1), 'triangles': int(len(canal)), 'deepEnd': 'an ellipse of the lumen\'s end cross-section at the lumen\'s end, closed by a fan (the canal is blind: the skin stays closed)'},
                 'whatWasBuilt': 'construction only: a hole in the specimen surface at its closest point to the lumen\'s end, a canal widening smoothly from that hole to the cross-section of the lumen\'s end, and a cap there. No orifice is visible on the specimen skin; position and bore come from the lumen, not from the skin'})
    return Pn, Fn, canal, info


def surface_measures(centres, shipped, P):
    """用构造的开口中心量的几个距离，并说明各自对应 Kreklau 2018 的哪一项 / distances between the constructed opening centres, each with the item of Kreklau 2018 it corresponds to"""
    out = {}
    d = lambda a, b: round(float(np.linalg.norm(a - b)) / MM, 1)
    cl = shipped.get('cavernous_body_of_clitoris')
    if cl is not None and 'urethralOrifice' in centres:
        xm = float(np.median(cl[:, 0]))
        mid_c = cl[np.abs(cl[:, 0] - xm) < 0.006]
        tip = mid_c[np.argmax(mid_c[:, 2] - mid_c[:, 1])]
        surf = P[np.argmin(np.linalg.norm(P - tip, axis=1))]
        out['clitoralBodyEndToUrethralOpening'] = {'what': 'from the skin point nearest the antero-inferior end of the corpus cavernosum of the clitoris to the centre of the constructed urethral opening (straight line)', 'mm': d(surf, centres['urethralOrifice']), 'skinOverTheClitoralBodyEndMm': d(surf, tip),
                                                   'correspondsTo': 'Kreklau: clitoris to urethral orifice, 22.6 ± 7.7 mm', 'caveat': 'the glans of the clitoris cannot be identified on the skin; the skin point over the end of the corpus cavernosum stands in for it, and the urethral opening is constructed from the lumen'}
    if 'vaginalOrifice' in centres and 'analOrifice' in centres:
        out['vaginalOpeningToAnalOpening'] = {'what': 'centre of the constructed vaginal opening to centre of the constructed anal opening (straight line)', 'mm': d(centres['vaginalOrifice'], centres['analOrifice']),
                                              'correspondsTo': 'none exactly. Kreklau\'s perineum (21.3 ± 8.5 mm) runs from the posterior margin of the introitus to the anus; this figure is centre to centre and so includes the posterior half of the introitus and the anterior half of the anal opening', 'caveat': 'both openings are constructed; the posterior fourchette cannot be identified on the skin'}
    if 'vaginalOrifice' in centres and 'urethralOrifice' in centres:
        out['urethralOpeningToVaginalOpening'] = {'what': 'centre of the constructed urethral opening to centre of the constructed vaginal opening (straight line)', 'mm': d(centres['urethralOrifice'], centres['vaginalOrifice']), 'correspondsTo': 'none of the published items'}
    out['correspondence'] = {
        'labiaMajoraLength (79.7 ± 15.3)': 'none. The paired folds beside the midline cleft cannot be named (labia majora, labia minora, or both pressed together between the adducted thighs); "cleft.lengthMm" is the length of the cleft between them and is not this measurement',
        'labiaMinoraLength (42.5 ± 16.3)': 'none: inner folds cannot be told from outer folds on this surface',
        'labiaMinoraWidth (13.8 ± 7.8)': 'none, for the same reason',
        'clitorisToUrethralOrifice (22.6 ± 7.7)': 'clitoralBodyEndToUrethralOpening (a stand-in, see its caveat); clitoralBodyToUrethralEnd is the same distance between deep structures',
        'introitus (27.9 ± 10.4)': 'none. vaginalLumenLowerEnd gives the cross-section of the lumen at its end, which is a deep structure 13 mm from the surface and not the introitus; the definition of the published item was not opened',
        'perineum (21.3 ± 8.5)': 'vaginalOpeningToAnalOpening is the nearest (centre to centre, so longer by construction); the older "perineum" entry is unreliable and is kept only for the record',
    }
    out['identification'] = {'zh': '在这张皮肤上能认出的：一条中线裂，两侧各一条成对的皱襞，再外侧是并拢的大腿内侧（裂两侧的壁）；裂向后延续为臀间的窄缝。认不出的：大阴唇与小阴唇的分界（内外皱襞分不开）、阴蒂头、阴蒂包皮、尿道口、阴道口、处女膜缘、阴唇后联合、肛门。因此这里不给皱襞起名。',
                             'en': 'What can be identified on this skin: a midline cleft, one fold on either side of it (paired), and lateral to them the medial sides of the adducted thighs (the walls of the cleft); the cleft runs back into the narrow gap between the buttocks. What cannot: the boundary between labia majora and labia minora (inner and outer folds cannot be told apart), the glans and prepuce of the clitoris, the urethral and vaginal orifices, the hymenal ring, the posterior commissure, the anus. The folds are therefore not named here.'}
    return out


def measure_vulva(P, F, shipped, scale, enlarged=1.096):
    """
    能量的量：从下方看（−Y 朝外），沿前后方向（Z）每 2 mm 一片，量中线处裂的深度和两侧隆起的顶。
    标本的皮肤只标为 “Skin”，没有开口，也没有标出唇：这里只报告几何上能定义的量，并说明哪些认不出来。
    What can be measured: seen from below (−Y outward), in slices of 2 mm along the fore-aft direction (Z), the
    depth of the cleft at the midline and the crests of the folds beside it. The specimen's skin is labelled
    only "Skin", has no opening and no labelled labia: only geometrically definable quantities are reported,
    with a statement of what cannot be identified.
    """
    xm = float(np.median(np.concatenate([shipped[k] for k in ('perineal_body', 'external_anal_sphincter', 'cavernous_body_of_clitoris') if k in shipped])[:, 0]))
    rows = []
    for z0 in np.arange(P[:, 2].min(), P[:, 2].max(), 0.002):
        sl = P[(P[:, 2] >= z0) & (P[:, 2] < z0 + 0.002)]
        mid = sl[np.abs(sl[:, 0] - xm) < 0.004]
        L = sl[(sl[:, 0] - xm > 0.004) & (sl[:, 0] - xm < 0.035)]
        R = sl[(xm - sl[:, 0] > 0.004) & (xm - sl[:, 0] < 0.035)]
        if len(mid) and len(L) and len(R):
            iL, iR = np.argmin(L[:, 1]), np.argmin(R[:, 1])
            rows.append((z0 + 0.001, mid[:, 1].max() - (L[iL, 1] + R[iR, 1]) / 2, L[iL, 0] - R[iR, 0]))
    rows = np.array(rows)
    out = {'kreklau2018': KREKLAU, 'scaleOfTheMapFromTheObjFiles': scale,
           'note': {'zh': '数值都是装入后的尺寸，核对也用装入尺寸。映射是各向异性的（总体 %.3f）：管线先把标本放大 %.3f 倍，骨架标准化又把骨盆在宽度上缩到 0.886；所以 specimenScale（除以 %.3f）只是粗略的参考，横向的量不适用。' % (scale, enlarged, enlarged), 'en': 'All figures are at installed size, and the checks use the installed size. The map is anisotropic (%.3f overall): the pipeline enlarges the specimen %.3f times and the standardisation of the skeleton then narrows the pelvis to 0.886 in width; specimenScale (division by %.3f) is therefore only a rough guide and does not hold for transverse quantities.' % (scale, enlarged, enlarged)}}
    scale = enlarged
    if len(rows):
        deep_ = rows[rows[:, 1] > 0.003]
        if len(deep_):
            # 最长的连续一段 / the longest contiguous run
            runs, start = [], 0
            for i in range(1, len(deep_) + 1):
                if i == len(deep_) or deep_[i, 0] - deep_[i - 1, 0] > 0.0045:
                    runs.append((start, i))
                    start = i
            a, b = max(runs, key=lambda r: deep_[r[1] - 1, 0] - deep_[r[0], 0])
            run = deep_[a:b]
            length = float(run[-1, 0] - run[0, 0] + 0.002)
            out['cleft'] = {'what': 'midline cleft at least 3 mm deep between the fold crests on either side (fore-aft extent, crest-to-crest width, depth)',
                            'lengthMm': round(length / MM, 1), 'specimenScaleLengthMm': round(length / MM / scale, 1), 'greatestDepthMm': round(float(run[:, 1].max()) / MM, 1), 'medianCrestSeparationMm': round(float(np.median(run[:, 2])) / MM, 1),
                            'compareWith': 'labia majora length (Kreklau 79.7 ± 15.3): the cleft between the outer folds is the nearest measurable quantity, not the same measurement'}
            anus = shipped.get('external_anal_sphincter')
            if anus is not None:
                lo = anus[anus[:, 1] < np.percentile(anus[:, 1], 10)].mean(0)
                d = float(run[0, 0] - lo[2])
                out['perineum'] = {'what': 'fore-aft distance from the posterior end of the cleft to the lowest part of the external anal sphincter (the anus is not an opening or a marked point on the specimen skin)', 'mm': round(d / MM, 1), 'specimenScaleMm': round(d / MM / scale, 1), 'compareWith': 'perineum (Kreklau 21.3 ± 8.5)', 'reliability': 'low: the posterior end of the cleft is not a defined landmark on this surface, and the figure is far outside the published range; do not use it'}
    cl, ur, vg = shipped.get('cavernous_body_of_clitoris'), shipped.get('submucous_layer_of_urethra'), shipped.get('uterine_and_vaginal_lumen')
    if cl is not None and ur is not None:
        # 阴蒂体的最前下端 → 尿道下端 / the antero-inferior end of the clitoral body → the lower end of the urethra
        mid_c = cl[np.abs(cl[:, 0] - xm) < 0.006]
        tip = mid_c[np.argmax(mid_c[:, 2] - mid_c[:, 1])]
        uend = ur[ur[:, 1] < ur[:, 1].min() + 0.002].mean(0)
        d = float(np.linalg.norm(tip - uend))
        out['clitoralBodyToUrethralEnd'] = {'what': 'from the antero-inferior end of the corpus cavernosum of the clitoris (deep part; the glans is not a separate structure) to the lower end of the submucous layer of the urethra (deep part; no urethral orifice on the skin)', 'mm': round(d / MM, 1), 'specimenScaleMm': round(d / MM / scale, 1), 'compareWith': 'clitoris to urethral orifice (Kreklau 22.6 ± 7.7): deep-structure distance, not the surface measurement'}
    if vg is not None:
        low = vg[vg[:, 1] < vg[:, 1].min() + 0.005]
        out['vaginalLumenLowerEnd'] = {'what': 'transverse and fore-aft extent of the lowest 5 mm of the vaginal lumen (deep part; the introitus is not open on the skin)', 'transverseMm': round(float(np.ptp(low[:, 0])) / MM, 1), 'foreAftMm': round(float(np.ptp(low[:, 2])) / MM, 1), 'compareWith': 'introitus (Kreklau 27.9 ± 10.4): not the same measurement'}
    out['notIdentified'] = {'zh': '小阴唇的长和宽没有量：标本皮肤上中线两侧各有成对的皱襞，但表面是台阶状的、没有标注，无法可靠地把内侧皱襞与外侧皱襞分开；阴蒂头、尿道口、阴道口、肛门在皮肤上都不是开口或标记点。', 'en': 'Length and width of the labia minora were not measured: the specimen skin shows paired folds on either side of the midline, but the surface is stair-stepped and unlabelled and the inner folds cannot be separated reliably from the outer ones; glans of the clitoris, urethral orifice, vaginal orifice and anus are neither openings nor marked points on the skin.'}
    return out


