// 开口后的皮肤包的装入：读包、选包、锁定与简化、按下标闭合、GLB 写出不合并重合顶点、下标对照文件。
// 前半是不依赖数据的单元测试；后半在开口后的包（data/raw/bodyshape/out/male-skin-open，不进 git）存在时
// 对真包再核一遍，不存在则跳过。发布结果（public/anatomy/male）上的检查在 pipeline-output.test.ts。
// Installing an opened skin package: reading and choosing a package, locks and simplification, closing by
// index, a GLB writer that does not merge coincident vertices, and the index sidecar. The first half are
// unit tests without data; the second half repeats the checks on the real opened package
// (data/raw/bodyshape/out/male-skin-open, not in git) when it exists and is skipped otherwise. The checks
// on the shipped result (public/anatomy/male) are in pipeline-output.test.ts.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { computeNormals, type Mesh } from '../tools/pipeline/geometry.ts'
import { glbVertexOrder, OPENED_SKIN_POSITION_BITS, POSITION_BITS, positionStep, readGlb, writeSystemGlb } from '../tools/pipeline/glb.ts'
import { boundaryLoops, checkSkinFit, closeShippedSkin, edgeTopology, loadSkinPackage, selectSkinPackage, simplifySkinKeepingFace, skinLockMask } from '../tools/pipeline/skinPackage.ts'
import { lipQuantisation, openedSkinCautions, openedSkinProvenance, openedSkinReport, quantisePositions, SKIN_SOURCE_FILE, skinSourceSidecar } from '../tools/pipeline/skinOpened.ts'

const TMP = mkdtempSync(join(tmpdir(), 'soma-skin-opened-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

/** 轴对齐的盒子，12 个三角形，法线朝外；最后两个三角形是 +Y 面 / an axis-aligned box of 12 outward triangles; the last two are the +Y face */
function box(lo: number[], hi: number[]): Mesh {
  const p: number[] = []
  for (let i = 0; i < 8; i++) p.push(i & 1 ? hi[0]! : lo[0]!, i & 2 ? hi[1]! : lo[1]!, i & 4 ? hi[2]! : lo[2]!)
  const idx = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5, 2, 6, 3, 3, 6, 7]
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) }
}
const obj = (m: Mesh): string => {
  const out: string[] = []
  for (let v = 0; v < m.positions.length; v += 3) out.push(`v ${m.positions[v]} ${m.positions[v + 1]} ${m.positions[v + 2]}`)
  for (let t = 0; t < m.indices.length; t += 3) out.push(`f ${m.indices[t]! + 1} ${m.indices[t + 1]! + 1} ${m.indices[t + 2]! + 1}`)
  return out.join('\n') + '\n'
}
const u32 = (a: number[]): Uint8Array => new Uint8Array(Uint32Array.from(a).buffer)

/**
 * 一个小的“开口后的包”：闭合皮肤是 20 cm 的盒子；开口的皮肤去掉了 +Y 面的两个三角形（“睑裂的封膜”），
 * 沿洞口加了一圈朝里的内卷（4 个新顶点、8 个三角形，标签 lidRimL）。
 * A tiny "opened package": the closed skin is a 20 cm box; the opened skin lacks the two triangles of the
 * +Y face (the "eye membrane") and has a rim of 4 new vertices and 8 triangles turned inwards round the
 * hole (tag lidRimL).
 */
function writePackages(root: string, key: string, openedKey = key): { closed: Mesh; opened: Mesh } {
  const closed = box([-0.1, -0.1, -0.1], [0.1, 0.1, 0.1])
  const top = [2, 6, 7, 3] // +Y 面的四个角，沿洞口一圈 / the four corners of the +Y face, round the hole
  const pos = [...closed.positions]
  for (const v of top) pos.push(closed.positions[3 * v]! * 0.6, 0.08, closed.positions[3 * v + 2]! * 0.6)
  const idx = [...closed.indices.slice(0, 30)]
  for (let k = 0; k < 4; k++) {
    const a = top[k]!, b = top[(k + 1) % 4]!, ra = 8 + k, rb = 8 + ((k + 1) % 4)
    idx.push(a, b, rb, a, rb, ra)
  }
  const opened: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
  const source = { name: 'Test surface', url: 'https://example.org/', license: 'Apache-2.0', attribution: 'a test surface' }
  const author = join(root, 'pkg/body-skin')
  mkdirSync(author, { recursive: true })
  writeFileSync(join(author, 'manifest.json'), JSON.stringify({ source, fittedTo: { body: 'male', key } }))
  writeFileSync(join(author, 'skin.obj'), obj(closed))
  const open = join(root, 'pkg/body-skin-open')
  mkdirSync(open, { recursive: true })
  writeFileSync(join(open, 'manifest.json'), JSON.stringify({
    source, fittedTo: { body: 'male', key: openedKey },
    face: { removedEyeMembrane: { L: [[2, 6, 3], [3, 6, 7]] } },
    opened: { steps: ['open'], vertexTags: { skin: 0, lidRimL: 8 }, modification: { en: 'opened for a test' } },
  }))
  writeFileSync(join(open, 'skin.obj'), obj(opened))
  writeFileSync(join(open, 'skin-closed.obj'), obj(closed))
  writeFileSync(join(open, 'vertex-tags.u8'), Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 8]))
  writeFileSync(join(open, 'source-vertex.u32'), u32([0, 1, 2, 3, 4, 5, 6, 7, ...top]))
  return { closed, opened }
}

