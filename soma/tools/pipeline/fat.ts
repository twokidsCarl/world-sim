// 皮下脂肪层：由本体几何推导，不来自任何数据源。
// Subcutaneous fat layer: derived from this body's own geometry, not taken from any source.
//
// 做法（体素）：皮肤曲面栅格化 → 沿三个轴向两侧都有皮肤的体素为“体内”；
// 深部实体（肌、骨、软骨、器官）并集做形态学闭运算得到深部包络；
// 脂肪 = 体内、不在深部包络内、且从皮肤内壁出发在限定深度内可达的体素。
// Method (voxels): rasterise the skin surface → voxels with skin on both sides along all three
// axes are "inside the body"; the union of the deep solids (muscle, bone,
// cartilage, organs) is closed morphologically into a deep envelope; fat = voxels inside the
// body, not inside the deep envelope, reachable from the inner wall of the skin within a depth cap.

import { computeNormals, type Mesh } from './geometry.ts'
import { smoothMesh, surfaceNets } from './derive.ts'
import { InsideTester, PointIndex, surfacePoints } from './register.ts'

export interface FatOptions {
  /** 体素边长（米） / voxel size (m) */
  voxel: number
  /** 深部包络闭运算半径（米） / closing radius of the deep envelope (m) */
  closing: number
  /** 自皮肤向内的最大深度（米） / largest depth below the skin (m) */
  maxDepth: number
  /** 表面平滑次数 / smoothing passes */
  smooth?: number
}

// 皮下脂肪的参数与分区 / parameters and regions of the subcutaneous fat
export const FAT_OPTIONS: FatOptions = { voxel: 0.003, closing: 0.012, maxDepth: 0.03, smooth: 2 }
export const FAT_DEEP_TISSUES = new Set<string>(['muscle', 'bone', 'cartilage', 'organ', 'brain', 'heart', 'gland', 'tendon', 'tooth'])
export const FAT_REGIONS: { key: string; fma: string; name: string }[] = [
  { key: 'head', fma: 'FMA53659', name: 'Subcutaneous tissue of head' },
  { key: 'neck', fma: 'FMA53660', name: 'Subcutaneous tissue of neck' },
  { key: 'trunk', fma: 'FMA50257', name: 'Subcutaneous tissue of trunk' },
  { key: 'upper_limb_L', fma: 'FMA58392', name: 'Subcutaneous tissue of left upper limb' },
  { key: 'upper_limb_R', fma: 'FMA58391', name: 'Subcutaneous tissue of right upper limb' },
  { key: 'lower_limb_L', fma: 'FMA58396', name: 'Subcutaneous tissue of left lower limb' },
  { key: 'lower_limb_R', fma: 'FMA58395', name: 'Subcutaneous tissue of right lower limb' },
]
/** 骨骼名 → 脂肪分区；脂肪体素归属最近骨骼所在的区 / bone name → fat region; a fat voxel belongs to the region of its nearest bone */
export function fatRegionOfBone(name: string): string {
  const side = /\bleft\b/i.test(name) ? 'L' : /\bright\b/i.test(name) ? 'R' : ''
  if (side && /humerus|radius|ulna|metacarpal|finger|thumb|scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate/i.test(name)) return `upper_limb_${side}`
  if (side && /femur|tibia|fibula|patella|metatarsal|toe|calcaneus|talus|cuboid|cuneiform|navicular|foot/i.test(name)) return `lower_limb_${side}`
  if (/cervical vertebra|^Atlas$|^Axis$|hyoid/i.test(name)) return 'neck'
  if (/frontal|parietal|occipital|temporal|sphenoid|ethmoid|vomer|mandible|maxilla|zygomatic|nasal|lacrimal|palatine|concha/i.test(name)) return 'head'
  return 'trunk'
}

/** 是否为推导的皮下脂肪部件（男性 SOMA_fat_*，女性 W_SOMA_fat_*） / is this a derived subcutaneous fat part (male SOMA_fat_*, female W_SOMA_fat_*) */
export const isFatPart = (id: string): boolean => /^(W_)?SOMA_fat_/.test(id)

export interface FatRegionInput {
  /** 区域键 / region key */
  region: string
  /** 该区域骨骼的表面采样点 / surface samples of the region's bones */
  bonePoints: Float32Array
}

