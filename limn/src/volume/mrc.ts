import { t, noteError } from '../i18n'

/**
 * MRC / CCP4 密度图：电镜数据库 EMDB 存放三维密度的格式。文件头 1024 字节，后面可以有一段扩展头，
 * 然后是体素值。这里读成 x 最快、z 最慢的 32 位浮点数组，并给出每个体素的大小和第一个体素的坐标（Å）。
 *
 * MRC / CCP4 density maps, the format in which the EMDB keeps three-dimensional density. A
 * 1024-byte header, an optional extended header, then the voxel values. They are read here into
 * a 32-bit float array with x fastest and z slowest, with the size of a voxel and the coordinates
 * of the first voxel in Å.
 */
export interface Volume {
  nx: number
  ny: number
  nz: number
  /** 体素值，下标 = x + nx * (y + ny * z) / voxel values, index = x + nx * (y + ny * z) */
  data: Float32Array | Uint8Array
  /** 体素的边长（Å）/ edge lengths of a voxel, Å */
  voxel: [number, number, number]
  /** 下标 (0,0,0) 的体素中心的坐标（Å）/ coordinates of the centre of voxel (0,0,0), Å */
  origin: [number, number, number]
}

export function parseMrc(buffer: ArrayBuffer): Volume {
  if (buffer.byteLength < 1024) throw noteError('error.mrc.short')
  let little = true
  let v = new DataView(buffer)
  // 字节序：模式号应当是个小整数 / byte order: the mode number should be a small integer
  if (v.getInt32(12, true) < 0 || v.getInt32(12, true) > 200) little = false
  const i32 = (word: number) => v.getInt32(word * 4, little), f32 = (word: number) => v.getFloat32(word * 4, little)
  const n = [i32(0), i32(1), i32(2)], mode = i32(3), start = [i32(4), i32(5), i32(6)], m = [i32(7), i32(8), i32(9)]
  const cell = [f32(10), f32(11), f32(12)]
  // 文件里的第 1、2、3 根轴各对应 x、y、z 中的哪一个（1 = x）/ which of x, y, z each of the file's three axes is (1 = x)
  const axis = [i32(16), i32(17), i32(18)]
  const ext = i32(23)
  const shift = [f32(49), f32(50), f32(51)]
  if (!n.every((k) => k > 0 && k < 4096) || ![1, 2, 3].every((a) => axis.includes(a))) throw noteError('error.mrc.header')
  const count = n[0]! * n[1]! * n[2]!
  const offset = 1024 + Math.max(0, ext)
  const bytes = mode === 0 ? 1 : mode === 1 || mode === 6 || mode === 12 ? 2 : mode === 2 ? 4 : 0
  if (!bytes) throw noteError('error.mrc.mode', { mode })
  if (buffer.byteLength < offset + count * bytes) throw noteError('error.mrc.truncated')
  v = new DataView(buffer, offset)
  const half = (h: number) => {
    // IEEE 半精度浮点 / IEEE half-precision float
    const e = (h >> 10) & 31, f = h & 1023, s = h & 0x8000 ? -1 : 1
    return s * (e === 0 ? f * 2 ** -24 : e === 31 ? (f ? NaN : Infinity) : (1 + f / 1024) * 2 ** (e - 15))
  }
  const read = (k: number) => (mode === 2 ? v.getFloat32(k * 4, little) : mode === 0 ? v.getInt8(k) : mode === 1 ? v.getInt16(k * 2, little) : mode === 6 ? v.getUint16(k * 2, little) : half(v.getUint16(k * 2, little)))

  // 把文件的轴序换成 x, y, z / reorder the file's axes to x, y, z
  const fileAxisOf = [axis.indexOf(1), axis.indexOf(2), axis.indexOf(3)] // 对 x、y、z：它是文件的第几根轴 / for x, y, z: which file axis it is
  const dims = [n[fileAxisOf[0]!]!, n[fileAxisOf[1]!]!, n[fileAxisOf[2]!]!]
  const data = new Float32Array(count)
  if (axis[0] === 1 && axis[1] === 2 && axis[2] === 3) {
    for (let k = 0; k < count; k++) data[k] = read(k)
  } else {
    const idx = [0, 0, 0]
    let k = 0
    for (idx[2] = 0; idx[2]! < n[2]!; idx[2]!++) for (idx[1] = 0; idx[1]! < n[1]!; idx[1]!++) for (idx[0] = 0; idx[0]! < n[0]!; idx[0]!++) {
      const x = idx[fileAxisOf[0]!]!, y = idx[fileAxisOf[1]!]!, z = idx[fileAxisOf[2]!]!
      data[x + dims[0]! * (y + dims[1]! * z)] = read(k++)
    }
  }
  const voxel: [number, number, number] = [0, 1, 2].map((a) => (m[a]! > 0 && cell[a]! > 0 ? cell[a]! / m[a]! : 1)) as [number, number, number]
  // 起点：文件头里每根轴的起始下标乘体素大小，再加上原点偏移 / the start: each axis's first index times the voxel size, plus the origin shift
  const origin = [0, 1, 2].map((a) => start[fileAxisOf[a]!]! * voxel[a]! + (Number.isFinite(shift[a]!) ? shift[a]! : 0)) as [number, number, number]
  return { nx: dims[0]!, ny: dims[1]!, nz: dims[2]!, data, voxel, origin }
}

