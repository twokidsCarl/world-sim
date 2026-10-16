// 腋窝的改动：肩带权重重分（splitGirdle）、姿势校正形（格式、插值、静止姿势不变、CPU 与着色器一致），
// 以及广义环绕数。生成的绑定在时（public/anatomy/<body>/rig.json），再检查校正形的存放和它在关键姿势下的效果。
// The axilla changes: the girdle split (splitGirdle), pose-corrective
// shapes (format, interpolation, an unchanged rest pose, CPU and shader agreeing) and the generalised winding number. When a
// generated rig is present (public/anatomy/<body>/rig.json), also how the correctives are stored and what they do at the key poses.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexRig, packJoints, skinLikeShader } from '../src/anatomy/rig.ts'
import type { Joint, Rig, RigCorrective } from '../src/anatomy/types.ts'
import { BYTES_PER_VERTEX, Poser, correctedNormals, correctiveOffsets, correctiveWeights, jointFrames, vertexBlend, type Pose } from '../tools/rig/pose.ts'
import { splitGirdle } from '../tools/rig/shoulder.ts'
import { Winding } from '../tools/rig/solid.ts'
import { measureAxilla } from '../tools/rig/axilla-check.ts'
import { readBody } from '../tools/rig/io.ts'
import type { V3 } from '../tools/rig/math.ts'

const src = { name: 'test', url: '', license: 'CC0' }
const joint = (id: string, parent: string | null, center: V3, dofs: Joint['dofs']): Joint => ({ id, name: { zh: id, en: id }, parent, center, tail: [center[0], center[1] - 0.3, center[2]], axes: [[1, 0, 0], [0, 0, 1], [0, 1, 0]], dofs, basis: { zh: '测试', en: 'test' } })
const dof = (axis: 0 | 1 | 2): Joint['dofs'][number] => ({ axis, name: { zh: '轴', en: 'axis' }, min: -3, max: 3, source: src })

/** 躯干、锁骨、肩胛骨、上臂四个关节，皮肤 n 个顶点随机挂在它们上面，末尾接一个校正形 / trunk, clavicle, scapula, arm; n skin vertices hung on them at random, and a corrective appended */
function makeRig(withCorrective: boolean): { rig: Rig; bin: Uint8Array; rest: Float32Array; n: number; corr: RigCorrective | null; shapes: Float32Array[] } {
  const joints: Joint[] = [
    joint('T1', null, [0, 1.35, 0.05], [dof(0)]),
    joint('sc_L', 'T1', [0.02, 1.32, 0.13], [dof(1), dof(0), dof(2)]),
    joint('ac_L', 'sc_L', [0.16, 1.32, 0.09], [dof(0), dof(1), dof(2)]),
    joint('gh_L', 'ac_L', [0.17, 1.29, 0.1], [dof(0), dof(1), dof(2)]),
  ]
  const n = 300
  let seed = 3
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  const rest = new Float32Array(n * 3)
  const skin = new Uint8Array(n * BYTES_PER_VERTEX)
  const dv = new DataView(skin.buffer)
  for (let i = 0; i < n; i++) {
    rest[i * 3] = 0.05 + rnd() * 0.25
    rest[i * 3 + 1] = 1.0 + rnd() * 0.4
    rest[i * 3 + 2] = (rnd() - 0.5) * 0.2
    const a = Math.floor(rnd() * 4), b = (a + 1 + Math.floor(rnd() * 3)) % 4
    const wa = 60 + Math.floor(rnd() * 150)
    dv.setUint16(i * 12, a, true)
    dv.setUint16(i * 12 + 2, b, true)
    skin[i * 12 + 8] = wa
    skin[i * 12 + 9] = 255 - wa
  }
  const shapes: Float32Array[] = []
  let bin = skin
  let corr: RigCorrective | null = null
  if (withCorrective) {
    const verts = Array.from({ length: 40 }, (_, k) => k * 7)
    const keys = [1.0, 2.2]
    for (let j = 0; j < keys.length; j++) shapes.push(Float32Array.from({ length: verts.length * 3 }, () => (rnd() - 0.5) * 0.04))
    const block = new Uint8Array(verts.length * 4 * (1 + 3 * keys.length))
    const bv = new DataView(block.buffer)
    verts.forEach((v, k) => bv.setUint32(k * 4, v, true))
    shapes.forEach((s, j) => s.forEach((x, k) => bv.setFloat32(verts.length * 4 + j * verts.length * 12 + k * 4, x, true)))
    bin = new Uint8Array(skin.length + block.length)
    bin.set(skin)
    bin.set(block, skin.length)
    corr = { part: 'skin', joint: 'gh_L', dof: 1, keys, offset: skin.length, count: verts.length }
  }
  const rig: Rig = { joints, bindings: [{ part: 'skin', offset: 0, vertexCount: n }], muscles: [], cautions: [], ...(corr ? { correctives: [corr] } : {}) }
  return { rig, bin, rest, n, corr, shapes }
}

