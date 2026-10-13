"""
女性的脸（第二版）：在按她的颅骨定出的头上，加一个“女性减中性”的形状差，再按厚度表把皮肤收到颅骨上。
The female face, second issue: a "female minus neutral" shape difference is added to the head already placed on her
skull, and the skin is then drawn to the skull by the soft-tissue depth table.

供 reissue_r2.py 调用 / called by reissue_r2.py。不读也不写任何皮肤包目录 / reads and writes no package directory itself.

  1 dimorphism_field   性别形状差的来源是一个开放模型：MakeHuman 的“性别”宏参数（Anny 封装，资产 CC0，代码 Apache-2.0）。
                       取同一拓扑下 gender = 1 与 gender = 0.5 两个头，先做带缩放的普氏对齐（去掉大小和位置），逐顶点相减；
                       再用仿射 ICP 把 Anny 的头对到 MHR 的头上，按最近点把这个差转到 MHR 的顶点上。
                       这是美术建模的差，不是测量数据，也不是从任何真人的图像学来的。
                       The sex difference in shape comes from an open model: MakeHuman's "gender" macro parameter (through
                       Anny; assets CC0, code Apache-2.0). Two heads of one topology, gender = 1 and gender = 0.5, are
                       Procrustes-aligned with scale (size and position removed) and subtracted vertex by vertex; an affine
                       ICP then lays the Anny head on the MHR head and the difference is carried to MHR's vertices by
                       closest point. It is an artist-made difference: not measured data, and not learned from images of
                       any real person.
  2 depth_warp         标志点处的皮肤带到“骨 + 厚度”上（高斯径向基，σ 22 mm，正则很小）。
                       the skin at the landmarks is brought to "bone + depth" (Gaussian radial basis, sigma 22 mm, light regularisation).
  3 floor              任何地方的覆盖不低于厚度表的下限（均值减一个标准差，至少 2.5 mm）。
                       nowhere is the cover below the table's lower bound (mean minus one SD, at least 2.5 mm).

厚度 / depths（只写我打开读到的；其余标明）/ only what was opened and read; the rest is labelled
  正中 / midline: Park E, Chang J, Park J. Int J Environ Res Public Health 2023;20(3):2658, doi:10.3390/ijerph20032658（CC BY 4.0；
        韩国 20–29 岁成人，CBCT，骨性 I 类，女 18 人；本轮打开，表 2）与 Sonita 等 2025（柬埔寨女 150 人；上一轮打开）两者的平均。
        the mean of Park, Chang & Park 2023 (CC BY 4.0; Korean adults in their twenties, CBCT, skeletal Class I, 18 women; opened
        this round, Table 2) and Sonita et al. 2025 (150 Cambodian women; opened last round).
  两侧 / bilateral: Hona & Stephan 2024 的 2023 T-Table（不分性别；由知识库审计打开并记录，本轮没有再打开）。
        the 2023 T-Table of Hona & Stephan 2024 (sex-pooled; opened and recorded by the knowledge audit, not opened again this round).
  下颌角和下颌支中点取表内偏薄的值（见 GONIAL），这是假定：表的标准差在这两处是 6 和 5 mm，随咬肌和皮下脂肪而变。
        gonion and mid-ramus take a thin value inside the table (see GONIAL); an assumption: the table's SD is 6 and 5 mm at
        these two points, which vary with masseter and subcutaneous fat.
"""
import numpy as np

SRC_PARK = 'Park, Chang & Park 2023, Int J Environ Res Public Health 20(3):2658, doi:10.3390/ijerph20032658, Table 2: females, skeletal Class I (n = 18, Korean, 20-29 y, CBCT), CC BY 4.0, opened'
SRC_SONITA = 'Sonita et al. 2025, Front. Dent. Med. 6:1714360, females (n = 150, Cambodian, 18-25 y), opened in an earlier round'
SRC_TT = 'Hona & Stephan 2024, Int J Legal Med 138:519-535, adult 2023 T-Table (sex-pooled), as recorded by the knowledge audit; not opened again'
# Park 2023 女性 I 类：均值 (标准差) mm / Park 2023 females Class I: mean (SD) mm
PARK_F = {'glabella': (5.57, 0.68), 'nasion': (6.16, 1.48), 'rhinion': (3.10, 1.6), 'subnasale': (13.53, 1.2), 'labraleSuperius': (14.19, 1.69),
          'labraleInferius': (14.94, 1.65), 'labiomentale': (11.99, 0.92), 'pogonion': (12.44, 1.83), 'gnathion': (7.53, 1.92)}