describe('boundary loops', () => {
  it('finds none on a closed box and one per hole', () => {
    const b = box([0, 0, 0], [1, 1, 1])
    expect(boundaryLoops(b)).toEqual({ edges: 0, loops: 0, sizes: [] })
    // 去掉 +Y 面：一个四条边的环；再去掉 −Z 面（前两个三角形）：两个环，共用两个顶点时并成一个连通分量
    // without the +Y face: one loop of four edges
    expect(boundaryLoops({ positions: b.positions, indices: b.indices.slice(0, 30) })).toEqual({ edges: 4, loops: 1, sizes: [4] })
    // 两个不相连的洞：两个分开的盒子各缺一个面 / two holes that do not touch: two separate boxes, each without a face
    const c = box([2, 0, 0], [3, 1, 1])
    const two: Mesh = { positions: Float32Array.from([...b.positions, ...c.positions]), indices: Uint32Array.from([...b.indices.slice(0, 30), ...Array.from(c.indices.slice(0, 33), (v) => v + 8)]) }
    expect(boundaryLoops(two)).toEqual({ edges: 7, loops: 2, sizes: [4, 3] })
  })
})

describe('skin lock mask', () => {
  it('locks the face region and every vertex with a non-zero tag', () => {
    expect([...skinLockMask(Uint8Array.from([1, 0, 0, 0]), Uint8Array.from([0, 0, 2, 17]))]).toEqual([1, 0, 1, 1])
    expect([...skinLockMask(Uint8Array.from([1, 0, 0, 0]), null)]).toEqual([1, 0, 0, 0])
  })
})

describe('simplifying a skin with locked vertices', () => {
  // 40 × 40 的平面网格（边长 5 mm），左边四列锁定；锁定区里有一对重合的顶点和连着它们的零面积三角形，
  // 就像移植片的供体网格里那样
  // a 40 × 40 planar grid (5 mm edges) with its four left columns locked; inside the locked part sits a
  // pair of coincident vertices joined by zero-area triangles, as in the donor mesh of a graft
  const n = 40
  const pos: number[] = []
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * 0.005, j * 0.005, 0)
  const at = (i: number, j: number) => j * (n + 1) + i
  const idx: number[] = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) idx.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1))
  // 顶点 (1, 10) 的孪生：位置相同、下标不同；把它上方那两个三角形改接到孪生上，再用两个零面积三角形把缝封住
  // a twin of vertex (1, 10): same position, another index; the triangles above it are moved onto the twin and two zero-area triangles close the slit
  const m = at(1, 10)
  const twin = pos.length / 3
  pos.push(pos[3 * m]!, pos[3 * m + 1]!, pos[3 * m + 2]!)
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
    if (tri.includes(m) && tri.some((v) => v === at(0, 11) || v === at(1, 11) || v === at(2, 11))) for (let k = 0; k < 3; k++) if (idx[t + k] === m) idx[t + k] = twin
  }
  idx.push(m, at(2, 10), twin, twin, at(0, 10), m)
  const mesh: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
  const keep = new Uint8Array(pos.length / 3)
  for (let j = 0; j <= n; j++) for (let i = 0; i <= 3; i++) keep[at(i, j)] = 1
  keep[twin] = 1

  it('keeps every locked vertex and every fully locked triangle, and says where each output vertex came from', async () => {
    expect(edgeTopology(mesh).nonManifoldEdges).toBe(0)
    const r = await simplifySkinKeepingFace(mesh, keep, 0.0008, 0.012, 4)
    expect(r.mesh.indices.length).toBeLessThan(mesh.indices.length / 2)
    expect(r.source.length).toBe(r.mesh.positions.length / 3)
    // 每个输出顶点的位置就是它在输入里那个顶点的位置（没有新顶点，也没有移动）
    // every output vertex sits exactly where its input vertex does (no new vertex, none moved)
    for (let v = 0; v < r.source.length; v++) for (let k = 0; k < 3; k++) expect(r.mesh.positions[3 * v + k]).toBe(mesh.positions[3 * r.source[v]! + k])
    expect(new Set(r.source).size).toBe(r.source.length)
    const out = new Set(r.source)
    for (let v = 0; v < keep.length; v++) if (keep[v]) expect(out.has(v), `locked vertex ${v}`).toBe(true)
    // 重合的一对仍是两个顶点 / the coincident pair is still two vertices
    expect(out.has(m) && out.has(twin)).toBe(true)
    // 全锁定的三角形一个不少，包括那两个零面积的（简化器会丢掉它们，这里补了回来）
    // no fully locked triangle is missing, the two zero-area ones included (the simplifier drops them; they are put back)
    const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',')
    const have = new Set<string>()
    for (let t = 0; t < r.mesh.indices.length; t += 3) have.add(key(r.source[r.mesh.indices[t]!]!, r.source[r.mesh.indices[t + 1]!]!, r.source[r.mesh.indices[t + 2]!]!))
    let locked = 0
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]
      if (!(keep[a] && keep[b] && keep[c])) continue
      locked++
      expect(have.has(key(a, b, c)), `locked triangle ${a},${b},${c}`).toBe(true)
    }
    expect(locked).toBeGreaterThan(200)
    expect(r.restoredTriangles).toBe(2)
    expect(have.has(key(m, at(2, 10), twin)) && have.has(key(twin, at(0, 10), m))).toBe(true)
    // 输入网格只有外缘是边界，输出也一样：没有因为丢三角形而多出洞 / the input has no boundary but its outer edge, and neither has the output: no hole from a dropped triangle
    expect(boundaryLoops(r.mesh).loops).toBe(1)
  })

  it('returns the identity map when nothing is simplified', async () => {
    const b = box([0, 0, 0], [1, 1, 1])
    const r = await simplifySkinKeepingFace(b, new Uint8Array(8), 0.0008, 0.012, 300)
    expect(r.mesh).toBe(b)
    expect([...r.source]).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(r.restoredTriangles).toBe(0)
  })
})