describe('pose-corrective shapes', () => {
  it('weights: zero at and below 0, a ramp to the first key, linear between keys, held beyond the last', () => {
    const k = [1, 2, 4]
    expect(correctiveWeights(k, 0)).toEqual([0, 0, 0])
    expect(correctiveWeights(k, -0.3)).toEqual([0, 0, 0])
    expect(correctiveWeights(k, 0.25)).toEqual([0.25, 0, 0])
    expect(correctiveWeights(k, 1)).toEqual([1, 0, 0])
    expect(correctiveWeights(k, 1.5)).toEqual([0.5, 0.5, 0])
    expect(correctiveWeights(k, 3)).toEqual([0, 0.5, 0.5])
    expect(correctiveWeights(k, 4)).toEqual([0, 0, 1])
    expect(correctiveWeights(k, 9)).toEqual([0, 0, 1])
    for (const a of [0.1, 0.7, 1.3, 2.9, 3.99]) expect(correctiveWeights(k, a).reduce((s, w) => s + w, 0)).toBeCloseTo(Math.min(1, a), 12)
  })

  it('reproduces each key shape exactly at its key angle and nothing at rest', () => {
    const { rig, bin, n, corr, shapes } = makeRig(true)
    const ji = new Map(rig.joints.map((j, i) => [j.id, i]))
    expect(correctiveOffsets(rig, bin, 'skin', n, jointFrames(rig.joints, {}).angles, ji)).toBeNull()
    corr!.keys.forEach((k, j) => {
      const off = correctiveOffsets(rig, bin, 'skin', n, jointFrames(rig.joints, { gh_L: [0, k, 0] }).angles, ji)!
      for (let i = 0; i < 40; i++) for (let c = 0; c < 3; c++) expect(off[i * 7 * 3 + c]).toBe(shapes[j]![i * 3 + c])
      // 不在校正形里的顶点不动 / vertices not in the corrective do not move
      expect(off[1 * 3]).toBe(0)
    })
    // 别的部件、别的自由度没有校正 / no correction for another part or another dof
    expect(correctiveOffsets(rig, bin, 'other', n, jointFrames(rig.joints, { gh_L: [0, 1, 0] }).angles, ji)).toBeNull()
    expect(correctiveOffsets(rig, bin, 'skin', n, jointFrames(rig.joints, { gh_L: [1, 0, 0.5] }).angles, ji)).toBeNull()
  })

  it('leaves the rest pose bit for bit and is ignored by a rig without the section', () => {
    const a = makeRig(true), b = makeRig(false)
    const ra = new Poser(a.rig, a.bin, {}).part('skin', a.rest, 'dqs', false)
    const rb = new Poser(b.rig, b.bin, {}).part('skin', b.rest, 'dqs', false)
    expect(Array.from(ra)).toEqual(Array.from(rb))
    for (let i = 0; i < ra.length; i++) expect(Math.abs(ra[i]! - a.rest[i]!)).toBeLessThan(1e-7)
    // 有校正形但不起作用的姿势（外展角为 0）与没有校正形逐位相同 / a pose where it is not active (abduction 0) is the same bit for bit as without it
    const pose: Pose = { gh_L: [0.8, 0, 0.3], sc_L: [0.1, 0.2, 0] }
    expect(Array.from(new Poser(a.rig, a.bin, pose).part('skin', a.rest, 'dqs', false))).toEqual(Array.from(new Poser(b.rig, b.bin, pose).part('skin', b.rest, 'dqs', false)))
  })

  it('agrees between the CPU reference and the shader path (rest buffer + offsets, then the shader blend)', () => {
    const { rig, bin, rest, n } = makeRig(true)
    const r = indexRig(rig, bin)
    for (const pose of [{ gh_L: [0.3, 0.6, 0.1] }, { gh_L: [0, 1.6, 0], ac_L: [0.4, 0, 0.1] }, { gh_L: [0.2, 2.6, 0], sc_L: [-0.2, 0.1, 0] }] as Pose[]) {
      const cpu = new Poser(rig, bin, pose).part('skin', rest, 'dqs', false)
      const frames = jointFrames(rig.joints, pose)
      // 查看器：校正位移写进静止缓冲，着色器照常蒙皮 / the viewer: the offsets go into the rest buffer, the shader skins as usual
      const off = correctiveOffsets(rig, bin, 'skin', n, frames.angles, r.jointIndex)!
      const jd = packJoints(frames)
      const dv = new DataView(bin.buffer)
      let worst = 0
      for (let i = 0; i < n; i++) {
        const p = [rest[i * 3]! + off[i * 3]!, rest[i * 3 + 1]! + off[i * 3 + 1]!, rest[i * 3 + 2]! + off[i * 3 + 2]!]
        const js = [0, 1, 2, 3].map((k) => (bin[i * 12 + 8 + k] ? dv.getUint16(i * 12 + k * 2, true) : dv.getUint16(i * 12, true)))
        const ws = [0, 1, 2, 3].map((k) => bin[i * 12 + 8 + k]! / 255)
        const g = skinLikeShader(p, js, ws, jd, false)
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(g[c]! - cpu[i * 3 + c]!))
      }
      expect(worst).toBeLessThan(5e-6)
    }
  })

  it('can be turned off by the caller that already added it (no double counting)', () => {
    const { rig, bin, rest, n } = makeRig(true)
    const pose: Pose = { gh_L: [0, 1.7, 0] }
    const p = new Poser(rig, bin, pose)
    const off = correctiveOffsets(rig, bin, 'skin', n, p.angles, p.jointIndex)!
    const moved = Float32Array.from(rest, (x, i) => x + off[i]!)
    expect(Array.from(p.part('skin', moved, 'dqs', false, false))).toEqual(Array.from(p.part('skin', rest, 'dqs', false)))
  })
})

