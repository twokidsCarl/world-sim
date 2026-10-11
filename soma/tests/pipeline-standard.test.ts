// 女性 v2 新模块的单元测试：骨架标准化、围度与瘦身场、关节局部配准、外部皮肤包。
// Unit tests of the modules added for female v2: skeleton standardisation, girths and the slimming
// field, the joint-local fit, the external skin package.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { jointLocalWarp, type JointBone } from '../tools/pipeline/jointFit.ts'
import { PointIndex, surfacePoints, thinPoints } from '../tools/pipeline/register.ts'
import { checkSkinFit, internalsKey, loadSkinPackage, parseSkinObj } from '../tools/pipeline/skinPackage.ts'
import { buildSlimmer, hullPerimeter, sectionGirth } from '../tools/pipeline/slim.ts'
import { anthro, anthroSd, axisParam, jacobianStats, mapPoints, type AnthroModel } from '../tools/pipeline/standard.ts'

function box(min: [number, number, number], max: [number, number, number]): Mesh {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

describe('anthropometric model', () => {
  const model: AnthroModel = { S0: 1650, B0: 22, sexes: { F: { outputs: { x: { a: Math.log(500), bStature: 1, cBmi: 0.5, residualSdLog: 0.02 } } } } }
  it('evaluates ln y = a + b ln(S/S0) + c ln(B/B0)', () => {
    expect(anthro(model, 'F', 'x', 1650, 22)).toBeCloseTo(500, 9)
    expect(anthro(model, 'F', 'x', 1815, 22)).toBeCloseTo(550, 6)
    expect(anthro(model, 'F', 'x', 1650, 88)).toBeCloseTo(1000, 6)
    expect(anthroSd(model, 'F', 'x', 1650, 22)).toBeCloseTo(10, 9)
    expect(() => anthro(model, 'F', 'nope', 1650, 22)).toThrow()
  })
})

describe('standard.ts helpers', () => {
  it('finds the long axis of a bone, pointing up', () => {
    const { axis, t } = axisParam(surfacePoints(box([0, 0, 0], [0.02, 0.3, 0.02]), 0.01))
    expect(axis[1]).toBeGreaterThan(0.99)
    expect(Math.min(...t)).toBeCloseTo(0, 6)
    expect(Math.max(...t)).toBeCloseTo(1, 6)
  })
  it('maps points and measures the Jacobian of a map', () => {
    const pts = new Float32Array([0, 0, 0, 1, 2, 3])
    expect(Array.from(mapPoints((p) => [2 * p[0], p[1], p[2] + 1], pts))).toEqual([0, 0, 1, 2, 2, 4])
    // 各向异性缩放 2 × 1 × 0.5 的行列式为 1；镜像为负
    // an anisotropic scale 2 × 1 × 0.5 has determinant 1; a mirror is negative
    const scale = jacobianStats((q) => q.map((v, i) => v * [2, 1, 0.5][i % 3]!), new Float32Array([0.1, 0.2, 0.3, 0.5, 0.1, 0.2]))
    expect(scale.median).toBeCloseTo(1, 2)
    expect(scale.folded).toBe(0)
    const mirror = jacobianStats((q) => q.map((v, i) => (i % 3 === 0 ? -v : v)), new Float32Array([0.1, 0.2, 0.3]))
    expect(mirror.folded).toBe(1)
  })
})

describe('girths', () => {
  it('measures the convex hull perimeter of a section', () => {
    expect(hullPerimeter([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]])).toBeCloseTo(4, 9)
    const b = box([0, 0, 0], [0.1, 0.5, 0.06])
    expect(sectionGirth([b], [0, 0.25, 0], [0, 1, 0])).toBeCloseTo(0.32, 6)
    // 两个并排的盒子：不筛选时皮尺绕两个一起量 / two boxes side by side: without a filter the tape goes round both
    const c = box([0.2, 0, 0], [0.3, 0.5, 0.06])
    expect(sectionGirth([b, c], [0, 0.25, 0], [0, 1, 0])).toBeCloseTo(0.72, 6)
    expect(sectionGirth([b, c], [0, 0.25, 0], [0, 1, 0], (p) => p[0] < 0.15)).toBeCloseTo(0.32, 6)
    expect(sectionGirth([b], [0, 0.6, 0], [0, 1, 0])).toBe(0)
  })
})