describe('reading and choosing a skin package', () => {
  const root = join(TMP, 'choose')
  const { closed, opened } = writePackages(root, 'abc')

  it('reads a closed package exactly as before: the closed mesh is the mesh itself', () => {
    const pkg = loadSkinPackage(join(root, 'pkg/body-skin'))!
    expect(pkg.opened).toBeNull()
    expect(pkg.closedMesh).toBe(pkg.mesh)
    expect(pkg.mesh.indices.length).toBe(closed.indices.length)
    expect(pkg.fittedTo).toEqual({ body: 'male', key: 'abc' })
  })

  it('reads an opened package with its closed companion, tags and data sources', () => {
    const pkg = loadSkinPackage(join(root, 'pkg/body-skin-open'))!
    expect(pkg.opened).not.toBeNull()
    expect(pkg.mesh.positions.length / 3).toBe(12)
    expect(pkg.closedMesh.positions.length / 3).toBe(8)
    expect(pkg.opened!.closedVertices).toBe(8)
    expect([...pkg.opened!.tags]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 8])
    expect([...pkg.opened!.sourceVertex.slice(8)]).toEqual([2, 6, 7, 3])
    expect([...pkg.opened!.eyeMembrane]).toEqual([2, 6, 3, 3, 6, 7])
    expect(pkg.opened!.tagNames.lidRimL).toBe(8)
    // 清单没给的标签名取默认表 / tag names the manifest does not give come from the default table
    expect(pkg.opened!.tagNames.graftScanned).toBe(15)
    expect(pkg.opened!.steps).toEqual(['open'])
    // 开口的皮肤不闭合：一个边界环（内卷的内缘）；闭合的那张没有边界
    // the opened skin is not closed: one boundary loop (the inner edge of the rim); the closed one has no boundary
    expect(boundaryLoops(pkg.mesh)).toMatchObject({ loops: 1, edges: 4 })
    expect(edgeTopology(pkg.closedMesh).boundaryEdges).toBe(0)
  })

  it('uses the closed companion for inside tests', () => {
    const pkg = loadSkinPackage(join(root, 'pkg/body-skin-open'))!
    const inside = { id: 'in', name: 'Inside', mesh: box([-0.03, -0.03, -0.03], [0.03, 0.03, 0.03]) }
    // 伸出 +Y 面（开口处）4 cm 的一块：闭合皮肤判它在外；内卷只伸进去 2 cm，不会把它“盖住”
    // a block reaching 4 cm out through the +Y face (where the opening is): outside by the closed skin
    const poking = { id: 'out', name: 'Poking', mesh: box([-0.02, 0.06, -0.02], [0.02, 0.14, 0.02]) }
    const fit = checkSkinFit(pkg.closedMesh, [inside, poking])
    expect(fit.closed).toBe(true)
    expect(fit.worst.map((w) => w.name)).toEqual(['Poking'])
    expect(fit.outside5mm).toBeGreaterThan(0)
    // 开口的那张报告为不闭合，所以不能拿它判断内外 / the opened one reports as not closed, which is why it must not serve
    expect(checkSkinFit(pkg.mesh, [inside]).closed).toBe(false)
  })

  it('installs the opened package when it matches, the closed one otherwise, and says why', () => {
    const a = selectSkinPackage(root, 'pkg/body-skin', 'male', 'abc')
    expect(a.state).toBe('opened')
    expect(a.dir).toBe('pkg/body-skin-open')
    expect(a.pkg!.opened).not.toBeNull()
    // 开口后的包里的闭合皮肤与作者的 skin.obj 逐字节相同 / the closed skin of the opened package equals the author's skin.obj byte for byte
    expect(a.openedPackage).toEqual({ dir: 'pkg/body-skin-open', fittedTo: { body: 'male', key: 'abc' }, used: true, matchesAuthorPackage: true })
    // 指纹对不上：两个都不装 / the fingerprint does not match: neither is installed
    const b = selectSkinPackage(root, 'pkg/body-skin', 'male', 'other')
    expect(b.state).toBe('none')
    expect(b.pkg).toBeNull()
    expect(b.reason).toBe('fitted to other internals')
    expect(b.openedPackage!.used).toBe(false)
    expect(selectSkinPackage(root, 'pkg/body-skin', 'female', 'abc').state).toBe('none')
    // 只有开口后的包对不上（它是按旧指纹做的）：退回作者的闭合包 / only the opened package does not match (made for an older fingerprint): the author's closed package is installed
    const r2 = join(TMP, 'stale')
    writePackages(r2, 'abc', 'old')
    const c = selectSkinPackage(r2, 'pkg/body-skin', 'male', 'abc')
    expect(c.state).toBe('closed')
    expect(c.dir).toBe('pkg/body-skin')
    expect(c.pkg!.opened).toBeNull()
    expect(c.openedPackage).toMatchObject({ used: false, reason: 'fitted to other internals' })
    // 作者重新发布之后（skin.obj 变了）开口后的包仍会装入，但报告它不是由这一版做的
    // after a re-issue by the author (another skin.obj) the opened package is still installed, and reported as not made from this issue
    writeFileSync(join(r2, 'pkg/body-skin/skin.obj'), obj(box([-0.11, -0.1, -0.1], [0.1, 0.1, 0.1])))
    writePackages(join(TMP, 'unused'), 'abc')
    const r3 = join(TMP, 'reissued')
    writePackages(r3, 'abc')
    writeFileSync(join(r3, 'pkg/body-skin/skin.obj'), obj(box([-0.11, -0.1, -0.1], [0.1, 0.1, 0.1])))
    const d = selectSkinPackage(r3, 'pkg/body-skin', 'male', 'abc')
    expect(d.state).toBe('opened')
    expect(d.openedPackage!.matchesAuthorPackage).toBe(false)
  })

  it('behaves as before when only the closed package exists', () => {
    const r = join(TMP, 'closed-only')
    writePackages(r, 'abc')
    rmSync(join(r, 'pkg/body-skin-open'), { recursive: true })
    const c = selectSkinPackage(r, 'pkg/body-skin', 'male', 'abc')
    expect(c.state).toBe('closed')
    expect(c.dir).toBe('pkg/body-skin')
    expect(c.openedPackage).toBeUndefined()
    expect(c.pkg!.closedMesh).toBe(c.pkg!.mesh)
    const none = selectSkinPackage(r, 'pkg/body-skin', 'male', 'zzz')
    expect(none).toMatchObject({ state: 'none', pkg: null, reason: 'fitted to other internals' })
    expect(selectSkinPackage(r, 'pkg/nothing', 'male', 'abc')).toMatchObject({ state: 'none', reason: 'no package' })
  })

  it('closes a shipped opened skin by index: rim removed, membrane put back', () => {
    const pkg = loadSkinPackage(join(root, 'pkg/body-skin-open'))!
    const identity = Uint32Array.from({ length: 12 }, (_, v) => v)
    const c = closeShippedSkin(pkg.mesh, identity, pkg.opened!)
    expect(edgeTopology(c)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 })
    expect(c.indices.length).toBe(closed.indices.length)
    expect(c.positions.length / 3).toBe(8)
    expect(opened.indices.length / 3).toBe(18)
  })
})