describe('normals of the corrected skin', () => {
  it("turn, under each vertex's own blend, into the normals of the posed shape", () => {
    const { rig, bin, rest, n } = makeRig(true)
    // 把顶点连成三角形带 / the vertices joined into a strip of triangles
    const index: number[] = []
    for (let i = 0; i + 2 < n; i++) index.push(i, i + 1, i + 2)
    const pose: Pose = { gh_L: [0.2, 1.6, 0.1], ac_L: [0.3, 0, 0] }
    const p = new Poser(rig, bin, pose)
    const off = correctiveOffsets(rig, bin, 'skin', n, p.angles, p.jointIndex)!
    const moved = Float32Array.from(rest, (x, i) => x + off[i]!)
    const mask = new Uint8Array(n).fill(1)
    const normals = new Float32Array(n * 3)
    correctedNormals(bin, 0, moved, index, 0, p.dqs, mask, normals)
    const posed = p.part('skin', moved, 'dqs', false, false)
    for (const v of [5, 50, 150]) {
      const acc: [number, number, number] = [0, 0, 0]
      for (let t = 0; t < index.length; t += 3) {
        if (index[t] !== v && index[t + 1] !== v && index[t + 2] !== v) continue
        const [a, b, c] = [index[t]!, index[t + 1]!, index[t + 2]!]
        const u = [0, 1, 2].map((k) => posed[b * 3 + k]! - posed[a * 3 + k]!), w = [0, 1, 2].map((k) => posed[c * 3 + k]! - posed[a * 3 + k]!)
        acc[0] = acc[0] + u[1]! * w[2]! - u[2]! * w[1]!
        acc[1] = acc[1] + u[2]! * w[0]! - u[0]! * w[2]!
        acc[2] = acc[2] + u[0]! * w[1]! - u[1]! * w[0]!
      }
      const l = Math.hypot(acc[0]!, acc[1]!, acc[2]!)
      const r = vertexBlend(bin, 0, v, p.dqs).r
      const nr = [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]
      const turned = [0, 1, 2].map((k) => r[k * 3]! * nr[0]! + r[k * 3 + 1]! * nr[1]! + r[k * 3 + 2]! * nr[2]!)
      for (let k = 0; k < 3; k++) expect(turned[k]!).toBeCloseTo(acc[k]! / l, 5)
    }
  })
})