# Park 2023 男性 I 类（只用来报告性别差）/ Park 2023 males Class I (reported for the sex difference only)
PARK_M = {'glabella': 5.76, 'nasion': 6.93, 'rhinion': 2.92, 'subnasale': 15.25, 'labraleSuperius': 15.16, 'labraleInferius': 15.36, 'labiomentale': 11.92, 'pogonion': 11.27, 'gnathion': 7.22}
SONITA_F = {'glabella': 5.22, 'nasion': 5.87, 'rhinion': 2.56, 'subnasale': 13.58, 'labraleSuperius': 13.40, 'labraleInferius': 14.09, 'labiomentale': 12.11, 'pogonion': 11.46,
            'gnathion': 8.45, 'menton': 7.36}
# 2023 T-Table：均值 [标准差] / mean [SD]
TT = {'menton': (7.0, 2.5), 'midSupraorbital': (7.0, 2.0), 'midInfraorbital': (6.5, 3.0), 'zygion': (7.5, 3.0), 'gonion': (12.5, 6.0), 'midRamus': (19.5, 5.0),
      'supraM2': (26.0, 5.0), 'infraM2': (22.0, 5.0), 'midMandibularBorder': (11.0, 4.0)}
# 下颌角、下颌支中点、下颌下缘中点和颊部（上、下第二磨牙处）的取值（假定）：均值减 0.75、0.8、0.5、0.8、0.8 个标准差，都在“均值减一个标准差”之内
# values taken at gonion, mid-ramus, mid-mandibular border and the cheek (at the upper and lower second molars), an assumption:
# mean minus 0.75, 0.8, 0.5, 0.8 and 0.8 SD, all inside mean minus one SD
GONIAL = {'gonion': 8.0, 'midRamus': 15.5, 'midMandibularBorder': 8.0, 'infraM2': 17.0, 'supraM2': 22.0}

# 不作约束、只报告的点：下颌下缘中点。试过把它也作约束（同时下第二磨牙处取 17 mm 以上），下颌缘两侧各鼓出一个包（像下垂的颊），读作年长。
# Reported but not constrained: mid-mandibular border. Constraining it too (with the lower second molar above 17 mm) raised a lump on either side of
# the jaw line (like a jowl), which reads as older.
FREE = ('midMandibularBorder',)


def depth_table():
    """{标志点: {'mean', 'low', 'target', 'source'}}（mm）。low = 均值减一个标准差，不低于 2.5 mm。
    {landmark: {'mean', 'low', 'target', 'source'}} in mm. low = mean minus one SD, not under 2.5 mm."""
    out = {}
    for k in set(PARK_F) | set(SONITA_F) | set(TT):
        if k in PARK_F and k in SONITA_F:
            m, sd, src = 0.5 * (PARK_F[k][0] + SONITA_F[k]), PARK_F[k][1], f'mean of [{SRC_PARK}] and [{SRC_SONITA}]; SD from Park'
        elif k in SONITA_F:
            m, sd, src = 0.5 * (SONITA_F[k] + TT[k][0]), TT[k][1], f'mean of [{SRC_SONITA}] and [{SRC_TT}]; SD from the T-Table'
        else:
            m, sd, src = TT[k][0], TT[k][1], SRC_TT
        t = GONIAL.get(k, m)
        out[k] = {'mean': round(m, 2), 'sd': sd, 'low': round(max(m - sd, 2.5), 2), 'target': t,
                  'source': src + ('; target taken thin inside the table (assumption)' if k in GONIAL else '')}
    return out


def _skin_component(F, n):
    import scipy.sparse as sp
    import scipy.sparse.csgraph as cg
    g = sp.coo_matrix((np.ones(len(F) * 3), (F[:, [0, 1, 2]].ravel(), F[:, [1, 2, 0]].ravel())), shape=(n, n))
    _, lab = cg.connected_components(g, directed=False)
    big = np.argmax(np.bincount(lab))
    return F[(lab[F] == big).all(1)], lab == big


def _procrustes(X, Y):
    """把 X 用相似变换对到 Y 上：返回 s, R, t（y ≈ s R x + t）/ similarity taking X onto Y: s, R, t with y ~ s R x + t"""
    mx, my = X.mean(0), Y.mean(0)
    U, S, Vt = np.linalg.svd((Y - my).T @ (X - mx))
    d = np.sign(np.linalg.det(U @ Vt))
    R = U @ np.diag([1, 1, d]) @ Vt
    s = (S * [1, 1, d]).sum() / ((X - mx) ** 2).sum()
    return s, R, my - s * R @ mx


