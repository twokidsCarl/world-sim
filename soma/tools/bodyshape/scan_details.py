"""
男性：把他自己扫描皮肤上的脐和乳头转移到 MHR 皮肤上（位置和起伏；分辨率仍是 MHR 的）。
Male: navel and nipples of his own scanned skin transferred onto the MHR skin (position and relief; the resolution stays MHR's).

来源是同一个人的扫描数据：BodyParts3D FJ2810（皮肤，外壁；CC BY-SA 2.1 JP），即 fit_skin.reference_skin() 存下的那张皮肤，已在我们的坐标系里。
The source is scanned data of the same man: BodyParts3D FJ2810 (skin, outer wall; CC BY-SA 2.1 JP), the skin kept by fit_skin.reference_skin(), already in our frame.

做法：在躯干前面的三个小区域里，扫描皮肤的“起伏” = 扫描面减去它自己抹平后的面（沿法线）。脐取起伏最深的点，乳头取胸部两侧起伏最高的点。
把这个起伏加到 MHR 皮肤上相应位置（以该点为中心 22 mm / 12 mm 半径内，按到中心的距离从扫描上取值），沿 MHR 的法线。
Method: in three small regions on the front of the trunk the relief of the scan = the scanned surface minus its own smoothed surface (along
the normal). The navel is the deepest point of the relief, each nipple the highest point on its side of the chest. That relief is added to
the MHR skin at the same place (within 22 mm / 12 mm of the centre, sampled from the scan by distance from the centre) along MHR's normals.
"""
import numpy as np


def _adj(n, F):
    from scipy import sparse
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    A = sparse.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    return sparse.diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A


NAVEL_DEPTH, NAVEL_WIDTH = 0.0053, 0.017