describe('girdle split', () => {
  it('hands the clavicle share to clavicle and scapula by distance and keeps every row summing to 1', () => {
    const ids = ['T1', 'sc_L', 'ac_L', 'gh_L', 'sc_R', 'ac_R']
    // 模拟的距离场：离锁骨（x < 0.1）近的点给锁骨 / a mock distance field: points near the clavicle (x < 0.1) go to it
    const field = {
      query: (p: V3, allow?: (j: number) => boolean) => {
        const joints = [1, 2, 4, 5].filter((j) => !allow || allow(j))
        return { joints, dist: joints.map((j) => (j === 1 || j === 4 ? Math.abs(p[0]) : Math.abs(0.18 - Math.abs(p[0])))) }
      },
      euclid: (_p: V3, list: number[]) => ({ joints: list, dist: list.map(() => 0.05) }),
    }
    const pos = Float32Array.from([0.02, 1.3, 0.1, 0.17, 1.3, -0.05, 0.1, 1.3, 0])
    const rows = [new Map([[1, 0.6], [0, 0.4]]), new Map([[1, 0.5], [3, 0.5]]), new Map([[0, 1]])]
    const changed = splitGirdle(rows, pos, { from: '^sc_([LR])$', among: '^(sc|ac)_{S}$', beta: 0.6 }, ids, field, (c, out) => {
      out.clear()
      const dmin = Math.min(...c.dist)
      c.joints.forEach((j, k) => (c.dist[k]! - dmin < 0.03 ? out.set(j, 1) : null))
      const s = [...out.values()].reduce((a, b) => a + b, 0)
      for (const [j, w] of out) out.set(j, w / s)
    })
    expect(changed).toBe(2)
    expect(rows[0]!.get(1)).toBeCloseTo(0.6, 12)
    expect(rows[0]!.has(2)).toBe(false)
    expect(rows[1]!.get(2)).toBeCloseTo(0.5, 12)
    expect(rows[1]!.has(1)).toBe(false)
    expect([...rows[2]!]).toEqual([[0, 1]])
    for (const r of rows) expect([...r.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })
})

describe('generalised winding number', () => {
  it('is 1 inside a closed cube, 0 outside, and about ½ on the far side of a missing face', () => {
    // 单位立方体，法线朝外 / unit cube, outward normals
    const P = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]
    const F = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
    const w = new Winding(P, F)
    expect(w.at(0.5, 0.5, 0.5)).toBeCloseTo(1, 6)
    expect(w.at(0.2, 0.7, 0.4)).toBeCloseTo(1, 6)
    expect(Math.abs(w.at(2, 0.5, 0.5))).toBeLessThan(1e-6)
    // 远处的点走近似，也接近 0 / a far point goes through the approximation and is near 0 as well
    expect(Math.abs(w.at(30, -20, 10))).toBeLessThan(1e-3)
    const open = new Winding(P, F.slice(0, 30))
    expect(open.at(0.5, 0.5, 0.5)).toBeGreaterThan(0.6)
    expect(open.at(0.5, 0.5, 0.5)).toBeLessThan(1)
  })
})

// 生成的绑定（没有时跳过）/ the generated rigs (skipped when absent)
for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'rig.json')) && existsSync(join(DIR, 'rig.bin'))
  describe.skipIf(!present)(`pose-corrective shapes in public/anatomy/${bodyId}`, () => {
    it('are stored after every part block, within rig.bin, with increasing positive keys on a skin part', () => {
      const rig = JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) as Rig
      const bin = new Uint8Array(readFileSync(join(DIR, 'rig.bin')))
      const ends = rig.bindings.filter((b) => b.offset !== undefined).map((b) => b.offset! + b.vertexCount! * BYTES_PER_VERTEX)
      const blocksEnd = Math.max(0, ...ends)
      let at = blocksEnd
      for (const c of [...(rig.correctives ?? [])].sort((a, b) => a.offset - b.offset)) {
        expect(c.offset).toBe(at)
        expect(c.offset % 4).toBe(0)
        at = c.offset + c.count * 4 * (1 + 3 * c.keys.length)
        expect(c.keys.every((k, i) => k > 0 && (i === 0 || k > c.keys[i - 1]!))).toBe(true)
        const b = rig.bindings.find((x) => x.part === c.part)!
        expect(b.offset).toBeDefined()
        const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
        let prev = -1
        for (let k = 0; k < c.count; k++) {
          const v = dv.getUint32(c.offset + k * 4, true)
          expect(v).toBeGreaterThan(prev)
          expect(v).toBeLessThan(b.vertexCount!)
          prev = v
        }
      }
      expect(at).toBe(bin.length)
    })

    // 门槛：同一副绑定去掉校正形（普通蒙皮）对照，在外展 90° 和 160° 下两侧的穿出、拉伸都不多；静止时完全相同
    // the gate: against the same rig without its correctives (plain skinning), at 90° and 160° of abduction on both sides no more parts through the skin and no more stretch; identical at rest
    it('makes the axilla no worse than plain skinning of the same rig, and leaves the rest pose alone', { timeout: 1_200_000 }, async () => {
      const rig = JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) as Rig
      if (!rig.correctives?.length) return
      const bin = new Uint8Array(readFileSync(join(DIR, 'rig.bin')))
      const body = await readBody(DIR)
      const withC = measureAxilla(body, rig, bin)
      const plain = measureAxilla(body, { ...rig, correctives: [] }, bin)
      for (let i = 0; i < withC.length; i++) {
        const a = withC[i]!, b = plain[i]!
        const at = `${bodyId} ${a.side} ${a.pose}`
        if (a.pose === 'rest') {
          expect(a, at).toEqual(b)
          continue
        }
        expect(a.deepTotal.count, `${at}: deep-part vertices outside the skin`).toBeLessThanOrEqual(b.deepTotal.count)
        expect(a.deepTotal.areaCm2, `${at}: their area`).toBeLessThanOrEqual(b.deepTotal.areaCm2)
        expect(a.deepTotal.maxMm, `${at}: the farthest`).toBeLessThanOrEqual(b.deepTotal.maxMm)
        for (const fold of ['posterior', 'anterior'] as const) {
          expect(a[fold].p95, `${at}: ${fold} fold stretch p95`).toBeLessThanOrEqual(b[fold].p95)
          expect(a[fold].max, `${at}: ${fold} fold stretch max`).toBeLessThanOrEqual(b[fold].max)
        }
      }
    })
  })
}