def dimorphism_field(V, F, wh, eye_mid, log, frm=0.5, to=1.0):
    """MHR 顶点上的“女性减中性”位移场（米），头以外为 0。V 是已经放在她颅骨上的皮肤。
    The "female minus neutral" displacement field on MHR's vertices (metres), zero off the head. V is the skin already placed on her skull."""
    import igl

    import annylib
    base = dict(age=2 / 3, muscle=0.5, weight=0.5, height=0.5, proportions=0.5, cupsize=0.5, firmness=0.5)
    rn, rf = annylib.rest(dict(base, gender=frm)), annylib.rest(dict(base, gender=to))
    N, Fa = rn['V'], rn['F']
    Fa, skin = _skin_component(Fa, len(N))
    lab = rn['labels']
    en = 0.5 * (rn['heads'][lab.index('eye.L')] + rn['heads'][lab.index('eye.R')])
    hd = skin & (N[:, 1] > en[1] - 0.115)
    s, R, t = _procrustes(rf['V'][hd], N[hd])
    Da = (s * rf['V'] @ R.T + t) - N
    log.append(f'  dimorphism: MakeHuman gender {frm} -> {to}; female head brought onto the neutral one by a similarity (scale {s:.3f}); '
               f'difference on the head: median {np.median(np.linalg.norm(Da[hd], axis=1)) * 1000:.1f}, max {np.linalg.norm(Da[hd], axis=1).max() * 1000:.1f} mm')
    # 仿射 ICP：Anny 中性头 -> MHR 头 / affine ICP: Anny neutral head -> MHR head
    top_m, top_a = V[wh > 0.9][:, 1].max(), N[:, 1].max()
    k = (top_m - eye_mid[1]) / (top_a - en[1])
    M, tr = np.eye(3) * k, eye_mid - k * en
    src = np.where(wh > 0.9)[0]
    src = src[::3]
    for it in range(25):
        W = N @ M.T + tr
        d2, fi, c = igl.point_mesh_squared_distance(np.ascontiguousarray(V[src]), np.ascontiguousarray(W), np.ascontiguousarray(Fa))[:3]
        keep = d2 <= np.percentile(d2, 85)
        # 最近点在 Anny 原坐标里的位置 / the closest points in Anny's own coordinates
        q = (c[keep] - tr) @ np.linalg.inv(M).T
        X = np.c_[q, np.ones(len(q))]
        sol = np.linalg.lstsq(X, V[src][keep], rcond=None)[0]
        M, tr = sol[:3].T, sol[3]
    log.append(f'  dimorphism: affine ICP of the Anny head onto the MHR head, RMS closest-point distance {np.sqrt(d2[keep].mean()) * 1000:.1f} mm (85 % trimmed), '
               f'singular values {np.round(np.linalg.svd(M)[1], 3).tolist()}')
    W = N @ M.T + tr
    idx = np.where(wh > 0.02)[0]
    _, fi, c = igl.point_mesh_squared_distance(np.ascontiguousarray(V[idx]), np.ascontiguousarray(W), np.ascontiguousarray(Fa))[:3]
    tri = Fa[fi]
    a, b, cc = W[tri[:, 0]], W[tri[:, 1]], W[tri[:, 2]]
    bc = igl.barycentric_coordinates(np.ascontiguousarray(c), np.ascontiguousarray(a), np.ascontiguousarray(b), np.ascontiguousarray(cc))
    bc = np.clip(bc, 0, 1)
    bc /= bc.sum(1)[:, None]
    D = np.zeros_like(V)
    D[idx] = np.einsum('ij,ijk->ik', bc, Da[tri]) @ M.T
    return D


def lid_ramp(lod, A, rings=5, smooth=14):
    """眼睑区的保护权重（核心为 1，向外缓降）/ protection weight of the lid regions (1 in the core, ramping down outwards)"""
    import enclose_skin as ES
    reg = ES.face_protect(lod)[1]
    w = np.zeros(A.shape[0])
    w[reg['lidsL']] = w[reg['lidsR']] = 1.0
    core = w > 0
    for _ in range(rings):
        w = np.maximum(w, (A @ w > 0).astype(float))
    for _ in range(smooth):
        w = 0.5 * w + 0.5 * (A @ w)
        w[core] = 1.0
    return w