def transfer(V, F, SV, SF, L, vertex_normals, log, notch_y=None):
    """返回 (新顶点, 信息)。SV, SF：扫描皮肤。 Returns (new vertices, info). SV, SF: the scanned skin."""
    from scipy.spatial import cKDTree
    sn = vertex_normals(SV, SF)
    A = _adj(len(SV), SF)
    hip = 0.5 * (L['hip_L'] + L['hip_R'])
    sh = 0.5 * (L['shoulder_L'] + L['shoulder_R'])
    zc = 0.5 * (hip[2] + sh[2])
    front = (SV[:, 2] > zc) & (sn[:, 2] > 0.3) & (np.abs(SV[:, 0] - hip[0]) < 0.19)
    # 起伏的尺度：乳头只有几个扫描顶点大，抹平 8 遍；脐抹平 25 遍。抹得多了量到的是胸肌、腹壁的大弧度（第一次用 60 遍，乳头量出 13 mm）。
    # Scale of the relief: a nipple is a few scan vertices across, so 8 smoothing passes; the navel gets 25. More than that measures the broad
    # curve of pectoral and abdominal wall instead (60 passes at first gave 13 mm for a nipple).
    rels = {}
    S = SV.copy()
    for it in range(1, 61):
        S = 0.5 * S + 0.5 * (A @ S)
        if it in (8, 25, 60):
            rels[it] = np.einsum('ij,ij->i', SV - S, sn)
    info, out = {}, V.copy()
    n = vertex_normals(V, F)
    tree = cKDTree(SV)
    regions = {'navel': (front & (np.abs(SV[:, 0] - hip[0]) < 0.03) & (SV[:, 1] > hip[1] + 0.02) & (SV[:, 1] < hip[1] + 0.22), -1, 0.022, 25)}
    for Sd, sg in (('L', 1), ('R', -1)):
        regions['nipple' + Sd] = (front & (sg * (SV[:, 0] - sh[0]) > 0.06) & (sg * (SV[:, 0] - sh[0]) < 0.15) & (SV[:, 1] < sh[1] - 0.10) & (SV[:, 1] > sh[1] - 0.24), 1, 0.016, 8)
    # 两个乳头成对地选：各侧取起伏最高的 10 个候选点，选“起伏之和大、左右高度和离正中距离相近”的一对（单侧各自取最大会选到不对称的噪声点）。
    # The nipples are chosen as a pair: the 10 highest candidates on each side, and the pair with a large summed relief at similar height
    # and distance from the midline (taking each side's maximum alone picked asymmetric noise).
    # 先用大尺度的起伏（抹平 60 遍）找到每侧胸前最突出的地方，再在它周围 18 mm 内取小尺度起伏（8 遍）最高的点作乳头。
    # 只用小尺度时选到的是腋前襞边上的噪声点（离正中 138 mm、在胸侧壁上）。
    # First the broad relief (60 passes) finds the most prominent place on each side of the chest; within 18 mm of it the point with the
    # highest fine relief (8 passes) is the nipple. With the fine relief alone the pick was noise at the edge of the axillary fold
    # (138 mm from the midline, on the side of the chest).
    # 乳头的位置先按解剖限定：高度在胸骨上切迹下 100–165 mm（第 4 肋间隙附近；文献：切迹到乳头的直线距离男性约 18.8 cm），离正中 85–130 mm，
    # 在这个范围内取细起伏（抹平 8 遍）最高的点。第一次不加这个限制，选到的是第 7 肋水平、胸大肌下缘的隆起（离切迹 245 / 253 mm），不是乳头。
    # The nipple is first bounded anatomically: 100-165 mm below the sternal notch (about the fourth intercostal space; published
    # notch-to-nipple distance in men about 18.8 cm) and 85-130 mm from the midline; within that the point of highest fine relief
    # (8 passes) is taken. Without the bound the pick was the bulge at the lower border of pectoralis at the level of the seventh rib
    # (245 / 253 mm from the notch), not the nipple.
    pick = {}
    ny = notch_y if notch_y is not None else sh[1] + 0.03
    for Sd, sg in (('L', 1), ('R', -1)):
        m_ = front & (sn[:, 2] > 0.5) & (sg * (SV[:, 0] - sh[0]) > 0.085) & (sg * (SV[:, 0] - sh[0]) < 0.130) & (SV[:, 1] < ny - 0.100) & (SV[:, 1] > ny - 0.165)
        idx = np.where(m_)[0]
        if len(idx):
            pick['nipple' + Sd] = int(idx[np.argmax(rels[8][idx])])
    for k, (m, sign, rad, lev) in regions.items():
        rel = rels[lev]
        idx = np.where(m)[0]
        c = idx[np.argmax(sign * rel[idx])]
        if k in pick:
            c = pick[k]
        cp = SV[c]
        # MHR 皮肤上的对应中心：离扫描上那一点最近的 MHR 顶点 / the matching centre on the MHR skin: the MHR vertex nearest that scan point
        j = int(np.argmin(np.linalg.norm(V - cp, axis=1)))
        sel = np.where(np.linalg.norm(V - V[j], axis=1) < rad)[0]
        q = cp + (V[sel] - V[j])          # 以两个中心对齐后到扫描上取值 / sampled on the scan after aligning the two centres
        dd, ii = tree.query(q, k=3)
        w = 1.0 / np.maximum(dd, 1e-6)
        r = (rel[ii] * w).sum(1) / w.sum(1)
        u = np.clip(1 - np.linalg.norm(V[sel] - V[j], axis=1) / rad, 0, 1)
        r = r * np.minimum(1.0, 3 * u)   # 边缘渐变到 0 / fades to 0 at the rim
        if k == 'navel':
            # 脐：这个网格的顶点间距约 8 mm，照搬扫描的起伏只得到一个棱角分明的坑。改为一个圆滑的凹陷：深度和宽度取扫描上的值
            # （深 5.3 mm、宽约 17 mm，协调方在扫描上量得；我用 25 遍抹平量到 4.7 mm），形状为高斯，作用半径 26 mm。
            # Navel: with vertices about 8 mm apart, copying the scanned relief gives only an angular pit. A rounded depression is made
            # instead, with the depth and width of the scan (5.3 mm deep and about 17 mm wide as measured on the scan by the
            # coordinator; my 25-pass measure gives 4.7 mm), Gaussian in shape, acting within 26 mm.
            sel = np.where(np.linalg.norm(V - V[j], axis=1) < 0.026)[0]
            rr = np.linalg.norm(V[sel] - V[j], axis=1)
            r = -NAVEL_DEPTH * np.exp(-(rr / (NAVEL_WIDTH / 2 / 0.83)) ** 2)   # 半高全宽 = 宽度 / full width at half depth = the width
            r = r * np.clip((0.026 - rr) / 0.006, 0, 1)
            nc = n[sel].mean(0)
            nc /= np.linalg.norm(nc)
            out[sel] = V[sel] + r[:, None] * nc
        else:
            out[sel] = V[sel] + r[:, None] * n[sel]
        info[k] = {'mhrVertex': j, 'scanNormal': np.round(sn[c], 3).tolist(), 'scanPosition': np.round(cp, 4).tolist(), 'scanReliefMm': round(float(rel[c] * 1000), 1), 'distanceScanToMhrSkinMm': round(float(np.linalg.norm(V[j] - cp) * 1000), 1),
                   'mhrVertices': int(len(sel)), 'reliefAppliedMm': round(float(r[np.argmax(np.abs(r))] * 1000), 1)}
        log.append(f'  scan detail {k}: at {info[k]["scanPosition"]} on his scanned skin, relief {info[k]["scanReliefMm"]:+.1f} mm; nearest MHR skin {info[k]["distanceScanToMhrSkinMm"]} mm away; '
                   f'{len(sel)} MHR vertices moved, largest {info[k]["reliefAppliedMm"]:+.1f} mm')
    return out, info


