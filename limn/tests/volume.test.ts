// 密度图：读文件、合并体素、取等值面 / density maps: reading, binning and taking an isosurface
import { describe, expect, it } from 'vitest'
import { readEmdb } from '../server/sources/emdb'
import { IDENTITY, type Molecule } from '../src/mol/types'
import { buildItem } from '../src/scene/build'
import { defaultColoring } from '../src/style/assign'
import { TONE_MOLECULE } from '../src/style/palettes'
import { bin, dilate, parseMrc, surfacePoints, voxelIndex, type Volume } from '../src/volume/mrc'
import { readBlock, readN5Mask } from '../src/volume/n5'

/** 一个 MRC 文件：值由函数给出 / an MRC file whose values come from a function */
function mrc(n: [number, number, number], value: (x: number, y: number, z: number) => number, opts: { voxel?: number; start?: [number, number, number]; mode?: number; axis?: [number, number, number]; ext?: number } = {}): ArrayBuffer {
  const mode = opts.mode ?? 2, ext = opts.ext ?? 0, axis = opts.axis ?? [1, 2, 3], voxel = opts.voxel ?? 1, start = opts.start ?? [0, 0, 0]
  const count = n[0] * n[1] * n[2]
  const buf = new ArrayBuffer(1024 + ext + count * (mode === 2 ? 4 : 2))
  const v = new DataView(buf)
  ;[n[0], n[1], n[2], mode, start[0], start[1], start[2]].forEach((x, i) => v.setInt32(i * 4, x, true))
  // 每根文件轴上的采样数和晶胞边长：这里各向同性 / sampling and cell length along each axis: isotropic here
  const dims = [n[axis.indexOf(1)]!, n[axis.indexOf(2)]!, n[axis.indexOf(3)]!]
  dims.forEach((d, i) => v.setInt32((7 + i) * 4, d, true))
  dims.forEach((d, i) => v.setFloat32((10 + i) * 4, d * voxel, true))
  axis.forEach((a, i) => v.setInt32((16 + i) * 4, a, true))
  v.setInt32(23 * 4, ext, true)
  let k = 0
  const idx = [0, 0, 0]
  for (idx[2] = 0; idx[2] < n[2]; idx[2]++) for (idx[1] = 0; idx[1] < n[1]; idx[1]++) for (idx[0] = 0; idx[0] < n[0]; idx[0]++) {
    const val = value(idx[axis.indexOf(1)]!, idx[axis.indexOf(2)]!, idx[axis.indexOf(3)]!)
    if (mode === 2) v.setFloat32(1024 + ext + k * 4, val, true)
    else v.setInt16(1024 + ext + k * 2, val, true)
    k++
  }
  return buf
}

describe('MRC maps', () => {
  it('reads values, voxel size and start, past an extended header', () => {
    const vol = parseMrc(mrc([4, 3, 2], (x, y, z) => x + 10 * y + 100 * z, { voxel: 1.5, start: [-2, 0, 5], ext: 80 }))
    expect([vol.nx, vol.ny, vol.nz]).toEqual([4, 3, 2])
    expect(vol.data[3 + 4 * (2 + 3 * 1)]).toBe(123)
    expect(vol.voxel).toEqual([1.5, 1.5, 1.5])
    expect(vol.origin).toEqual([-3, 0, 7.5])
  })

  it('reads 16-bit maps and maps whose axes are stored in another order', () => {
    expect(parseMrc(mrc([2, 2, 2], (x, y, z) => x + 2 * y + 4 * z, { mode: 1 })).data[7]).toBe(7)
    // 文件里最快的轴是 z，最慢的是 x / the file's fastest axis is z and its slowest x
    const vol = parseMrc(mrc([2, 3, 4], (x, y, z) => x + 10 * y + 100 * z, { axis: [3, 2, 1] }))
    expect([vol.nx, vol.ny, vol.nz]).toEqual([4, 3, 2])
    expect(vol.data[3 + 4 * (2 + 3 * 1)]).toBe(123)
  })

  it('refuses files that are not maps', () => {
    expect(() => parseMrc(new ArrayBuffer(100))).toThrow()
    expect(() => parseMrc(new ArrayBuffer(2000))).toThrow()
  })

  it('bins by averaging and keeps the map in place', () => {
    const vol = parseMrc(mrc([8, 8, 8], (x) => x, { voxel: 2 }))
    const b = bin(vol, 4)
    expect([b.nx, b.voxel[0]]).toEqual([4, 4])
    // 第一个合并体素盖住 x = 0 和 1，平均 0.5，中心在 1 Å / the first binned voxel covers x = 0 and 1: mean 0.5, centre at 1 Å
    expect(b.data[0]).toBe(0.5)
    expect(b.origin[0]).toBe(1)
    expect(bin(vol, 8)).toBe(vol)
  })
})