describe('closing a cut by index', () => {
  it('merges a duplicated margin vertex into its twin although the two coincide', () => {
    // 一个四面体，顶点 0 被复制成顶点 4（位置相同）：三角形 (0,1,2) 用原顶点，其余两个含 0 的三角形用复制的
    // a tetrahedron whose vertex 0 is duplicated as vertex 4 (same position): triangle (0,1,2) keeps the original, the other two triangles at 0 use the duplicate
    const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    const cut: Mesh = { positions, indices: Uint32Array.from([0, 2, 1, 4, 1, 3, 4, 3, 2, 1, 2, 3]) }
    expect(edgeTopology(cut).boundaryEdges).toBeGreaterThan(0)
    const opened = { tags: Uint8Array.from([1, 0, 0, 0, 2]), tagNames: { upperLip: 1, lowerLip: 2, lidRimL: 8, lidRimR: 9, oralPouchUpper: 10, oralPouchLower: 11, oralPouchSeam: 12 }, sourceVertex: Uint32Array.from([0, 1, 2, 3, 0]), closedVertices: 4, eyeMembrane: new Uint32Array(0), steps: ['open'] }
    const c = closeShippedSkin(cut, Uint32Array.from([0, 1, 2, 3, 4]), opened)
    expect(edgeTopology(c)).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 })
    expect(c.positions.length / 3).toBe(4)
    // 顶点次序打乱后（发布的次序不是包的次序）照样按下标找到孪生 / with the vertices shuffled (shipped order is not package order) the twin is still found by index
    const shuffled: Mesh = { positions: Float32Array.from([0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0]), indices: Uint32Array.from([4, 2, 3, 0, 3, 1, 0, 1, 2, 3, 2, 1]) }
    expect(edgeTopology(closeShippedSkin(shuffled, Uint32Array.from([4, 3, 2, 1, 0]), opened))).toEqual({ boundaryEdges: 0, nonManifoldEdges: 0 })
  })
})