export interface FatRegion {
  region: string
  mesh: Mesh
  /** 体素体积（立方米） / voxel volume (m³) */
  volume: number
  /** 局部厚度（米）：在深部界面上量到皮肤的体素步数 × 体素边长 / local thickness (m): voxel steps from the skin, read at the deep interface */
  thickness: { p10: number; median: number; p90: number; max: number }
  /** 该区域皮肤体素中其下有脂肪的比例 / share of the region's skin voxels that have fat under them */
  skinCovered: number
  /** 因贴近皮肤而向内移动的顶点比例 / share of vertices moved inward off the skin */
  verticesPulledIn: number
}

export interface FatResult {
  regions: FatRegion[]
  /** 体内体积（立方米），用于自检 / volume inside the skin (m³), a sanity check */
  bodyVolume: number
  /** 体素网格尺寸 / voxel grid dimensions */
  grid: [number, number, number]
  /** 皮肤是否为单层壁（由深部体素判别） / whether the skin is single-walled (told from the deep voxels) */
  skinSingleWalled: boolean
}

/**
 * 推导皮下脂肪并按区域切分成各自封闭的网格。
 * Derives the subcutaneous fat and cuts it into one closed mesh per region.
 * @param skin 皮肤网格（可为双层壁） / the skin mesh (may be double-walled)
 * @param deep 深部实体（封闭网格） / deep solids (closed meshes)
 * @param regions 区域及其骨骼采样；体素归属最近骨骼的区域 / regions with bone samples; a voxel belongs to the region of its nearest bone
 */
