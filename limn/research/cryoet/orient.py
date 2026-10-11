"""
核糖体的朝向矩阵该怎么读？用断层扫描本身来判定。
How should the ribosomes' orientation matrices be read? Let the tomogram itself decide.

CZ CryoET 数据门户的数据集 10003（肺炎支原体，TS_04）给了 331 个核糖体的位置和一个 3x3 朝向矩阵，
但没有说矩阵是把参考模型转到粒子上，还是反过来。做法：按每一种读法，把每个粒子周围的一小块密度
“转回”参考坐标系再平均。读对了，331 块叠出来是一个清楚的核糖体，和原子模型（PDB 7P6Z）算出的密度
相比有清楚的形状；读错了，叠出来只是一个模糊的球。读法定下来以后，再找模板坐标系与原子模型坐标系之间的
固定旋转（原样的和镜像的模型各找一次），最后在另一张独立的断层扫描上核对。

Dataset 10003 of the CZ CryoET Data Portal (Mycoplasma pneumoniae, TS_04) gives the positions of
331 ribosomes and a 3x3 orientation matrix for each, without saying whether the matrix turns the
reference onto the particle or the other way. So, for each reading, the small block of density
around every particle is turned back into the reference frame and averaged. Read correctly, 331
blocks add up to a clear ribosome; read wrongly, they add up to a blurred ball. With the reading
settled, the fixed rotation between the template's frame and the atomic model's (PDB 7P6Z) is
searched for, once for the model as it is and once mirrored, and the result is checked on a second,
independent tomogram.

运行 / run:
  uv run --no-project --with numpy --with scipy --with numcodecs python -I research/cryoet/orient.py
"""
import gzip, io, json, sys, urllib.request, ssl
import numpy as np
from numcodecs import Blosc
from scipy import ndimage

CTX = ssl._create_unverified_context()
BASE = 'https://files.cryoetdataportal.cziscience.com/10003/TS_04/Reconstructions/VoxelSpacing6.802'
ZARR = BASE + '/Tomograms/100/TS_04.zarr/1'          # 二倍合并的一层：13.604 Å / the level binned by two: 13.604 Å
PICKS = BASE + '/Annotations/100/chloramphenicol_bound_70s_ribosome-1.0_orientedpoint.ndjson'
VOX = 6.802 * 2
SHAPE, CHUNK = (225, 464, 464), 256
BOX = 36                                               # 36 体素 = 490 Å / 36 voxels = 490 Å


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'limn research'}), context=CTX, timeout=120).read()


def tomogram():
    vol = np.zeros(SHAPE, np.float32)
    codec = Blosc()
    for iy in range(2):
        for ix in range(2):
            a = np.frombuffer(codec.decode(get(f'{ZARR}/0/{iy}/{ix}')), '<f4').reshape(CHUNK, CHUNK, CHUNK)
            z1, y0, x0 = SHAPE[0], iy * CHUNK, ix * CHUNK
            y1, x1 = min(SHAPE[1], y0 + CHUNK), min(SHAPE[2], x0 + CHUNK)
            vol[:z1, y0:y1, x0:x1] = a[:z1, :y1 - y0, :x1 - x0]
    return vol


def model_density(pdb='7P6Z', centre=None):
    """原子模型的 P 和 Cα 原子撒进同样大小的盒子，模糊到约 30 Å。`centre`：盒子中心对应模型坐标里的哪一点（Å），
    缺省是原子的质心；给出密度图的中心时，模型就按它在那张图里的位置摆。
    The P and Cα atoms of an atomic model dropped into a box of the same size, blurred to about 30 Å. `centre`: the
    point of the model's coordinates (Å) that goes at the centre of the box; the atoms' centroid by default, or the
    centre of a density map, in which case the model sits as it does in that map."""
    text = gzip.decompress(get(f'https://files.rcsb.org/download/{pdb}.cif.gz')).decode()
    pts, cols = [], None
    names = []
    for line in text.split('\n'):
        if line.startswith('_atom_site.'):
            names.append(line.strip().split('.')[1])
        elif line.startswith(('ATOM', 'HETATM')) and names:
            f = line.split()
            if cols is None:
                cols = [names.index(k) for k in ('label_atom_id', 'Cartn_x', 'Cartn_y', 'Cartn_z')]
            if f[cols[0]] in ('P', 'CA'):
                pts.append([float(f[cols[1]]), float(f[cols[2]]), float(f[cols[3]])])
    p = np.array(pts)
    global CENTROID
    CENTROID = p.mean(0)
    p -= p.mean(0) if centre is None else np.array(centre)
    grid = np.zeros((BOX, BOX, BOX), np.float32)
    idx = np.round(p / VOX).astype(int) + BOX // 2          # x, y, z
    ok = ((idx >= 0) & (idx < BOX)).all(1)
    np.add.at(grid, (idx[ok, 2], idx[ok, 1], idx[ok, 0]), 1)  # 数组按 z, y, x 排 / the array is ordered z, y, x
    return ndimage.gaussian_filter(grid, 1.0), len(p)