describe('GLB writer and the index sidecar', () => {
  // 两片 30 × 30 的网格相距 0.03 mm（“唇内面的两壁”），沿一条边各有一排位置完全相同的顶点（“上下唇缘”）；
  // 另加一个 1.7 m 高的盒子，让量化的包围盒与整张皮肤一样大
  // two 30 × 30 sheets 0.03 mm apart (the "inner-lip walls") whose first rows coincide exactly (the "lip
  // margins"), plus a box 1.7 m high so that the quantisation box is as large as a whole skin's
  const n = 30
  const pos: number[] = []
  const idx: number[] = []
  for (const s of [0, 1]) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * 0.001, 1.45 + (j === 0 ? 0 : s ? -0.00003 : 0), j * 0.001)
  const at = (s: number, i: number, j: number) => s * (n + 1) ** 2 + j * (n + 1) + i
  for (const s of [0, 1]) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) idx.push(at(s, i, j), at(s, i + 1, j), at(s, i + 1, j + 1), at(s, i, j), at(s, i + 1, j + 1), at(s, i, j + 1))
  const b = box([-0.4, -0.08, -0.04], [0.4, 1.645, 0.24])
  const base = pos.length / 3
  const skin: Mesh = { positions: Float32Array.from([...pos, ...b.positions]), indices: Uint32Array.from([...idx, ...Array.from(b.indices, (v) => v + base)]) }
  const nv = skin.positions.length / 3
  const source = Uint32Array.from({ length: nv }, (_, v) => 1000 + v)
  const other = box([0, 0, 0], [0.3, 0.2, 0.1])
  const part = (id: string, m: Mesh, bits?: number) => ({ id, positions: m.positions, normals: computeNormals(m), indices: m.indices, ...(bits ? { positionBits: bits } : {}) })

  it('writes coincident vertices as separate vertices, in the predicted order, and the sidecar matches by index', async () => {
    const file = join(TMP, 'skin16.glb')
    await writeSystemGlb(file, 'integumentary', '#e0b090', [part('other', other), part('skin', skin, OPENED_SKIN_POSITION_BITS)])
    const doc = await readGlb(file)
    expect(doc.getRoot().listNodes().map((x) => x.getName()).sort()).toEqual(['other', 'skin'])
    expect(doc.getRoot().listScenes().length).toBe(1)
    expect(doc.getRoot().listScenes()[0]!.listChildren().length).toBe(2)
    expect(doc.getRoot().listBuffers().length).toBe(1)
    expect(doc.getRoot().listMaterials().length).toBe(1)
    const node = doc.getRoot().listNodes().find((x) => x.getName() === 'skin')!
    const prim = node.getMesh()!.listPrimitives()[0]!
    // 一个顶点也没有被合并掉 / not one vertex was merged away
    expect(prim.getAttribute('POSITION')!.getCount()).toBe(nv)
    expect(prim.getIndices()!.getCount()).toBe(skin.indices.length)
    const sc = await skinSourceSidecar(file, 'skin', skin, source, OPENED_SKIN_POSITION_BITS)
    expect(sc.vertices).toBe(nv)
    expect(sc.bytes.length).toBe(4 * nv)
    expect(sc.stepMm).toBeCloseTo(positionStep(skin.positions, 16) * 1000, 4)
    expect(sc.stepMm).toBeLessThan(0.03)
    expect(sc.maxErrorMm).toBeLessThanOrEqual(sc.stepMm / 2 + 0.002)
    // 文件是小端 uint32；每个发布顶点对应的包顶点位置相同（量化误差之内），下标各不相同
    // the file is little-endian uint32; the package vertex of every shipped vertex is at the same position (within the quantisation) and all indices differ
    const view = new DataView(sc.bytes.buffer)
    const pa = prim.getAttribute('POSITION')!
    const m = node.getWorldMatrix()
    const el = [0, 0, 0]
    const seen = new Set<number>()
    const shippedOf = new Map<number, number>()
    for (let j = 0; j < nv; j++) {
      const v = view.getUint32(4 * j, true) - 1000
      expect(v).toBe(sc.source[j]! - 1000)
      seen.add(v)
      shippedOf.set(v, j)
      pa.getElement(j, el)
      for (let k = 0; k < 3; k++) expect(Math.abs(el[k]! * m[5 * k]! + m[12 + k]! - skin.positions[3 * v + k]!)).toBeLessThanOrEqual((sc.stepMm / 2 + 0.002) / 1000)
    }
    expect(seen.size).toBe(nv)
    // “唇缘”的每一对：位置相同，对到两个不同的包顶点，量化后仍然重合
    // every "margin" pair: same position, two different package vertices, still coincident after quantisation
    for (let i = 0; i <= n; i++) {
      const a = shippedOf.get(at(0, i, 0))!, c = shippedOf.get(at(1, i, 0))!
      expect(a).not.toBe(c)
      const pa0 = pa.getElement(a, [0, 0, 0]), pc0 = pa.getElement(c, [0, 0, 0])
      expect(pa0).toEqual(pc0)
    }
    // 预计的次序就是写出的次序（顶点数和重排表） / the predicted order is the written one (vertex count and remap)
    const order = await glbVertexOrder(skin.indices)
    expect(order.vertices).toBe(nv)
    expect(new Set(order.remap).size).toBe(nv)
    // 对不上的次序会被拒绝 / an order that does not match is refused
    const wrong: Mesh = { positions: skin.positions, indices: Uint32Array.from([...skin.indices.slice(3), ...skin.indices.slice(0, 3)]) }
    await expect(skinSourceSidecar(file, 'skin', wrong, source, OPENED_SKIN_POSITION_BITS)).rejects.toThrow(/skin-source\.u32/)
    expect(SKIN_SOURCE_FILE).toBe('skin-source.u32')
  })

  it('keeps the 0.03 mm walls apart at 16 bits where 14 bits merge them', () => {
    const count = (bits: number) => {
      const q = quantisePositions(skin.positions, bits)
      let merged = 0
      for (let j = 1; j <= n; j++) for (let i = 0; i <= n; i++) if (q[3 * at(0, i, j) + 1] === q[3 * at(1, i, j) + 1]) merged++
      return merged
    }
    expect(positionStep(skin.positions, POSITION_BITS) * 1000).toBeGreaterThan(0.1)
    expect(count(POSITION_BITS)).toBeGreaterThan(0)
    expect(count(OPENED_SKIN_POSITION_BITS)).toBe(0)
  })

  it('leaves the other parts of the file exactly as a file without a 16-bit part has them, and files without one byte-identical', async () => {
    const a = join(TMP, 'a.glb'), a2 = join(TMP, 'a2.glb'), c = join(TMP, 'c.glb')
    await writeSystemGlb(a, 'integumentary', '#e0b090', [part('other', other), part('skin', skin)])
    await writeSystemGlb(a2, 'integumentary', '#e0b090', [part('other', other), part('skin', skin, POSITION_BITS)])
    await writeSystemGlb(c, 'integumentary', '#e0b090', [part('other', other), part('skin', skin, 16)])
    const { readFileSync } = await import('node:fs')
    // 明说 14 位与不说一样 / asking for 14 bits is the same as not asking
    expect(readFileSync(a).equals(readFileSync(a2))).toBe(true)
    const stored = async (file: string, id: string) => {
      const node = (await readGlb(file)).getRoot().listNodes().find((x) => x.getName() === id)!
      const prim = node.getMesh()!.listPrimitives()[0]!
      return { pos: Array.from(prim.getAttribute('POSITION')!.getArray()!), nrm: Array.from(prim.getAttribute('NORMAL')!.getArray()!), idx: Array.from(prim.getIndices()!.getArray()!), m: node.getWorldMatrix() }
    }
    expect(await stored(c, 'other')).toEqual(await stored(a, 'other'))
    expect((await stored(c, 'skin')).pos).not.toEqual((await stored(a, 'skin')).pos)
  })
})