describe('isosurface', () => {
  /** 以 c 为中心、随距离线性衰减的密度；等值面是个球 / density falling linearly with distance from c; its isosurfaces are spheres */
  const ball = (n: number, voxel: number, origin: number): Volume => {
    const data = new Float32Array(n * n * n), c = (n - 1) / 2
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) data[x + n * (y + n * z)] = 20 - Math.hypot(x - c, y - c, z - c)
    return { nx: n, ny: n, nz: n, data, voxel: [voxel, voxel, voxel], origin: [origin, origin, origin] }
  }

  it('puts points on the surface, in Å, where the map says', () => {
    const vol = ball(33, 2, -10)
    const pts = surfacePoints(vol, 10) // 距离中心 10 个体素 = 20 Å / 10 voxels from the centre = 20 Å
    const centre = -10 + 16 * 2
    expect(pts.length / 3).toBeGreaterThan(1000)
    let worst = 0
    for (let i = 0; i < pts.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(pts[i]! - centre, pts[i + 1]! - centre, pts[i + 2]! - centre) - 20))
    // 每个点离真正的球面不到半个体素 / every point lies within half a voxel of the true sphere
    expect(worst).toBeLessThan(1)
    // 点数和球面面积相称：约每个体素面积一个点 / the number of points fits the sphere's area: about one per voxel face
    const area = 4 * Math.PI * 20 * 20
    expect(pts.length / 3).toBeGreaterThan(area / 4 * 0.9)
    expect(pts.length / 3).toBeLessThan(area / 4 * 2.2)
  })

  it('gives nothing when the level is outside the map', () => {
    expect(surfacePoints(ball(9, 1, 0), 99).length).toBe(0)
  })
})

// EMDB 条目和“不切”的标记 / EMDB entries and the never-cut flag
describe('EMDB entries', () => {
  const entry = {
    admin: { title: 'A map' },
    map: { dimensions: { col: 340, row: 340, sec: 340 }, pixel_spacing: { x: { valueOf_: '1.06' } }, size_kbytes: 157217, contour_list: { contour: [{ level: 0.1, primary: false }, { level: 0.25, primary: true }] } },
    crossreferences: { pdb_list: { pdb_reference: [{ pdb_id: '6vq6' }, { pdb_id: 'not-an-id' }] } },
  }

  it('reads the recommended contour, voxel size, fitted models and where the map is', () => {
    const e = readEmdb(entry, '21317')!
    expect(e).toMatchObject({ id: 'EMD-21317', title: 'A map', contour: 0.25, voxel: 1.06, dims: [340, 340, 340], megabytes: 154, pdb: ['6VQ6'] })
    expect(e.url).toBe('https://ftp.ebi.ac.uk/pub/databases/emdb/structures/EMD-21317/map/emd_21317.map.gz')
  })

  it('says so when an entry gives no contour level, and rejects what is not an entry', () => {
    expect(readEmdb({ ...entry, map: { ...entry.map, contour_list: {} } }, '1')!.contour).toBeNull()
    expect(readEmdb({}, '1')).toBeNull()
  })
})

describe('a model shown inside a map', () => {
  it('is flagged so that a cut leaves it whole', () => {
    const mol: Molecule = {
      id: 'M', title: 'M', atomCount: 2, pos: new Float32Array(6), element: new Uint8Array(2), chainOf: new Uint32Array(2), isTrace: new Uint8Array(2), residue: new Int32Array(2),
      chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count: 2, model: 1 }],
      entities: [{ id: '1', description: 'M', kind: 'protein' }],
      assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
    }
    const flag = (noCut: boolean) => buildItem(mol, defaultColoring(mol), TONE_MOLECULE, { assembly: 'asym', molecule: 0, noCut }).instances.data[15]
    expect(flag(true)).toBe(3)
    expect(flag(false)).toBe(0)
  })
})