/**
 * 把体数据按整数倍合并体素（取平均），直到最长的一边不超过 `maxDim`。
 * Bin a volume by a whole factor (averaging voxels) until its longest side is at most `maxDim`.
 */
export function bin(vol: Volume, maxDim: number): Volume {
  const f = Math.ceil(Math.max(vol.nx, vol.ny, vol.nz) / maxDim)
  if (f <= 1) return vol
  const nx = Math.floor(vol.nx / f), ny = Math.floor(vol.ny / f), nz = Math.floor(vol.nz / f)
  const data = new Float32Array(nx * ny * nz)
  const inv = 1 / (f * f * f)
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        let s = 0
        for (let dz = 0; dz < f; dz++) for (let dy = 0; dy < f; dy++) {
          const row = vol.nx * (y * f + dy + vol.ny * (z * f + dz)) + x * f
          for (let dx = 0; dx < f; dx++) s += vol.data[row + dx]!
        }
        data[x + nx * (y + ny * z)] = s * inv
      }
  return {
    nx, ny, nz, data,
    voxel: [vol.voxel[0] * f, vol.voxel[1] * f, vol.voxel[2] * f],
    // 合并后第一个体素的中心在原来 f 个体素的正中 / the first binned voxel is centred on the middle of the f voxels it replaces
    origin: [vol.origin[0] + ((f - 1) / 2) * vol.voxel[0], vol.origin[1] + ((f - 1) / 2) * vol.voxel[1], vol.origin[2] + ((f - 1) / 2) * vol.voxel[2]],
  }
}

/**
 * 等值面上的点（“表面网”法）：每个被等值面穿过的小格出一个点，位置是它各条棱上穿越点的平均。
 * 返回 Å 为单位的 x, y, z。画的时候在每个点上放一个小球，球连成面。
 *
 * Points on an isosurface (the "surface nets" method): each cell the surface passes through gives
 * one point, at the mean of the crossings on its edges. Returns x, y, z in Å. For drawing, a small
 * sphere goes on every point, and together the spheres make the surface.
 */