describe('slimming field', () => {
  // 一根沿 Y 的“骨”，外面一圈软组织点 / a "bone" along Y with soft-tissue points round it
  const bone = thinPoints(surfacePoints(box([-0.01, 0, -0.01], [0.01, 0.4, 0.01]), 0.003), 0.002)
  it('scales the depth of tissue over a limb bone by λ, tapering along the limb', () => {
    const slim = buildSlimmer([{ id: 'limb', bonePoints: bone, mode: 'limb', axis: [[0, 0, 0], [0, 0.4, 0]], lambda: [[0, 1], [0.5, 0.5], [1, 1]] }])
    const out = slim.apply(new Float32Array([0.05, 0.2, 0, 0.05, 0.02, 0, 0.011, 0.2, 0]))
    // 中段：到骨面的距离 40 mm → 20 mm / mid-limb: 40 mm from the bone surface → 20 mm
    expect(out[0]!).toBeCloseTo(0.03, 3)
    expect(out[1]!).toBeCloseTo(0.2, 2)
    // 近端 λ ≈ 1：几乎不动 / near the proximal end λ ≈ 1: hardly moves
    expect(out[3]!).toBeGreaterThan(0.047)
    // 贴着骨的点留在骨外 / a point on the bone stays outside it
    expect(out[6]!).toBeGreaterThanOrEqual(0.0099)
  })
  it('moves only tissue outside a trunk bone, by a saturating amount', () => {
    const slim = buildSlimmer([{ id: 'cage', bonePoints: thinPoints(surfacePoints(box([0.09, 0, -0.05], [0.1, 0.3, 0.05]), 0.003), 0.002), mode: 'trunk', lambda: [[0, 0.5]], saturate: 0.02, centre: [0, 0] }])
    const out = slim.apply(new Float32Array([0.11, 0.15, 0, 0.16, 0.15, 0, 0.05, 0.15, 0]))
    expect(out[0]!).toBeCloseTo(0.105, 3) // 外侧 10 mm → 5 mm / 10 mm outside → 5 mm
    expect(out[3]!).toBeCloseTo(0.15, 3) // 饱和：只移 (1 − λ)·20 mm / saturated: moves (1 − λ)·20 mm only
    expect(out[6]!).toBeCloseTo(0.05, 6) // 骨内侧不动 / inside the cage: untouched
  })
})