describe('report, composition and cautions of an opened skin', () => {
  const root = join(TMP, 'report')
  writePackages(root, 'abc')
  const pkg = loadSkinPackage(join(root, 'pkg/body-skin-open'))!
  const identity = Uint32Array.from({ length: 12 }, (_, v) => v)
  const lock = skinLockMask(new Uint8Array(12), pkg.opened!.tags)
  const report = openedSkinReport(pkg, 'pkg/body-skin-open', true, pkg.mesh, identity, lock, 0, 16)

  it('counts shipped vertices by tag and reports the boundary loops apart from "closed"', () => {
    expect(report.byTag).toEqual({ skin: { shipped: 8, inPackage: 8 }, lidRimL: { shipped: 4, inPackage: 4 } })
    expect(report.shipped).toMatchObject({ vertices: 12, triangles: 18, boundaryLoops: 1, boundaryLoopSizes: [4] })
    expect(report.package).toMatchObject({ vertices: 12, closedVertices: 8, closedTriangles: 12, boundaryLoops: 1 })
    expect(report.lockedVerticesMissing).toBe(0)
    expect(report.grafts).toEqual([])
    // 这个小包没有唇缘：量化一节为空 / this tiny package has no lip margins: no quantisation section
    expect(report.quantisation).toBeNull()
    expect(lipQuantisation(pkg.mesh, identity, pkg.manifest, 16)).toBeNull()
    // 少发布一个被锁定的顶点就会被数出来 / a locked vertex that is not shipped is counted
    expect(openedSkinReport(pkg, 'x', null, pkg.mesh, identity.slice(0, 11), lock, 0, 16).lockedVerticesMissing).toBe(1)
  })

  it('says what the skin is made of, with construction aids marked as such, and words the cautions in both languages', () => {
    const pv = openedSkinProvenance(pkg, report, ['BodyParts3D 4.0'])
    expect(pv.packageSource.name).toBe('Test surface')
    expect(pv.packageSource.license).toBe('Apache-2.0')
    // 修改声明跟着来源走 / the statement of changes travels with the source
    expect(pv.packageSource.attribution).toContain('opened for a test')
    expect(pv.sources).toEqual([])
    expect(pv.composition.map((c) => [c.provenance, c.source, c.vertices])).toEqual([['curated', 'Test surface', 8], ['construction', null, 4]])
    for (const c of pv.composition) {
      expect(c.what.en.length).toBeGreaterThan(20)
      expect(c.what.zh).toMatch(/[一-鿿]/)
    }
    const cautions = openedSkinCautions(report, null)
    expect(cautions.length).toBe(1)
    expect(cautions[0]!.en).toContain('real openings')
    expect(cautions[0]!.en).toContain('construction aids')
    expect(cautions[0]!.zh).toContain('构造物')
    expect(cautions[0]!.zh.length).toBeLessThan(260)
  })

  it('lists a graft with the licence statement of the manifest as it stands, under a name of its own when the source is already listed', () => {
    const withGraft = { ...pkg, manifest: { ...pkg.manifest, grafted: { grafts: [
      { name: 'genitalSkin', provenance: 'scanned', source: { name: 'BodyParts3D 4.0', file: 'dir/FJ2810.obj', url: 'https://example.org/bp3d', licenceLineInFile: 'The license for this database is X.', licenceNote: { en: 'stated in two ways; both are quoted' } }, what: { zh: '外生殖器的皮肤。别的。', en: 'The skin of the external genitalia. More.' }, patchVertices: [0, 1], blendRingVertices: [2], constructionVertices: [3, 4] },
      { name: 'toesL', provenance: 'curated', source: { name: 'Foot mesh', url: 'https://example.org/foot', license: 'CC0', author: 'An Author' }, what: { zh: '分开的脚趾。', en: 'Separate toes. More.' }, patchVertices: [5], blendRingVertices: [6] },
    ] } } }
    const r = openedSkinReport(withGraft, 'x', true, pkg.mesh, identity, lock, 0, 16)
    expect(r.grafts.map((g) => [g.name, g.provenance, g.shipped])).toEqual([['genitalSkin', 'scanned', { patch: 2, blendRing: 1, construction: 2 }], ['toesL', 'curated', { patch: 1, blendRing: 1, construction: 0 }]])
    expect(r.grafts[0]!.ring!.triangles).toBeGreaterThan(0)
    expect(r.grafts[0]!.ring!.longestEdgeMm.max).toBeGreaterThan(200)
    expect(r.grafts[0]!.ring!.dihedralDeg.max).toBeGreaterThan(80)
    const pv = openedSkinProvenance(withGraft, r, ['BodyParts3D 4.0'])
    expect(pv.sources).toEqual([
      { name: 'BodyParts3D 4.0 — dir/FJ2810.obj (skin graft)', url: 'https://example.org/bp3d', license: 'The license for this database is X.', attribution: 'stated in two ways; both are quoted' },
      { name: 'Foot mesh', url: 'https://example.org/foot', license: 'CC0', attribution: 'An Author' },
    ])
    expect(pv.composition.map((c) => [c.provenance, c.source])).toEqual([['curated', 'Test surface'], ['scanned', 'BodyParts3D 4.0 — dir/FJ2810.obj (skin graft)'], ['curated', 'Foot mesh'], ['construction', null], ['construction', null]])
    const cautions = openedSkinCautions(r, { min: 1.29, max: 1.54 })
    expect(cautions.length).toBe(3)
    expect(cautions[1]!.en).toMatch(/his own scanned skin/)
    expect(cautions[1]!.en).toMatch(/constructed, not scanned/)
    expect(cautions[2]!.en).toMatch(/artist-made foot mesh/)
    expect(cautions[2]!.en).toContain('1.29–1.54')
    for (const c of cautions) {
      expect(c.zh).toMatch(/[一-鿿]/)
      expect(c.zh.length).toBeLessThan(260)
    }
  })
})