export function surfacePoints(vol: Volume, level: number): Float32Array {
  const { nx, ny, nz, data, voxel, origin } = vol
  const out: number[] = []
  const at = (x: number, y: number, z: number) => data[x + nx * (y + ny * z)]!
  // 小格的 12 条棱：两个端点在格内的偏移 / the 12 edges of a cell, as the offsets of their two ends
  const E = [[0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 1, 0], [0, 0, 1, 1, 0, 1], [0, 1, 1, 1, 1, 1], [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [0, 0, 1, 0, 1, 1], [1, 0, 1, 1, 1, 1], [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [0, 1, 0, 0, 1, 1], [1, 1, 0, 1, 1, 1]]
  for (let z = 0; z < nz - 1; z++)
    for (let y = 0; y < ny - 1; y++)
      for (let x = 0; x < nx - 1; x++) {
        let sx = 0, sy = 0, sz = 0, hits = 0
        for (const e of E) {
          const a = at(x + e[0]!, y + e[1]!, z + e[2]!), b = at(x + e[3]!, y + e[4]!, z + e[5]!)
          if (a >= level === b >= level) continue
          const t = (level - a) / (b - a)
          sx += e[0]! + (e[3]! - e[0]!) * t
          sy += e[1]! + (e[4]! - e[1]!) * t
          sz += e[2]! + (e[5]! - e[2]!) * t
          hits++
        }
        if (hits) out.push(origin[0] + (x + sx / hits) * voxel[0], origin[1] + (y + sy / hits) * voxel[1], origin[2] + (z + sz / hits) * voxel[2])
      }
  return new Float32Array(out)
}

/**
 * 等值面的三角网格（“表面网”法）：顶点就是 surfacePoints 给出的那些点，顺序也相同；每条被等值面穿过的
 * 格点连线，把围着它的四个小格的顶点连成一个四边形（两个三角形）。三角形的绕向使法线从高值指向低值，
 * 也就是从物体里面指向外面。返回顶点坐标和三角形的顶点下标。
 *
 * A triangle mesh of an isosurface (the "surface nets" method). The vertices are exactly the
 * points surfacePoints gives, in the same order; every grid edge the surface crosses joins the
 * vertices of the four cells around it into a quad (two triangles). Triangles are wound so that
 * normals point from high values to low, that is from inside the object outwards. Returns the
 * vertex coordinates and the triangles as vertex indices.
 */
export function surfaceMesh(vol: Volume, level: number): { positions: Float32Array; triangles: Uint32Array } {
  const { nx, ny, nz, data } = vol
  const positions = surfacePoints(vol, level)
  const cx = nx - 1, cy = ny - 1, cz = nz - 1
  // 每个小格的顶点下标，没有顶点的是 -1；按 surfacePoints 的遍历顺序重数一遍 / the vertex of every cell, -1 for none; recounted in the order surfacePoints visits them
  const vertexOf = new Int32Array(Math.max(0, cx * cy * cz)).fill(-1)
  const inside = (x: number, y: number, z: number) => data[x + nx * (y + ny * z)]! >= level
  let n = 0
  for (let z = 0; z < cz; z++)
    for (let y = 0; y < cy; y++)
      for (let x = 0; x < cx; x++) {
        const a = inside(x, y, z)
        if (inside(x + 1, y, z) !== a || inside(x, y + 1, z) !== a || inside(x + 1, y + 1, z) !== a || inside(x, y, z + 1) !== a || inside(x + 1, y, z + 1) !== a || inside(x, y + 1, z + 1) !== a || inside(x + 1, y + 1, z + 1) !== a) vertexOf[x + cx * (y + cy * z)] = n++
      }
  const tri: number[] = []
  const cell = (x: number, y: number, z: number) => vertexOf[x + cx * (y + cy * z)]!
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) tri.push(a, c, b, a, d, c)
    else tri.push(a, b, c, a, c, d)
  }
  // 贴着数据边界的连线没有四个小格围着，跳过（表面在那里开口）/ an edge on the border of the data has no four cells around it and is skipped (the surface is open there)
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const a = inside(x, y, z)
        if (x < nx - 1 && y > 0 && z > 0 && y < ny - 1 && z < nz - 1 && inside(x + 1, y, z) !== a) quad(cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y, z), cell(x, y - 1, z), !a)
        if (y < ny - 1 && x > 0 && z > 0 && x < nx - 1 && z < nz - 1 && inside(x, y + 1, z) !== a) quad(cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z), cell(x, y, z - 1), !a)
        if (z < nz - 1 && x > 0 && y > 0 && x < nx - 1 && y < ny - 1 && inside(x, y, z + 1) !== a) quad(cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x, y, z), cell(x - 1, y, z), !a)
      }
  return { positions, triangles: new Uint32Array(tri) }
}