export function deriveFat(skin: Mesh, deep: Mesh[], regions: FatRegionInput[], opts: FatOptions): FatResult {
  const h = opts.voxel
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < skin.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, skin.positions[i + k]!)
    b[k + 3] = Math.max(b[k + 3]!, skin.positions[i + k]!)
  }
  const o = [b[0]! - 3 * h, b[1]! - 3 * h, b[2]! - 3 * h]
  const dims = [0, 1, 2].map((k) => Math.ceil((b[k + 3]! + 3 * h - o[k]!) / h) + 1) as [number, number, number]
  const [nx, ny, nz] = dims
  const N = nx * ny * nz
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const STEP = [1, -1, nx, -nx, nx * ny, -nx * ny]
  // 边界一圈体素不参与，邻域访问无需判界 / the outermost shell of voxels is never processed, so neighbours need no bounds checks
  const border = new Uint8Array(N)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) border[at(i, j, k)] = 1
  }

  // 1. 皮肤屏障 / the skin barrier
  const SKIN = 1
  const OUT = 2
  const DEEP = 3
  const FAT = 4
  const cls = new Uint8Array(N)
  const sp = surfacePoints(skin, h * 0.45)
  for (let p = 0; p < sp.length; p += 3) {
    cls[at(Math.round((sp[p]! - o[0]!) / h), Math.round((sp[p + 1]! - o[1]!) / h), Math.round((sp[p + 2]! - o[2]!) / h))] = SKIN
  }
  // 2. 体外 / outside
  // 皮肤网格是带厚度的封闭壳，在口、鼻等处内外壁相连，体腔与体外在拓扑上相通，泛洪法不可用。
  // 改用三轴判据：沿 X、Y、Z 三个方向两侧都有皮肤体素的才算体内。
  // The skin is a closed shell with thickness whose walls join at the mouth, nostrils and so on, so
  // the body cavity is topologically connected to the outside and a flood fill leaks. Instead a
  // voxel is inside the body when it has skin voxels on both sides along each of X, Y and Z.
  {
    const between = new Uint8Array(N)
    const axes: [number, number, number, number][] = [[nx, ny, nz, 1], [ny, nx, nz, nx], [nz, nx, ny, nx * ny]]
    axes.forEach(([len, na, nb, step], axis) => {
      for (let v = 0; v < nb; v++) for (let u = 0; u < na; u++) {
        const base = axis === 0 ? at(0, u, v) : axis === 1 ? at(u, 0, v) : at(u, v, 0)
        let first = -1
        let last = -1
        for (let t = 0; t < len; t++) if (cls[base + t * step] === SKIN) { if (first < 0) first = t; last = t }
        for (let t = first + 1; t < last; t++) between[base + t * step]!++
      }
    })
    for (let c = 0; c < N; c++) if (cls[c] !== SKIN && (between[c] !== 3 || border[c])) cls[c] = OUT
  }
  let inside = 0
  for (let c = 0; c < N; c++) if (!cls[c]) inside++

  // 3. 深部实体并集，再闭运算 / union of the deep solids, then closing
  const solid = new Uint8Array(N)
  for (const m of deep) {
    const t = new InsideTester(m, 64)
    const tb = t.bbox
    const i0 = Math.max(1, Math.floor((tb[0] - o[0]!) / h))
    const i1 = Math.min(nx - 2, Math.ceil((tb[3] - o[0]!) / h))
    const j0 = Math.max(1, Math.floor((tb[1] - o[1]!) / h))
    const j1 = Math.min(ny - 2, Math.ceil((tb[4] - o[1]!) / h))
    const k0 = Math.max(1, Math.floor((tb[2] - o[2]!) / h))
    const k1 = Math.min(nz - 2, Math.ceil((tb[5] - o[2]!) / h))
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = at(i, j, k)
      if (solid[c] || cls[c]) continue
      if (t.contains(o[0]! + i * h, o[1]! + j * h, o[2]! + k * h)) solid[c] = 1
    }
  }
  const morph = (src: Uint8Array, grow: boolean): Uint8Array => {
    const out = Uint8Array.from(src)
    const want = grow ? 1 : 0
    for (let c = 0; c < N; c++) {
      if (border[c] || src[c] === want) continue
      for (const s of STEP) if (src[c + s] === want) { out[c] = want; break }
    }
    return out
  }
  const steps = Math.max(0, Math.round(opts.closing / h))
  // 闭运算只作用于实体占据场；结果中落在皮肤或体外的体素不算深部
  // the closing works on the solid occupancy alone; closed voxels that are skin or outside do not count as deep
  let closed: Uint8Array = solid
  for (let s = 0; s < steps; s++) closed = morph(closed, true)
  for (let s = 0; s < steps; s++) closed = morph(closed, false)
  for (let c = 0; c < N; c++) if ((closed[c] || solid[c]) && !cls[c]) cls[c] = DEEP

  // 4. 从皮肤向内逐层生长 / grow inward from the skin, layer by layer
  const depth = new Uint8Array(N)
  const queue = new Int32Array(N)
  let head = 0
  let tail = 0
  for (let c = 0; c < N; c++) {
    if (cls[c] !== SKIN || border[c]) continue
    for (const s of STEP) {
      const n = c + s
      if (cls[n] === 0) { cls[n] = FAT; depth[n] = 1; queue[tail++] = n }
    }
  }
  const maxSteps = Math.max(1, Math.round(opts.maxDepth / h))
  while (head < tail) {
    const c = queue[head++]!
    if (depth[c]! >= maxSteps) continue
    for (const s of STEP) {
      const n = c + s
      if (cls[n] !== 0) continue
      cls[n] = FAT
      depth[n] = depth[c]! + 1
      queue[tail++] = n
    }
  }

  // 5. 区域归属：最近骨骼 / region of each fat voxel: nearest bone
  const all: number[] = []
  const owner: number[] = []
  regions.forEach((r, ri) => {
    for (let p = 0; p < r.bonePoints.length; p += 3) {
      all.push(r.bonePoints[p]!, r.bonePoints[p + 1]!, r.bonePoints[p + 2]!)
      owner.push(ri)
    }
  })
  const bones = new PointIndex(Float32Array.from(all), 0.02)
  const I = new Int32Array(1)
  const D = new Float64Array(1)
  const regionOf = new Int8Array(N).fill(-1)
  const regionAt = (c: number): number => {
    const i = c % nx
    const j = Math.floor(c / nx) % ny
    const k = Math.floor(c / (nx * ny))
    bones.nearest(o[0]! + i * h, o[1]! + j * h, o[2]! + k * h, 1, I, D)
    return owner[I[0]!]!
  }
  for (let c = 0; c < N; c++) if (cls[c] === FAT) regionOf[c] = regionAt(c)

  // 6. 每个区域：占据场 → 模糊 → 等值面；贴皮肤的顶点沿法线向内收
  // per region: occupancy → blur → iso-surface; vertices touching the skin are pulled in along the normal
  const skinIndex = new PointIndex(surfacePoints(skin, 0.0015), 0.004)
  const skinTester = new InsideTester(skin, 256)
  const CLEAR = 0.0008
  // 皮肤是双层壁（有厚度的壳）还是单层壁？双层壁时 skinTester.contains 表示“在皮肤壁的实质内”，
  // 单层壁时它表示“在体内”。用深部体素来判别：深部体素多数被“包含”的就是单层壁。
  // 单层壁时，脂肪顶点只在贴着皮肤或落到体外时才向内收（否则每个顶点都会被当成“在皮肤内”而内收 6 mm）。
  // Is the skin double-walled (a shell with thickness) or single-walled? For a double wall
  // skinTester.contains means "inside the wall material", for a single wall "inside the body". Deep
  // voxels tell them apart: when most of them are "contained" the skin is single-walled. Fat vertices
  // under a single-walled skin are pulled in only when they touch the skin or lie outside the body
  // (otherwise every vertex would count as "inside the skin" and be pulled in by 6 mm).
  let deepSeen = 0
  let deepContained = 0
  for (let c = 0; c < N && deepSeen < 4000; c += 97) {
    if (cls[c] !== DEEP) continue
    deepSeen++
    if (skinTester.contains(o[0]! + (c % nx) * h, o[1]! + (Math.floor(c / nx) % ny) * h, o[2]! + Math.floor(c / (nx * ny)) * h)) deepContained++
  }
  const singleWall = deepSeen > 0 && deepContained > deepSeen / 2
  const out: FatRegion[] = []
  regions.forEach((r, ri) => {
    let count = 0
    let occ = new Float32Array(N)
    const thick: number[] = []
    for (let c = 0; c < N; c++) {
      if (regionOf[c] !== ri) continue
      occ[c] = 1
      count++
      let atDeep = false
      for (const s of STEP) if (cls[c + s] === DEEP) { atDeep = true; break }
      if (atDeep) thick.push(depth[c]! * h)
    }
    let skinVox = 0
    let skinWithFat = 0
    for (let c = 0; c < N; c++) {
      if (cls[c] !== SKIN || border[c]) continue
      // 只统计内壁一侧的皮肤体素 / only skin voxels on the inner-wall side
      let inner = false
      let fat = false
      let mine = false
      for (const s of STEP) {
        const v = cls[c + s]
        if (v === FAT) { fat = true; inner = true; if (regionOf[c + s] === ri) mine = true } else if (v === DEEP) inner = true
      }
      if (!inner) continue
      if (fat ? mine : regionAt(c) === ri) {
        skinVox++
        if (fat) skinWithFat++
      }
    }
    if (!count) return
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const next = new Float32Array(N)
      const s = di + nx * (dj + ny * dk)
      for (let c = 0; c < N; c++) if (!border[c]) next[c] = (occ[c - s]! + occ[c]! + occ[c + s]!) / 3
      occ = next
    }
    const mesh = surfaceNets(occ, dims, 0.5)
    for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) mesh.positions[i + k] = o[k]! + mesh.positions[i + k]! * h
    smoothMesh(mesh, opts.smooth ?? 2)
    const normals = computeNormals(mesh)
    let pulled = 0
    const nv = mesh.positions.length / 3
    for (let v = 0; v < nv; v++) {
      let moved = false
      for (let step = 0; step < 12; step++) {
        const x = mesh.positions[3 * v]!
        const y = mesh.positions[3 * v + 1]!
        const z = mesh.positions[3 * v + 2]!
        const near = skinIndex.distance(x, y, z, CLEAR * 2) < CLEAR
        if (!near && skinTester.contains(x, y, z) === singleWall) break
        mesh.positions[3 * v] = x - normals[3 * v]! * 0.0005
        mesh.positions[3 * v + 1] = y - normals[3 * v + 1]! * 0.0005
        mesh.positions[3 * v + 2] = z - normals[3 * v + 2]! * 0.0005
        moved = true
      }
      if (moved) pulled++
    }
    thick.sort((a, c) => a - c)
    const q = (f: number) => (thick.length ? thick[Math.min(thick.length - 1, Math.floor(f * thick.length))]! : 0)
    out.push({
      region: r.region, mesh, volume: count * h ** 3,
      thickness: { p10: q(0.1), median: q(0.5), p90: q(0.9), max: q(1) },
      skinCovered: skinVox ? skinWithFat / skinVox : 0,
      verticesPulledIn: nv ? pulled / nv : 0,
    })
  })
  return { regions: out, bodyVolume: inside * h ** 3, grid: dims, skinSingleWalled: singleWall }
}