def annotate(info, fb, V, F, V_fit, SV, SF, vertex_normals, log):
    """给 scanDetails 补上：各点在最终皮肤上的位置和法线、扫描上的尺寸；乳头位置对胸骨上切迹和肋骨的关系；胸前皮肤为什么离扫描皮肤远。
    Adds to scanDetails: position and normal of each site on the final skin and the scanned sizes; where the nipples lie relative to the
    sternal notch and the ribs; and why the skin of the chest stands off the scanned skin."""
    import igl
    n = vertex_normals(V, F)
    man = fb.verts('Manubrium')
    xc = float(np.median(man[:, 0]))
    top = man[np.abs(man[:, 0] - xc) < 0.006]
    notch = np.array([xc, top[:, 1].max(), top[top[:, 1] > top[:, 1].max() - 0.004][:, 2].max()])
    for k, v in info.items():
        j = v['mhrVertex']
        v['onFinalSkin'] = {'centre': np.round(V[j], 4).tolist(), 'normal': np.round(n[j], 3).tolist()}
        sp = np.array(v['scanPosition'])
        d_fit = float(np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(sp[None]), np.ascontiguousarray(V_fit), np.ascontiguousarray(F))[0][0]))
        d_fin = float(np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(sp[None]), np.ascontiguousarray(V), np.ascontiguousarray(F))[0][0]))
        v['scanPointToSkinMm'] = {'beforeEnclosure': round(d_fit * 1000, 1), 'final': round(d_fin * 1000, 1)}
    info['navel']['scanned'] = {'depthMm': NAVEL_DEPTH * 1000, 'widthMm': NAVEL_WIDTH * 1000, 'note': 'depth and width measured on the scan by the coordinator; applied as a rounded depression'}
    nl, nr = np.array(info['nippleL']['scanPosition']), np.array(info['nippleR']['scanPosition'])
    ribs = {}
    for S, p in (('L', nl), ('R', nr)):
        side = 'left' if S == 'L' else 'right'
        row = {}
        for p_ in fb.parts:
            nm = p_['name'].lower()
            if p_['tissue'] == 'bone' and nm.startswith(side) and nm.endswith(' rib'):
                v_ = fb.mesh(p_)[0]
                m = (np.abs(v_[:, 0] - p[0]) < 0.012) & (v_[:, 2] > p[2] - 0.06)
                if m.sum() > 3:
                    row[p_['name']] = [round(float(v_[m][:, 1].min()), 4), round(float(v_[m][:, 1].max()), 4)]
        ribs[S] = row
        info['nipple' + S]['scanned'] = {'reliefMm': info['nipple' + S]['scanReliefMm'], 'areola': 'not resolved by the scan geometry (no colour, 3-5 vertices at the nipple)'}
        info['nipple' + S]['ribsAtThisXyRangeM'] = row
    info['nipplePosition'] = {'sternalNotch': np.round(notch, 4).tolist(), 'notchToNippleMm': {'L': round(float(np.linalg.norm(nl - notch) * 1000), 1), 'R': round(float(np.linalg.norm(nr - notch) * 1000), 1)},
                              'internippleMm': round(float(np.linalg.norm(nl - nr) * 1000), 1), 'nippleHeightM': {'L': round(float(nl[1]), 4), 'R': round(float(nr[1]), 4)},
                              'reference': 'sternal notch to nipple 18.8 +/- 1.3 cm, internipple 21.7 +/- 1.6 cm, n = 401 men (Rev Bras Cir Plast, doi:10.1055/s-0045-1811182), as passed on by the coordinator from a summary; NOT opened here'}
    log.append('  nipples on the scan: ' + str(info['nipplePosition']['notchToNippleMm']) + f' mm from the sternal notch, {info["nipplePosition"]["internippleMm"]} mm apart; ribs at that x (y range, m): ' + str(ribs))
    log.append('  scan point to the skin, mm (before the enclosure / final): ' + ', '.join(f'{k} {v["scanPointToSkinMm"]["beforeEnclosure"]} / {v["scanPointToSkinMm"]["final"]}' for k, v in info.items() if 'scanPointToSkinMm' in v))