/**
 * 在体数据四周各加一层值为 `value` 的体素。这样贴着数据边界的物体在边界上也有表面，网格是封闭的。
 * Add one layer of voxels of `value` all round a volume, so that an object touching the border of
 * the data gets a surface there too and its mesh is closed.
 */
export function pad(vol: Volume, value = 0): Volume {
  const nx = vol.nx + 2, ny = vol.ny + 2, nz = vol.nz + 2
  const data = new (vol.data.constructor as new (n: number) => Float32Array | Uint8Array)(nx * ny * nz)
  if (value !== 0) data.fill(value)
  for (let z = 0; z < vol.nz; z++)
    for (let y = 0; y < vol.ny; y++) {
      const from = vol.nx * (y + vol.ny * z)
      data.set(vol.data.subarray(from, from + vol.nx), 1 + nx * (y + 1 + ny * (z + 1)))
    }
  return { nx, ny, nz, data, voxel: vol.voxel, origin: [vol.origin[0] - vol.voxel[0], vol.origin[1] - vol.voxel[1], vol.origin[2] - vol.voxel[2]] }
}

/** 一张封闭网格的面积和它围住的体积（体积按绕向带符号）/ the area of a closed mesh and the volume it encloses (signed by winding) */
export function meshMeasure(positions: Float32Array, triangles: Uint32Array): { area: number; volume: number } {
  let area = 0, volume = 0
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t]! * 3, b = triangles[t + 1]! * 3, c = triangles[t + 2]! * 3
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!
    const ux = positions[b]! - ax, uy = positions[b + 1]! - ay, uz = positions[b + 2]! - az
    const vx = positions[c]! - ax, vy = positions[c + 1]! - ay, vz = positions[c + 2]! - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    area += Math.hypot(nx, ny, nz) / 2
    volume += (ax * nx + ay * ny + az * nz) / 6
  }
  return { area, volume }
}

/**
 * 把掩码向外扩 `r` 个体素（方形邻域），返回新的掩码。
 * Grow a mask outward by `r` voxels (a box neighbourhood), returning a new mask.
 */
export function dilate(vol: Volume, r: number): Uint8Array {
  const { nx, ny, nz } = vol
  let cur = Uint8Array.from(vol.data, (v) => (v ? 1 : 0))
  // 三个方向各扫一遍 / one sweep along each of the three axes
  for (const [stride, len] of [[1, nx], [nx, ny], [nx * ny, nz]] as const) {
    const next = new Uint8Array(cur.length)
    for (let i = 0; i < cur.length; i++) {
      if (!cur[i]) continue
      const along = Math.floor(i / stride) % len
      for (let d = -Math.min(r, along); d <= Math.min(r, len - 1 - along); d++) next[i + d * stride] = 1
    }
    cur = next
  }
  return cur
}

/** 一个坐标（数据集的长度单位）落在掩码的哪个体素里；在数据集之外返回 -1 / which voxel of a mask a coordinate (in the dataset's unit) falls in; -1 outside the dataset */
export function voxelIndex(vol: Volume, x: number, y: number, z: number): number {
  const ix = Math.round((x - vol.origin[0]) / vol.voxel[0]), iy = Math.round((y - vol.origin[1]) / vol.voxel[1]), iz = Math.round((z - vol.origin[2]) / vol.voxel[2])
  return ix < 0 || iy < 0 || iz < 0 || ix >= vol.nx || iy >= vol.ny || iz >= vol.nz ? -1 : ix + vol.nx * (iy + vol.ny * iz)
}