def average(vol, picks, transpose, n=None):
    """把每个粒子的小块按 R（或 R 的转置）采样回参考坐标系后平均 / sample every particle's block back into the reference frame by R (or its transpose) and average"""
    half = BOX // 2
    g = np.mgrid[-half:half, -half:half, -half:half].astype(np.float32)   # z, y, x 偏移 / offsets in z, y, x
    ref = np.stack([g[2].ravel(), g[1].ravel(), g[0].ravel()])            # 参考坐标系里的 x, y, z / x, y, z in the reference frame
    acc = np.zeros(BOX ** 3, np.float32)
    used = 0
    for p in picks[:n]:
        R = np.array(p['xyz_rotation_matrix'], np.float32)
        if transpose:
            R = R.T
        c = np.array([p['location']['x'], p['location']['y'], p['location']['z']], np.float32) / 2   # 这一层的体素 / voxels of this level
        xyz = R @ ref + c[:, None]
        if (xyz.min(1) < 1).any() or xyz[0].max() > SHAPE[2] - 2 or xyz[1].max() > SHAPE[1] - 2 or xyz[2].max() > SHAPE[0] - 2:
            continue
        acc += ndimage.map_coordinates(vol, [xyz[2], xyz[1], xyz[0]], order=1)
        used += 1
    return (acc / max(used, 1)).reshape(BOX, BOX, BOX), used


def best_correlation(a, b):
    """允许平移时两块密度的最大归一化互相关 / the greatest normalised cross-correlation of two blocks over all shifts"""
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    cc = np.fft.ifftn(np.fft.fftn(a) * np.conj(np.fft.fftn(b))).real / a.size
    return float(cc.max())


def structure(avg):
    """减去径向平均后还剩多少起伏：模糊的球接近 0，清楚的核糖体明显大于 0
    how much relief is left once the radial average is removed: near 0 for a blurred ball, well above it for a clear ribosome"""
    half = BOX // 2
    z, y, x = np.mgrid[-half:half, -half:half, -half:half]
    r = np.sqrt(x * x + y * y + z * z).astype(int)
    inside = r < half - 2
    radial = np.bincount(r[inside], avg[inside]) / np.maximum(np.bincount(r[inside]), 1)
    rest = avg[inside] - radial[r[inside]]
    return float(rest.std() / (avg[inside].std() + 1e-9))


def rotate(vol, rot):
    """绕盒子中心旋转一块密度（rot 作用在 x, y, z 上）/ rotate a block about the centre of the box (rot acts on x, y, z)"""
    m = rot[::-1, ::-1]                       # 换成数组的 z, y, x 顺序 / into the array's z, y, x order
    c = np.array([BOX / 2 - 0.5] * 3)
    return ndimage.affine_transform(vol, m.T, offset=c - m.T @ c, order=1)