def depth_warp(V, F, lm, table, wh, keep, A, log, sigma=0.022, reg=0.05, cap=0.012, skip=()):
    """标志点处：皮肤上沿厚度方向的那一点带到“骨 + target”处。keep 是不动的权重（眼睑）。
    At the landmarks the skin point along the depth direction is brought to "bone + target". keep is the weight of what must not move (the lids)."""
    import igl
    names = [k for k in lm if k.split('_')[0] in table and k.split('_')[0] not in skip]
    T = np.array([lm[k]['bone'] + table[k.split('_')[0]]['target'] / 1000.0 * lm[k]['dir'] for k in names])
    c = igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(V), np.ascontiguousarray(F))[2]
    D = T - c
    ln = np.linalg.norm(D, axis=1)
    D = D * np.minimum(1.0, cap / np.maximum(ln, 1e-9))[:, None]
    K = np.exp(-((c[:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2))
    Wt = np.linalg.solve(K + reg * np.eye(len(c)), D)
    head = np.where(wh > 0.02)[0]
    Kx = np.exp(-((V[head][:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2))
    U = np.zeros_like(V)
    U[head] = (wh[head] * (1.0 - keep[head]))[:, None] * (Kx @ Wt)
    for _ in range(3):
        U = 0.5 * U + 0.5 * (A @ U)
    log.append(f'  depth warp: {len(names)} landmarks, displacement asked median {np.median(ln) * 1000:.1f}, max {ln.max() * 1000:.1f} mm (capped at {cap * 1000:.0f}); sigma {sigma * 1000:.0f} mm')
    return V + U


def cover_at(lm, V, F):
    """各标志点处沿厚度方向量到的覆盖（mm）：从骨上的点沿 dir 射出，到皮肤的距离。
    Cover at each landmark measured along the depth direction (mm): the distance from the bone point to the skin along dir."""
    import igl
    out = {}
    for k, v in lm.items():
        hits = igl.ray_mesh_intersect(np.ascontiguousarray(v['bone'] + 1e-4 * v['dir']), np.ascontiguousarray(v['dir']), np.ascontiguousarray(V), np.ascontiguousarray(F))
        ts = sorted(h[1] for h in hits) if hits else []
        out[k] = round(float(ts[0]) * 1000, 1) if ts else None
    return out


SCALP = 0.0055   # 颅盖上的头皮厚度：T-Table 颅顶 5.0、枕后点 6.0、眉间 5.5 的中间值 / scalp over the vault: between the T-Table's vertex 5.0, opisthocranion 6.0 and glabella 5.5
STOMION_ABOVE_INCISAL = 0.00275   # 口裂在上切牙切缘上方 2.75 mm（知识库审计：年轻女性 2.5–3 mm）/ oral fissure 2.75 mm above the upper incisal edge (knowledge audit: 2.5-3 mm in young women)

# 鼻尖是否要盖住现有的鼻软骨部件。关：这些软骨是由男性变形来的，盖住它们鼻尖要比鼻下点靠前 17.7 mm，鼻子又长又尖，读作男性；
# 关掉后鼻子用 MHR 加性别形状差的鼻子（放在梨状孔和鼻骨上），鼻软骨部件有一部分在皮肤外，须由管线按新的鼻子重新摆放（原包也是把鼻软骨排除在“必须包住”之外的）。
# Whether the nasal tip must cover the present nasal cartilage parts. Off: those cartilages are warped from the male, and covering them puts the
# tip 17.7 mm ahead of subnasale, a long pointed nose that reads male; with it off the nose is MHR's plus the sex difference (seated on the
# piriform aperture and the nasal bones), part of the cartilage parts lies outside the skin, and the pipeline has to re-place them to the
# new nose (the source package also left the nasal cartilages out of what must be enclosed).
TIP_OVER_CARTILAGE = False
# 鼻骨脊和内眦眶缘上另加的约束（见 rebuild_head）。关：开着时有一个约束不收敛（22.5 mm），鼻尖塌到只比鼻下点靠前 2.2 mm；原因没有查清。
# The further constraints on the nasal ridge and the medial orbital rims (see rebuild_head). Off: with them one constraint failed to converge
# (22.5 mm) and the nasal tip collapsed to 2.2 mm ahead of subnasale; the cause was not found.
EXTRA_BONE_POINTS = False


def _rbf_fit(src, dst, sigma, reg, wts=None):
    """仿射 + 高斯径向基的空间变形 x -> x + u(x)，使 src 到 dst。返回可调用对象。
    A space warp x -> x + u(x), affine plus Gaussian radial basis, taking src to dst. Returns a callable."""
    n = len(src)
    w = np.ones(n) if wts is None else np.asarray(wts, float)
    X = np.c_[src, np.ones(n)]
    # 先解加权仿射，再用径向基解残差 / weighted affine first, the residual by radial basis
    sw = np.sqrt(w)[:, None]
    Aff = np.linalg.lstsq(X * sw, (dst - src) * sw, rcond=None)[0]
    r = (dst - src) - X @ Aff
    K = np.exp(-((src[:, None, :] - src[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2))
    C = np.linalg.solve(K + np.diag(reg / w), r)

    def u(P):
        out = np.c_[P, np.ones(len(P))] @ Aff
        for i in range(0, len(P), 20000):
            Kx = np.exp(-((P[i:i + 20000, None, :] - src[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2))
            out[i:i + 20000] += Kx @ C
        return out
    return u


def vault_rays(fb, n=140):
    """颅盖上的目标点：从颅腔中心向上半球和后方发出射线，取最外面的骨面交点，再沿射线向外加头皮厚度。返回 (射线原点, 方向, 目标点)。
    Targets over the vault: rays from the centre of the cranial cavity over the upper hemisphere and backwards, the outermost hit on bone, plus the scalp depth along the ray. Returns (origin, directions, targets)."""
    import igl
    names = ['Frontal bone', 'Left parietal bone', 'Right parietal bone', 'Occipital bone', 'Left temporal bone', 'Right temporal bone']
    BV, BF = fb.merged(lambda p: p['name'] in names)
    BV, BF = np.ascontiguousarray(BV), np.ascontiguousarray(BF)
    par = np.vstack([fb.verts('Left parietal bone'), fb.verts('Right parietal bone')])
    fr, oc = fb.verts('Frontal bone'), fb.verts('Occipital bone')
    o = np.array([np.median(par[:, 0]), 0.5 * (par[:, 1].min() + par[:, 1].max()) - 0.01, 0.5 * (fr[:, 2].max() + oc[:, 2].min())])
    g = (1 + 5 ** 0.5) / 2
    i = np.arange(n * 2)
    y = 1 - 2 * (i + 0.5) / (n * 2)
    r = np.sqrt(1 - y * y)
    d = np.stack([r * np.cos(2 * np.pi * i / g), y, r * np.sin(2 * np.pi * i / g)], 1)
    # 上半球，以及后下方直到枕外隆突附近；前下方（面部）和两侧耳的位置不用 / upper hemisphere and the back down to about the inion; the face (front and low) and the ears are left out
    d = d[(d[:, 1] > 0.12) | ((d[:, 2] < -0.55) & (d[:, 1] > -0.30))]
    D, T = [], []
    for k in range(len(d)):
        hits = igl.ray_mesh_intersect(np.ascontiguousarray(o), np.ascontiguousarray(d[k]), BV, BF)
        ts = [h[1] for h in hits] if hits else []
        if ts:
            D.append(d[k])
            T.append(o + (max(ts) + SCALP) * d[k])
    return o, np.array(D), np.array(T)


def _first_hit_out(o, D, V, F):
    """从 o 沿各方向射出，取最远的交点（最外层的皮肤）/ rays from o, the furthest hit (the outermost skin)"""
    import igl
    V, F = np.ascontiguousarray(V), np.ascontiguousarray(F)
    P, ok = np.zeros_like(D), np.zeros(len(D), bool)
    for k in range(len(D)):
        hits = igl.ray_mesh_intersect(np.ascontiguousarray(o), np.ascontiguousarray(D[k]), V, F)
        if hits:
            P[k], ok[k] = o + max(h[1] for h in hits) * D[k], True
    return P, ok


def rebuild_head(Vm, P, jn, F, V_inst, wh, fb, lm, table, marks, mid, D, strength, A, log, iters=5, sigma=0.035):
    """从干净的 MHR 头（Vm，只含身份系数和姿势）出发，用一个光滑的空间变形把它放到她的颅骨上：没有逐顶点的外推，所以面上不留折痕。
    约束：颅盖射线（骨 + 头皮厚度）、面部标志点（骨 + 厚度）、两眼球中心、口裂高度、头颈交界处与原来的皮肤相接。
    From the clean MHR head (Vm: identity and pose only) one smooth space warp places it on her skull; no per-vertex push,
    so no creases are left on the surface. Constraints: vault rays (bone + scalp), facial landmarks (bone + depth), the two
    globe centres, the height of the oral fissure, and continuity with the previous skin at the junction of head and neck."""
    import igl
    S = Vm + strength * wh[:, None] * D
    Pj = P.copy()
    eyes = [(jn.index('l_eye'), fb.verts('Left vitreous body').mean(0)), (jn.index('r_eye'), fb.verts('Right vitreous body').mean(0))]
    o, RD, RT = vault_rays(fb)
    inc = np.vstack([fb.verts(n_) for n_ in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')])
    crease = marks[0]
    ring = np.where((wh > 0.10) & (wh < 0.45))[0]
    ring = ring[np.random.default_rng(4).choice(len(ring), 90, replace=False)]
    names = [k for k in lm if k.split('_')[0] in table and k.split('_')[0] not in FREE]
    xc = float(lm['rhinion']['bone'][0])
    LB = np.array([lm[k]['bone'] * ([1, 1, 1] if '_' in k else [0, 1, 1]) + ([0, 0, 0] if '_' in k else [xc, 0, 0]) for k in names])   # 正中的点落在正中面上 / midline points are put on the midplane
    LD = np.array([lm[k]['dir'] for k in names])
    LT = LB + np.array([table[k.split('_')[0]]['target'] for k in names])[:, None] / 1000.0 * LD
    # 另加的骨上约束（厚度是假定值，表里没有这些点）：鼻骨脊上三点，厚度在鼻根和鼻骨下端的表值之间线性取；每侧内眦处的眶内缘（上颌骨额突 / 泪骨）2.5 mm。
    # 没有它们时，鼻骨有 16–20 % 露在皮肤外（最多 2 mm），内眦处的眶缘露出 3.5–4.3 mm。
    # Further constraints over bone (assumed depths; the tables have no such points): three points on the ridge of the nasal bones, depth
    # linear between the tabled nasion and rhinion values; the medial orbital rim at each inner canthus (frontal process of the maxilla /
    # lacrimal bone), 2.5 mm. Without them 16-20 % of the nasal bones lay outside the skin (by up to 2 mm) and the rim at the inner canthus by 3.5-4.3 mm.
    eb, ed, et = [], [], []
    nb = np.vstack([fb.verts('Left nasal bone'), fb.verts('Right nasal bone')])
    nb = nb[np.abs(nb[:, 0] - xc) < 0.003]
    yn, yr = lm['nasion']['bone'][1], lm['rhinion']['bone'][1]
    for f_ in (0.25, 0.5, 0.75):
        y_ = yn + f_ * (yr - yn)
        q = nb[np.abs(nb[:, 1] - y_) < 0.002]
        if len(q):
            eb.append([xc, y_, q[:, 2].max()]); ed.append(lm['rhinion']['dir']); et.append(table['nasion']['target'] + f_ * (table['rhinion']['target'] - table['nasion']['target']))
    rim = np.vstack([fb.verts(n_) for n_ in ('Left maxilla', 'Right maxilla', 'Left lacrimal bone', 'Right lacrimal bone', 'Frontal bone')])
    for sg_, (_, cg) in zip((1, -1), eyes):
        for dy in (-0.004, 0.003):
            q = rim[(np.abs(rim[:, 1] - (cg[1] + dy)) < 0.003) & (sg_ * (cg[0] - rim[:, 0]) > 0.011) & (sg_ * (cg[0] - rim[:, 0]) < 0.021)]
            if len(q):
                d_ = np.array([-sg_ * 0.3, 0.0, 1.0])
                eb.append(q[np.argmax(q[:, 2])]); ed.append(d_ / np.linalg.norm(d_)); et.append(2.5)
    if EXTRA_BONE_POINTS and eb:
        LB, LD = np.vstack([LB, np.array(eb)]), np.vstack([LD, np.array(ed)])
        LT = np.vstack([LT, np.array(eb) + np.array(et)[:, None] / 1000.0 * np.array(ed)])
    # 鼻尖：MHR 的鼻尖顶点对到她的鼻软骨最前点前方 3 mm（假定值）。鼻软骨是由男性变形来的部件，但皮肤必须盖住它。
    # Nasal tip: MHR's tip vertex goes 3 mm (assumption) in front of the most anterior point of her nasal cartilages. Those cartilages are warped from the male, but the skin has to cover them.
    tip = None
    cart = [fb.mesh(p_)[0] for p_ in fb.parts if 'nasal cartilage' in p_['name'].lower() or 'alar cartilage' in p_['name'].lower()]
    if TIP_OVER_CARTILAGE and cart and mid.get('_pronasale') is not None:
        cart = np.vstack(cart)
        cz = cart[np.abs(cart[:, 0] - xc) < 0.008]
        t_ = cz[np.argmax(cz[:, 2])]
        tip = (int(mid['_pronasale']), np.array([xc, t_[1], t_[2] + 0.003]))
    for it in range(iters):
        src, dst, wt = [], [], []
        # 颅盖 / vault
        hp, ok = _first_hit_out(o, RD, S, F)
        src.append(hp[ok]); dst.append(RT[ok]); wt.append(np.full(ok.sum(), 0.25))
        # 眼 / eyes
        for j, c in eyes:
            src.append(Pj[j][None]); dst.append(c[None]); wt.append([30.0])
        # 口裂：只定高度和左右；前后取现在的位置 / oral fissure: height and left-right only; front-to-back stays where it is
        sm = S[crease].mean(0)
        src.append(sm[None]); dst.append(np.array([[xc, inc[:, 1].min() + STOMION_ABOVE_INCISAL, sm[2]]])); wt.append([4.0 if it else 1.0])
        if tip is not None:
            src.append(S[tip[0]][None]); dst.append(tip[1][None]); wt.append([4.0 if it else 1.0])
        # 头颈交界 / junction of head and neck
        src.append(S[ring]); dst.append(V_inst[ring]); wt.append(np.full(len(ring), 1.0))
        # 面部标志点：从骨上的点沿厚度方向射到皮肤，把这一点沿同一方向带到“骨 + 厚度”处。只沿厚度方向移动：
        # 标志点在骨上的高度不能当作软组织特征的高度用（试过：把 MHR 的唇、鼻根顶点整个拉到这些点上，脸被拉歪）。第一遍只做整体对位。
        # Facial landmarks: a ray from the bone point along the depth direction meets the skin, and that skin point is taken along the same
        # direction to "bone + depth". Movement is along the depth direction only: the height of a landmark on bone is no guide to the
        # height of a soft-tissue feature (tried: pulling MHR's lip and nasal-root vertices onto these points skews the face). The first pass only aligns.
        if it:
            c, okl = np.zeros_like(LT), np.zeros(len(LT), bool)
            for i in range(len(LT)):
                hits = igl.ray_mesh_intersect(np.ascontiguousarray(LB[i] + 1e-4 * LD[i]), np.ascontiguousarray(LD[i]), np.ascontiguousarray(S), np.ascontiguousarray(F))
                if hits:
                    c[i], okl[i] = LB[i] + (1e-4 + min(h[1] for h in hits)) * LD[i], True
            if (~okl).any():   # 骨上的点在皮肤外：从目标点反向找 / the bone point is outside the skin: look back from the target
                c[~okl] = igl.point_mesh_squared_distance(np.ascontiguousarray(LT[~okl]), np.ascontiguousarray(S), np.ascontiguousarray(F))[2]
                c[~okl] = LB[~okl] + np.einsum('ij,ij->i', c[~okl] - LB[~okl], LD[~okl])[:, None] * LD[~okl]
            src.append(c); dst.append(LT); wt.append(np.full(len(LT), 4.0))
        src, dst, wt = np.vstack(src), np.vstack(dst), np.concatenate(wt)
        u = _rbf_fit(src, dst, sigma if it else 0.08, 2e-2 if it else 5e-2, wt)
        res = np.linalg.norm(dst - src, axis=1) * 1000
        log.append(f'  head rebuild {it}: {len(src)} constraints, distance before this pass median {np.median(res):.1f} / max {res.max():.1f} mm')
        hd = np.where(wh > 0.0)[0]
        S = S.copy()
        S[hd] = S[hd] + u(S[hd])
        Pj = Pj + u(Pj)
    out = V_inst + wh[:, None] * (S - V_inst)
    return out, Pj


def mhr_midline(ident, lod, crease, menton):
    """MHR 正中矢状轮廓上的软组织标志点的顶点下标，在给定身份系数的中性网格上按轮廓的凸凹找（拓扑固定，所以任何姿势都可用）。
    Vertex indices of the soft-tissue landmarks on MHR's midsagittal profile, found from the convexities and concavities of the
    profile on the neutral mesh of the given identity (the topology is fixed, so they hold in any pose)."""
    import mhrlib
    V, P, _ = mhrlib.run(ident, np.zeros(204), lod, True)
    jn = mhrlib.joint_names(lod)
    e = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    m = np.where((np.abs(V[:, 0]) < 0.0015) & (V[:, 2] > e[2]))[0]
    y, z = V[m, 1], V[m, 2]
    pick = lambda lo, hi, f: int(m[(y > lo) & (y < hi)][f(z[(y > lo) & (y < hi)])])
    out = {}
    out['nasion'] = pick(e[1] - 0.006, e[1] + 0.018, np.argmin)
    out['glabella'] = pick(V[out['nasion'], 1] + 0.006, V[out['nasion'], 1] + 0.028, np.argmax)
    prn = pick(e[1] - 0.060, e[1] - 0.020, np.argmax)
    sto = float(V[crease, 1].mean())
    out['labraleSuperius'] = pick(sto + 0.001, sto + 0.012, np.argmax)
    out['subnasale'] = pick(V[out['labraleSuperius'], 1] + 0.003, V[prn, 1] - 0.003, np.argmin)
    out['labraleInferius'] = pick(sto - 0.014, sto - 0.001, np.argmax)
    out['pogonion'] = pick(V[menton, 1] + 0.004, V[out['labraleInferius'], 1] - 0.012, np.argmax)
    out['labiomentale'] = pick(V[out['pogonion'], 1] + 0.003, V[out['labraleInferius'], 1] - 0.003, np.argmin)
    out['menton'] = int(menton)
    out['_pronasale'] = prn
    return out


def fix_landmarks(lm, fb):
    """face_female.landmarks 的三处修正（返回新的字典，原件不动）：
    1 正中的点都放到正中面上（原来在 ±4–6 mm 的带内取极值，眉间、鼻下点偏了 3–4 mm）。
    2 上、下唇的厚度在唇红缘的高度量，不在切缘的高度量：上唇取口裂上方 6 mm 处上切牙（或牙槽）的最前点，下唇取口裂下方 6 mm 处下切牙（或牙槽）的最前点
      （原来两点只隔 3 mm，都在口裂的高度上）。6 mm 是假定值（MHR 的唇红最突点离口裂 6.7 / 6.6 mm）。
    3 颏唇沟点取下唇点与颏前点之间一半高度处下颌骨的前面（原来与颏前点重合）。
    Three corrections to face_female.landmarks (a new dict; the original is untouched):
    1 midline points are put on the midplane (they were extremes inside a band of +/-4-6 mm; glabella and subnasale were 3-4 mm off).
    2 the lip depths are measured at the level of the vermilion borders, not of the incisal edge: the upper at the most anterior point of the
      upper incisors (or alveolus) 6 mm above the oral fissure, the lower at that of the lower incisors (or alveolus) 6 mm below it (the two
      were 3 mm apart, both at the height of the fissure). 6 mm is an assumption (MHR's most prominent vermilion points lie 6.7 / 6.6 mm from the fissure).
    3 labiomentale is taken on the front of the mandible half-way in height between the lower lip point and pogonion (it coincided with pogonion)."""
    out = {k: dict(v) for k, v in lm.items()}
    xc = float(lm['rhinion']['bone'][0])
    ui = np.vstack([fb.verts(n) for n in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')] + [fb.verts('Left maxilla'), fb.verts('Right maxilla')])
    li = np.vstack([fb.verts(n) for n in ('Left lower central secondary incisor tooth', 'Right lower central secondary incisor tooth')] + [fb.verts('Mandible')])
    inc = np.vstack([fb.verts(n) for n in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')])
    sto = inc[:, 1].min() + STOMION_ABOVE_INCISAL
    front = lambda P, y: float(P[(np.abs(P[:, 0] - xc) < 0.006) & (np.abs(P[:, 1] - y) < 0.002)][:, 2].max())
    out['labraleSuperius']['bone'] = np.array([xc, sto + 0.006, front(ui, sto + 0.006)])
    out['labraleInferius']['bone'] = np.array([xc, sto - 0.006, front(li, sto - 0.006)])
    yl = 0.5 * (sto - 0.006 + lm['pogonion']['bone'][1])
    out['labiomentale']['bone'] = np.array([xc, yl, front(fb.verts('Mandible'), yl)])
    for k, v in out.items():
        if '_' not in k:
            b = np.asarray(v['bone'], float).copy()
            b[0] = xc
            v['bone'] = b
        v['target'] = v['bone'] + v['depthMm'] / 1000.0 * v['dir']
    return out


def apply_table(lm, table):
    """把厚度表的 target 写进标志点（depthMm、target）/ write the table's targets into the landmarks (depthMm, target)"""
    out = {k: dict(v) for k, v in lm.items()}
    for k, v in out.items():
        t = table.get(k.split('_')[0])
        if t:
            v['depthMm'] = t['target']
            v['target'] = v['bone'] + t['target'] / 1000.0 * v['dir']
            v['source'] = t['source']
    return out


def cornea_cover(V, F, Pj, jn, wh, fb, log, want=0.0008, radius=0.040):
    """把每侧眼睑前后移到角膜最前点在皮下 want 处：眶周一个光滑的局部平移（半径 26 mm，smoothstep）。
    Each pair of lids moves front to back until the front of the cornea is `want` under the skin: a smooth local translation of the periorbital skin (radius 26 mm, smoothstep)."""
    from fit_check import signed_distance
    V = V.copy()
    info = {}
    for S, j, side in (('L', 'l_eye', 'Left'), ('R', 'r_eye', 'Right')):
        c = fb.verts(f'{side} vitreous body').mean(0)
        cor = np.vstack([fb.verts(p['name']) for p in fb.parts if 'cornea' in p['name'].lower() and side.lower() in p['name'].lower()])
        tot = 0.0
        for _ in range(3):
            cover = float(np.min(-signed_distance(cor, V, F)))
            dz = float(np.clip(want - cover, -0.008, 0.008))
            u = np.clip(1 - np.linalg.norm((V - c)[:, :2], axis=1) / radius, 0, 1)
            V[:, 2] += wh * u * u * (3 - 2 * u) * (V[:, 2] > c[2] - 0.01) * dz
            tot += dz
        info[S] = {'movedZMm': round(tot * 1000, 1), 'corneaCoverMm': round(float(np.min(-signed_distance(cor, V, F))) * 1000, 2)}
    log.append('  cornea cover: ' + str(info))
    return V, info