def fit_perineum(V, F, SV, SF, fb, L, adjacency, log):
    """会阴、阴囊根部、臀沟前端、大腿根内侧：把皮肤贴到他自己的扫描皮肤上（那里拟合出的裆部比扫描的低，最多约 28 mm）。
    外生殖器本身所在的盒子里不动（那里保持简单的隆起，之后由开口工具切掉并换成扫描的皮肤）。返回 (新顶点, 信息)。
    Perineum, root of the scrotum, anterior end of the gluteal cleft and the upper inner thighs: the skin is laid onto his own scanned
    skin (the fitted crotch hung below the scanned one, by up to about 28 mm). Nothing moves inside the box of the genitalia themselves
    (the mound stays simple there; the opening tool cuts it out and grafts the scanned skin). Returns (new vertices, info)."""
    import igl
    hip = 0.5 * (L['hip_L'] + L['hip_R'])
    sm = lambda u: np.clip(u, 0, 1) ** 2 * (3 - 2 * np.clip(u, 0, 1))
    w = sm((0.080 - np.abs(V[:, 0] - hip[0])) / 0.030) * sm((hip[1] - 0.025 - V[:, 1]) / 0.03) * sm((V[:, 1] - (hip[1] - 0.17)) / 0.04)
    gen = [p for p in fb.deep_parts() if any(t in p['name'].lower() for t in ('penis', 'scrotum', 'testis', 'epididymis'))]
    if gen:
        gv = np.vstack([fb.mesh(p)[0] for p in gen])
        lo, hi = gv.min(0), gv.max(0)
        dbox = np.linalg.norm(np.maximum(np.maximum(lo - V, V - hi), 0), axis=1)     # 到盒子的距离，盒内为 0 / distance to the box, 0 inside
        w = w * sm((dbox - 0.006) / 0.02)
    sel = np.where(w > 0.01)[0]
    d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(V[sel]), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[:3]
    U = np.zeros_like(V)
    dv = c - V[sel]
    ln = np.linalg.norm(dv, axis=1)
    U[sel] = dv * np.minimum(1.0, 0.035 / np.maximum(ln, 1e-9))[:, None] * w[sel, None]
    A = adjacency(len(V), F)
    for _ in range(2):
        U = 0.5 * U + 0.5 * (A @ U)
    out = V + U
    core = sel[w[sel] > 0.9]
    after = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(out[core]), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[0])
    before = np.sqrt(d2[w[sel] > 0.9])
    q = lambda x: {'median': round(float(np.median(x) * 1000), 1), 'p95': round(float(np.percentile(x, 95) * 1000), 1), 'max': round(float(x.max() * 1000), 1)}
    info = {'vertices': int(len(sel)), 'coreVertices': int(len(core)), 'skinToScanBeforeMm': q(before), 'skinToScanAfterMm': q(after)}
    log.append(f'  perineum fitted to the scanned skin: {len(sel)} vertices ({len(core)} at full weight); skin-to-scan distance before {info["skinToScanBeforeMm"]}, after {info["skinToScanAfterMm"]} mm')
    return out, info