describe('jointLocalWarp', () => {
  // 源空间：两块骨，中间一条“韧带”；目标：下面那块骨不动，上面那块平移 +X 2 cm
  // source: two bones with a "ligament" between them; target: the lower bone stays, the upper one moves 2 cm in +X
  const lower = box([0, 0, 0], [0.04, 0.02, 0.04])
  const upper = box([0, 0.03, 0], [0.04, 0.05, 0.04])
  const ligament = box([0.015, 0.02, 0.015], [0.025, 0.03, 0.025])
  const bone = (id: string, m: Mesh, dx: number): JointBone => {
    const pts = thinPoints(surfacePoints(m, 0.001), 0.0008)
    const moved = { positions: Float32Array.from(m.positions.map((v, i) => (i % 3 === 0 ? v + dx : v))), indices: m.indices }
    return { id, points: () => pts, bbox: [Math.min(...m.positions.filter((_, i) => i % 3 === 0)), Math.min(...m.positions.filter((_, i) => i % 3 === 1)), 0, Math.max(...m.positions.filter((_, i) => i % 3 === 0)), Math.max(...m.positions.filter((_, i) => i % 3 === 1)), 0.04], map: (q) => Float32Array.from(q.map((v, i) => (i % 3 === 0 ? v + dx : v))), target: new PointIndex(thinPoints(surfacePoints(moved, 0.001), 0.0008), 0.003) }
  }
  it('makes each end follow its own bone', () => {
    const res = jointLocalWarp(ligament, [bone('lower', lower, 0), bone('upper', upper, 0.02)], new Map())!
    expect(res.bones.map((b) => b.id).sort()).toEqual(['lower', 'upper'])
    const p = res.mesh.positions
    for (let v = 0; v < 8; v++) {
      const dx = p[3 * v]! - ligament.positions[3 * v]!
      // 下端（y = 0.02）留在原处，上端（y = 0.03）随上面的骨平移 / the lower end stays, the upper end moves with the upper bone
      if (ligament.positions[3 * v + 1]! < 0.025) expect(Math.abs(dx)).toBeLessThan(0.003)
      else expect(Math.abs(dx - 0.02)).toBeLessThan(0.003)
    }
  })
  it('returns null when no bone is near', () => {
    expect(jointLocalWarp(box([1, 1, 1], [1.01, 1.01, 1.01]), [bone('lower', lower, 0)], new Map())).toBeNull()
  })
})

describe('external skin package', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soma-skin-'))
  const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 3 2\nf 1 4 3\nf 5 6 7 8\nf 1 2 6 5\nf 3 4 8 7\nf 2 3 7 6\nf 4 1 5 8\n'
  it('reads an OBJ, fanning polygons, and keeps the vertex order', () => {
    const m = parseSkinObj(obj)
    expect(m.positions.length).toBe(24)
    expect(m.indices.length).toBe(36)
    expect(Array.from(m.positions.slice(3, 6))).toEqual([1, 0, 0])
  })
  it('loads a package and says what it was fitted to', () => {
    expect(loadSkinPackage(dir)).toBeNull()
    writeFileSync(join(dir, 'skin.obj'), obj)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ source: { name: 'Test skin', license: 'CC0', url: 'https://example.org' } }))
    expect(loadSkinPackage(dir)!.fittedTo).toBeNull()
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ source: { name: 'Test skin', license: 'CC0' }, fittedTo: { body: 'female', key: 'abc' } }))
    const pkg = loadSkinPackage(dir)!
    expect(pkg.fittedTo).toEqual({ body: 'female', key: 'abc' })
    expect(pkg.source).toMatchObject({ name: 'Test skin', license: 'CC0' })
  })
  it('fingerprints the skeleton and checks that the skin contains the internals', () => {
    const a = internalsKey([{ name: 'Left femur', bbox: [0, 0, 0, 0.1, 0.4, 0.1] }, { name: 'Sacrum', bbox: [0, 0, 0, 0.1, 0.1, 0.1] }])
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(internalsKey([{ name: 'Sacrum', bbox: [0, 0, 0, 0.1, 0.1, 0.1] }, { name: 'Left femur', bbox: [0, 0, 0, 0.1, 0.4, 0.1] }])).toBe(a)
    expect(internalsKey([{ name: 'Left femur', bbox: [0, 0, 0, 0.1, 0.42, 0.1] }, { name: 'Sacrum', bbox: [0, 0, 0, 0.1, 0.1, 0.1] }])).not.toBe(a)
    const skin = box([0, 0, 0], [0.1, 0.1, 0.1])
    const fit = checkSkinFit(skin, [{ name: 'inside', mesh: box([0.02, 0.02, 0.02], [0.08, 0.08, 0.08]) }, { name: 'poking out', mesh: box([0.05, 0.05, 0.05], [0.16, 0.08, 0.08]) }])
    expect(fit.closed).toBe(true)
    expect(fit.outside).toBeGreaterThan(0.1)
    expect(fit.worst[0]!.name).toBe('poking out')
    expect(fit.worst.some((w) => w.name === 'inside')).toBe(false)
  })
})