def peak(a, b):
    """互相关的最大值和它所在的平移（x, y, z，体素）：a(r + k) 对上 b(r)
    the greatest cross-correlation and the shift it is at (x, y, z, in voxels): a(r + k) matches b(r)"""
    a = (a - a.mean()) / (a.std() + 1e-9)
    b = (b - b.mean()) / (b.std() + 1e-9)
    cc = np.fft.ifftn(np.fft.fftn(a) * np.conj(np.fft.fftn(b))).real / a.size
    k = [int(i) if i < BOX // 2 else int(i) - BOX for i in np.unravel_index(cc.argmax(), cc.shape)]
    return float(cc.max()), k[::-1]


def search(avg, model, tries=4000, seed=1, starts=6):
    """随机试许多个整体旋转，再从最好的几个出发细找。返回各起点收敛到的 (相关, 旋转)，以及随机旋转的相关的中位数。
    Try many whole rotations at random, then refine from the best few. Returns the (correlation, rotation) each start
    converges to, and the median correlation over the random rotations."""
    from scipy.spatial.transform import Rotation
    scored = sorted(((best_correlation(avg, rotate(model, r)), r) for r in Rotation.random(tries, random_state=seed).as_matrix()), key=lambda t: -t[0])
    rng = np.random.default_rng(seed)
    out = []
    for c0, r0 in scored[:starts]:
        best = (c0, r0)
        for step in (12, 6, 3, 1.5):
            for _ in range(60):
                rot = Rotation.from_rotvec(rng.normal(size=3) * np.radians(step) / 1.7).as_matrix() @ best[1]
                c = best_correlation(avg, rotate(model, rot))
                if c > best[0]:
                    best = (c, rot)
        out.append(best)
    return sorted(out, key=lambda t: -t[0]), float(np.median([c for c, _ in scored]))


def load(run):
    """一张断层扫描（二倍合并的一层）和它的粒子 / one tomogram (the level binned by two) and its picks"""
    global ZARR, PICKS, SHAPE
    ZARR = f'{BASE.replace("TS_04", run)}/Tomograms/100/{run}.zarr/1'
    PICKS = f'{BASE.replace("TS_04", run)}/Annotations/100/chloramphenicol_bound_70s_ribosome-1.0_orientedpoint.ndjson'
    SHAPE = tuple(json.loads(get(ZARR + '/.zarray'))['shape'])
    picks = [json.loads(l) for l in get(PICKS).decode().split('\n') if l.strip()]
    vol = tomogram()
    return -(vol - vol.mean()) / vol.std(), picks   # 电镜里蛋白是暗的，取反让它为正 / protein is dark in the tomogram; negate so it is positive


def sphere():
    half = BOX // 2
    z, y, x = np.mgrid[-half:half, -half:half, -half:half]
    return (x * x + y * y + z * z) < 14 * 14


def main():
    model, natoms = model_density()
    out = {'model': '7P6Z', 'atoms': natoms, 'centroid': np.round(CENTROID, 2).tolist(), 'voxel': VOX}
    rng = np.random.default_rng(0)

    # 第一步：矩阵怎么读。按每种读法叠出平均，看它有没有形状
    # step one: how to read the matrix. Average under each reading and see whether the result has any shape
    vol, picks = load('TS_04')
    shuffled = [dict(p, xyz_rotation_matrix=picks[j]['xyz_rotation_matrix']) for p, j in zip(picks, rng.permutation(len(picks)))]
    relief = {}
    for label, ps in (('', picks), ('shuffled ', shuffled)):
        for transpose in (False, True):
            avg, used = average(vol, ps, transpose)
            relief[label + ('R^T' if transpose else 'R')] = round(structure(ndimage.gaussian_filter(avg, 1.0)), 3)
    out['relief'] = relief
    print('relief of the average under each reading:', relief, flush=True)

    # 第二步：模板坐标系和原子模型坐标系之间的固定旋转，原样的模型和镜像的模型各找一次
    # step two: the fixed rotation between the template's frame and the atomic model's, once for the model as it is and once mirrored
    avg = ndimage.gaussian_filter(average(vol, picks, False)[0], 1.0) * sphere()
    fits = {}
    for mirror in (False, True):
        m = model[:, :, ::-1] if mirror else model
        found, median = search(avg, m)
        c, rot = found[0]
        fits[mirror] = rot
        out['mirrored' if mirror else 'plain'] = {'correlation': round(c, 3), 'other_starts': [round(x[0], 3) for x in found[1:]], 'median_over_random_rotations': round(median, 3), 'rotation': np.round(rot, 5).tolist(), 'shift_voxels_xyz': peak(avg, rotate(m, rot))[1]}
        print('mirrored' if mirror else 'plain', out['mirrored' if mirror else 'plain'], flush=True)

    # 第三步：换一张独立的断层扫描，把上面的旋转原样用上去，再独立找一次，看两者差多少度
    # step three: on an independent tomogram, apply the rotation above unchanged, then search afresh, and see how many degrees apart the two are
    vol2, picks2 = load('TS_05')
    avg2 = ndimage.gaussian_filter(average(vol2, picks2, False)[0], 1.0) * sphere()
    check = {}
    for mirror in (False, True):
        m = model[:, :, ::-1] if mirror else model
        found, _ = search(avg2, m, tries=3000, seed=7, starts=1)
        angle = float(np.degrees(np.arccos(np.clip((np.trace(found[0][1].T @ fits[mirror]) - 1) / 2, -1, 1))))
        check['mirrored' if mirror else 'plain'] = {'with_TS_04_rotation': round(best_correlation(avg2, rotate(m, fits[mirror])), 3), 'independent_search': round(found[0][0], 3), 'degrees_apart': round(angle, 1)}
    out['TS_05'] = check
    print('TS_05:', check)
    print(json.dumps(out))


if __name__ == '__main__':
    main()