def raise_perineum(V, F, rim, adjacency, log, sigma=0.035):
    """女性：把裆部抬到会阴皮肤片外缘（vulva-rim-target.json，Wu 等 2015 的标本皮肤，CC BY 4.0）给出的位置。只用不在截面上的环点，加上三个孔口的中心。
    每个目标点处的位移 = 目标点 - 皮肤上离它最近的点，用高斯径向基（σ 25 mm）内插成平滑的位移场；外阴本身不做形状，皮肤在那里仍是光滑的封闭面。
    Female: the crotch is raised to where the rim of the perineal skin patch lies (vulva-rim-target.json, specimen skin of Wu et al. 2015,
    CC BY 4.0). Only rim points off the cut plane are used, plus the centres of the three orifices. The displacement at each target is
    target minus the closest point of the skin, interpolated into a smooth field by Gaussian radial basis functions (sigma 25 mm); no
    vulvar form is modelled, and the skin stays a smooth closed surface there."""
    import igl
    P = np.array(rim['rimLoop']['positions'])
    keep = ~np.array(rim['rimLoop']['onCutPlane'], bool)
    T = np.vstack([P[keep]] + [np.array(o['openingCentre'])[None] for o in rim.get('orifices', {}).values() if o.get('built')])
    T = T[::2] if len(T) > 80 else T
    d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(V), np.ascontiguousarray(F))[:3]
    D = T - c
    ln = np.linalg.norm(D, axis=1)
    D = D * np.minimum(1.0, 0.045 / np.maximum(ln, 1e-9))[:, None]
    K = np.exp(-((c[:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2))
    W = np.linalg.solve(K + 0.6 * np.eye(len(c)), D)
    near = np.where(np.linalg.norm(V - c.mean(0), axis=1) < 0.20)[0]
    U = np.zeros_like(V)
    U[near] = np.exp(-((V[near][:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * sigma ** 2)) @ W
    A = adjacency(len(V), F)
    for _ in range(12):
        U = 0.5 * U + 0.5 * (A @ U)
    out = V + U
    # 再对位置做拉普拉斯平滑：臀沟成一道光滑的沟、会阴成一个光滑的鞍面（权重随到目标点形心的距离衰减，90 mm 外为 0）
    # then Laplacian smoothing of positions: the cleft a smooth groove, the perineum a smooth saddle (weight falls with distance from the centroid of the targets, 0 beyond 90 mm)
    u_ = np.clip(1 - np.linalg.norm(out - c.mean(0), axis=1) / 0.09, 0, 1)
    wsm = u_ * u_ * (3 - 2 * u_) * (np.linalg.norm(U, axis=1) > 0.002)
    for _ in range(4):
        wsm = 0.5 * wsm + 0.5 * (A @ wsm)
    for _ in range(25):
        out = out + (0.5 * wsm)[:, None] * (A @ out - out)
    after = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(out), np.ascontiguousarray(F))[0])
    q = lambda x: {'median': round(float(np.median(x) * 1000), 1), 'p95': round(float(np.percentile(x, 95) * 1000), 1), 'max': round(float(x.max() * 1000), 1)}
    info = {'targets': int(len(T)), 'targetToSkinBeforeMm': q(ln), 'targetToSkinAfterMm': q(after), 'largestSkinMoveMm': round(float(np.linalg.norm(U, axis=1).max() * 1000), 1),
            'source': 'rim of the perineal skin patch in female-skin-grafted/vulva-rim-target.json (Wu et al. 2015, PLoS ONE 10(7): e0132226, CC BY 4.0), points off the cut plane, and the three orifice centres'}
    log.append(f'  perineum raised to the rim targets: {len(T)} targets; target-to-skin before {info["targetToSkinBeforeMm"]}, after {info["targetToSkinAfterMm"]} mm; largest skin move {info["largestSkinMoveMm"]} mm')
    return out, info


def construct_navel(V, F, fb, L, vertex_normals, log):
    """女性：构造的脐窝（不是扫描数据）。高度取第 4 腰椎椎体中心的高度（Shin 等，doi:10.14444/8651：脐多在 L4 水平；经协调方转述，本处未打开），
    在腹前正中线上；形状是圆滑的凹陷，深 5.3 mm、半高宽 17 mm——这两个数借自男性扫描皮肤上的脐，对她是假定值。
    Female: a constructed navel dimple (not scanned data). Its height is that of the centre of the fourth lumbar vertebral body (Shin et
    al., doi:10.14444/8651: the umbilicus clusters at L4; passed on by the coordinator, not opened here), on the anterior midline; a
    rounded depression 5.3 mm deep and 17 mm wide at half depth - both borrowed from the navel on the male's scanned skin, an assumption for her."""
    l4 = fb.verts('Fourth lumbar vertebra')
    y = float(np.median(l4[:, 1]))
    xc = float(np.median(l4[:, 0]))
    m = (np.abs(V[:, 0] - xc) < 0.01) & (np.abs(V[:, 1] - y) < 0.012) & (V[:, 2] > l4[:, 2].max())
    idx = np.where(m)[0]
    j = int(idx[np.argmax(V[idx, 2] - 5 * np.abs(V[idx, 0] - xc) - 5 * np.abs(V[idx, 1] - y))])
    n = vertex_normals(V, F)
    sel = np.where(np.linalg.norm(V - V[j], axis=1) < 0.026)[0]
    rr = np.linalg.norm(V[sel] - V[j], axis=1)
    r = -NAVEL_DEPTH * np.exp(-(rr / (NAVEL_WIDTH / 2 / 0.83)) ** 2) * np.clip((0.026 - rr) / 0.006, 0, 1)
    nc = n[sel].mean(0)
    nc /= np.linalg.norm(nc)
    out = V.copy()
    out[sel] = V[sel] + r[:, None] * nc
    info = {'constructed': True, 'mhrVertex': j, 'centreOnFinalSkin': np.round(out[j], 4).tolist(), 'normal': np.round(n[j], 3).tolist(), 'depthMm': NAVEL_DEPTH * 1000, 'widthMm': NAVEL_WIDTH * 1000,
            'level': 'centre of the body of the fourth lumbar vertebra', 'source': 'level: Shin et al., doi:10.14444/8651 (umbilicus at L4), as passed on by the coordinator, not opened here; depth and width borrowed from the male scan, an assumption'}
    log.append(f'  constructed navel at {info["centreOnFinalSkin"]} (L4 level y = {y:.4f}), {len(sel)} vertices, depth {NAVEL_DEPTH * 1000:.1f} mm')
    return out, info