// 分块存放的分割数据 / segmentations stored in blocks
describe('N5 segmentations', () => {
  /** 做一个分块文件：头部加 gzip 压缩的大端 uint16 / make a block file: a header plus gzipped big-endian uint16 */
  async function block(size: [number, number, number], value: (x: number, y: number, z: number) => number): Promise<ArrayBuffer> {
    const raw = new Uint8Array(size[0] * size[1] * size[2] * 2)
    let k = 0
    for (let z = 0; z < size[2]; z++) for (let y = 0; y < size[1]; y++) for (let x = 0; x < size[0]; x++) {
      const v = value(x, y, z)
      raw[k++] = v >> 8
      raw[k++] = v & 255
    }
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    const out = new Uint8Array(16 + gz.length)
    const v = new DataView(out.buffer)
    v.setUint16(0, 0, false)
    v.setUint16(2, 3, false)
    size.forEach((s, i) => v.setUint32(4 + i * 4, s, false))
    out.set(gz, 16)
    return out.buffer
  }
  const attrs = { dimensions: [6, 4, 4], blockSize: [4, 4, 4], dataType: 'uint16', compression: { type: 'gzip' }, transform: { axes: ['z', 'y', 'x'], scale: [80, 64, 60], translate: [39, 30, 28] } }

  it('reads a block as a mask of non-zero voxels', async () => {
    const b = await readBlock(await block([2, 2, 1], (x, y) => (x === 1 && y === 0 ? 256 : 0)), attrs)
    expect(b.size).toEqual([2, 2, 1])
    expect(Array.from(b.nonzero)).toEqual([0, 1, 0, 0])
  })

  it('assembles blocks into one volume, treats missing blocks as empty, and reads the transform as z, y, x', async () => {
    // 第二个分块（x 从 4 开始）只有 2 个体素宽；它不存在 / the second block (from x = 4) is only two voxels wide; it does not exist
    const first = await block([4, 4, 4], (x, y, z) => (x === 3 && y === 2 && z === 1 ? 7 : 0))
    const calls: string[] = []
    const fake = (async (u: string) => {
      calls.push(u)
      if (u.endsWith('attributes.json')) return new Response(JSON.stringify(attrs))
      if (u.endsWith('/0/0/0')) return new Response(first)
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const vol = await readN5Mask('https://x/seg/s4', undefined, fake)
    expect([vol.nx, vol.ny, vol.nz]).toEqual([6, 4, 4])
    expect(Array.from(vol.data).reduce((s, v) => s + v, 0)).toBe(1)
    expect(vol.data[3 + 6 * (2 + 4 * 1)]).toBe(1)
    expect(vol.voxel).toEqual([60, 64, 80])
    expect(vol.origin).toEqual([28, 30, 39])
    expect(calls.filter((u) => /\/\d+\/\d+\/\d+$/.test(u)).sort()).toEqual(['https://x/seg/s4/0/0/0', 'https://x/seg/s4/1/0/0'])
  })

  it('clips a full-size block that overhangs the edge of the dataset', async () => {
    // 数据集 x 方向只有 6 个体素，第二个分块却存了整整 4 个 / the dataset is 6 voxels along x, yet the second block is stored 4 wide
    const second = await block([4, 4, 4], (x) => (x === 1 || x === 3 ? 1 : 0))
    const fake = (async (u: string) => (u.endsWith('attributes.json') ? new Response(JSON.stringify(attrs)) : u.endsWith('/1/0/0') ? new Response(second) : new Response('', { status: 404 }))) as unknown as typeof fetch
    const vol = await readN5Mask('https://x/seg/s4', undefined, fake)
    // 块内 x = 1 落在数据集的 x = 5；块内 x = 3 在数据集之外 / block x = 1 is dataset x = 5; block x = 3 lies outside the dataset
    expect(Array.from(vol.data).reduce((s, v) => s + v, 0)).toBe(16)
    expect(vol.data[5]).toBe(1)
  })

  it('finds the surface of a mask', async () => {
    const data = new Uint8Array(8 * 8 * 8)
    for (let z = 2; z < 6; z++) for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) data[x + 8 * (y + 8 * z)] = 1
    const pts = surfacePoints({ nx: 8, ny: 8, nz: 8, data, voxel: [10, 10, 10], origin: [0, 0, 0] }, 0.5)
    // 4x4x4 的方块：表面上的小格数是 5³ - 3³ = 98 / a 4x4x4 cube: 5 cubed minus 3 cubed = 98 cells on its surface
    expect(pts.length / 3).toBe(98)
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i]).toBeGreaterThanOrEqual(15)
      expect(pts[i]).toBeLessThanOrEqual(55)
    }
  })
})

describe('masks', () => {
  it('grows a mask by a box and finds the voxel a coordinate is in', () => {
    const data = new Uint8Array(7 * 7 * 7)
    data[3 + 7 * (3 + 7 * 3)] = 1
    const vol: Volume = { nx: 7, ny: 7, nz: 7, data, voxel: [10, 10, 20], origin: [5, 5, 5] }
    const grown = dilate(vol, 2)
    expect(Array.from(grown).reduce((s, v) => s + v, 0)).toBe(125)
    expect(grown[1 + 7 * (5 + 7 * 2)]).toBe(1)
    expect(grown[0 + 7 * (3 + 7 * 3)]).toBe(0)
    expect(voxelIndex(vol, 35, 35, 65)).toBe(3 + 7 * (3 + 7 * 3))
    expect(voxelIndex(vol, -20, 35, 65)).toBe(-1)
    // 靠边的也不越界 / one at the edge stays within bounds
    const edge = new Uint8Array(7 * 7 * 7)
    edge[0] = 1
    expect(Array.from(dilate({ ...vol, data: edge }, 2)).reduce((s, v) => s + v, 0)).toBe(27)
  })
})