// ── 真包 / the real package ─────────────────────────────────────────────────────────────────────────
const REAL = join(import.meta.dirname, '../data/raw/bodyshape/out/male-skin-open')
const realPresent = existsSync(join(REAL, 'manifest.json')) && existsSync(join(REAL, 'vertex-tags.u8'))

describe.skipIf(!realPresent)('the opened male skin package (data/raw/bodyshape/out/male-skin-open)', () => {
  const pkg = realPresent ? loadSkinPackage(REAL)! : null

  it('is an opened package: two boundary loops, a closed companion, coincident lip margins under different indices', () => {
    const op = pkg!.opened!
    expect(op).not.toBeNull()
    expect(boundaryLoops(pkg!.mesh).loops).toBe(2)
    expect(edgeTopology(pkg!.closedMesh).boundaryEdges).toBe(0)
    const margins = (pkg!.manifest.face as { margins: { upperLip: number[]; lowerLip: number[] } }).margins
    const p = pkg!.mesh.positions
    let pairs = 0
    for (let i = 1; i + 1 < margins.upperLip.length; i++) {
      const a = margins.upperLip[i]!, b = margins.lowerLip[i]!
      expect(a).not.toBe(b)
      for (let k = 0; k < 3; k++) expect(p[3 * a + k]).toBe(p[3 * b + k])
      pairs++
    }
    expect(pairs).toBeGreaterThan(30)
  })

  it('closes by index into a surface with the triangles of the closed companion', () => {
    const nv = pkg!.mesh.positions.length / 3
    const closed = closeShippedSkin(pkg!.mesh, Uint32Array.from({ length: nv }, (_, v) => v), pkg!.opened!)
    expect(edgeTopology(closed).boundaryEdges).toBe(0)
    expect(closed.indices.length).toBe(pkg!.closedMesh.indices.length)
  })

  it('keeps every locked vertex through the simplification, the lip margins as separate vertices, and still closes', async () => {
    const op = pkg!.opened!
    const nv = pkg!.mesh.positions.length / 3
    const lock = skinLockMask(new Uint8Array(nv), op.tags)
    const r = await simplifySkinKeepingFace(pkg!.mesh, lock, 0.0008, 0.012, 300)
    expect(r.mesh.indices.length).toBeLessThan(pkg!.mesh.indices.length)
    const report = openedSkinReport(pkg!, 'x', null, r.mesh, r.source, lock, r.restoredTriangles, OPENED_SKIN_POSITION_BITS)
    expect(report.lockedVerticesMissing).toBe(0)
    expect(report.shipped.boundaryLoops).toBe(2)
    const removed = op.tagNames.removed!
    for (const [name, c] of Object.entries(report.byTag)) {
      // 被切掉的顶点没有三角形用到，不发布；其余标签非 0 的一个不少 / removed vertices are used by no triangle and are not shipped; every other tagged vertex is
      if (op.tagNames[name] === removed) expect(c.shipped, name).toBe(0)
      else if (name !== 'skin') expect(c.shipped, name).toBe(c.inPackage)
    }
    const q = report.quantisation!.chosen
    expect(q.marginPairsShippedApart).toBe(q.marginPairs)
    expect(q.marginPairsCoincidentAfter).toBe(q.marginPairs)
    expect(q.walls.mergedPositions).toBe(0)
    expect(edgeTopology(closeShippedSkin(r.mesh, r.source, op)).boundaryEdges).toBe(0)
  }, 120_000)
})
