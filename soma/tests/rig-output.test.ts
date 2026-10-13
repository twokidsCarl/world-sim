// 校验生成的骨架绑定（public/anatomy/<body>/rig.json、rig.bin、rig-report.json）。
// 尚未生成时跳过：请先运行 `bun tools/rig/run.ts male`。几何相关的断言只在 rig-report.json
// 记录的输入哈希与磁盘上的文件一致时才执行（几何管线重新生成数据后，需要重建骨架绑定）。
// Validates the generated rig (public/anatomy/<body>/rig.json, rig.bin, rig-report.json). Skipped
// when it has not been built: run `bun tools/rig/run.ts male` first. Assertions that depend on the
// geometry run only while the input hashes recorded in rig-report.json match the files on disk
// (after the geometry pipeline regenerates the data the rig must be rebuilt).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnatomyData, Joint, Rig } from '../src/anatomy/types.ts'
import { type Body, readBody } from '../tools/rig/io.ts'
import { type V3, xfApply } from '../tools/rig/math.ts'
import { BYTES_PER_VERTEX, Poser, jointTransforms, muscleLength } from '../tools/rig/pose.ts'
import { PoseBuilder, standardPostures } from '../tools/rig/postures.ts'
import { stale } from '../tools/rig/run.ts'

const rad = (d: number): number => (d * Math.PI) / 180

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'rig.json')) && existsSync(join(DIR, 'rig.bin')) && existsSync(join(DIR, 'anatomy.json'))

  describe.skipIf(!present)(`rig output (public/anatomy/${bodyId})`, () => {
    const rig = (present ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : null) as Rig
    const bin = present ? new Uint8Array(readFileSync(join(DIR, 'rig.bin'))) : new Uint8Array(0)
    const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
    const report = present && existsSync(join(DIR, 'rig-report.json')) ? (JSON.parse(readFileSync(join(DIR, 'rig-report.json'), 'utf8')) as { binBytes: number; validation: null | { rest: { maxDisplacementDqsMm: number; maxDisplacementLbsMm: number }; weights: Record<string, number>; postures: { id: string; bones: { a: string; b: string; maxDepthMm: number }[]; skin: { flippedPct: number } }[] } }) : null
    const changed = present ? stale(DIR) : ['absent']
    const fresh = changed.length === 0
    const byId = new Map<string, Joint>(present ? rig.joints.map((j) => [j.id, j]) : [])
    const index = new Map<string, number>(present ? rig.joints.map((j, i) => [j.id, i]) : [])
    let body: Body | null = null
    beforeAll(async () => {
      if (present && fresh) body = await readBody(DIR)
      else if (present) console.warn(`rig (${bodyId}) was built from other inputs; geometry checks skipped: ${changed.slice(0, 4).join(', ')}`)
    })

    it('has joints that form one tree', () => {
      expect(rig.joints.length).toBeGreaterThan(100)
      expect(new Set(rig.joints.map((j) => j.id)).size).toBe(rig.joints.length)
      const roots = rig.joints.filter((j) => j.parent === null)
      expect(roots.map((j) => j.id)).toEqual(['pelvis'])
      for (const j of rig.joints) {
        if (j.parent !== null) expect(byId.has(j.parent), `${j.id}: parent ${j.parent}`).toBe(true)
        // 沿父关节一直走能到根，不成环 / following parents reaches the root without a cycle
        let cur: Joint | undefined = j
        let steps = 0
        while (cur && cur.parent !== null && steps++ < rig.joints.length) cur = byId.get(cur.parent)
        expect(cur?.id).toBe('pelvis')
      }
    })

    it('has the expected joints on both sides', () => {
      for (const id of ['L5', 'T1', 'C1', 'skull', 'tmj', 'rib1_L', 'rib12_R', 'sc_L', 'ac_R', 'gh_L', 'elbow_R', 'radioulnar_L', 'wrist_R', 'cmc1_L', 'mcp2_L', 'pip5_R', 'dip3_L', 'ip1_R', 'si_L', 'hip_R', 'knee_L', 'patella_R', 'ankle_L', 'subtalar_R', 'mtp1_L', 'tip1_R', 'tpip2_L', 'tdip5_R']) expect(byId.has(id), id).toBe(true)
      expect(byId.get('si_L')!.dofs.length).toBe(0)
      expect(byId.get('elbow_L')!.dofs.length).toBe(1)
      expect(byId.get('knee_L')!.dofs.length).toBe(2)
      expect(byId.get('gh_L')!.dofs.length).toBe(3)
      expect(rig.joints.filter((j) => /^rib\d+_[LR]$/.test(j.id)).length).toBe(24)
    })

    it('has unit, mutually perpendicular joint axes and described joints', () => {
      for (const j of rig.joints) {
        for (let a = 0; a < 3; a++) {
          expect(Math.hypot(...j.axes[a]!), `${j.id} axis ${a}`).toBeCloseTo(1, 4)
          for (let b = a + 1; b < 3; b++) expect(Math.abs(j.axes[a]![0] * j.axes[b]![0] + j.axes[a]![1] * j.axes[b]![1] + j.axes[a]![2] * j.axes[b]![2]), `${j.id} axes ${a}·${b}`).toBeLessThan(1e-3)
        }
        expect(j.name.zh.length).toBeGreaterThan(0)
        expect(j.name.en.length).toBeGreaterThan(0)
        expect(j.basis.zh.length, `${j.id} basis`).toBeGreaterThan(10)
        expect(j.basis.en.length).toBeGreaterThan(10)
        expect(new Set(j.dofs.map((d) => d.axis)).size).toBe(j.dofs.length)
      }
    })

    it('has sane ranges of motion with a source for every dof', () => {
      for (const j of rig.joints) {
        for (const d of j.dofs) {
          expect(d.min, `${j.id} ${d.name.en} min`).toBeLessThanOrEqual(0)
          expect(d.max, `${j.id} ${d.name.en} max`).toBeGreaterThanOrEqual(0)
          expect(d.max - d.min).toBeGreaterThan(0)
          expect(d.max - d.min).toBeLessThanOrEqual(2 * Math.PI + 1e-6)
          expect(d.name.zh).toContain('/')
          expect(d.source.name.length).toBeGreaterThan(5)
        }
      }
      // 相对静止姿势：肘、膝能屈约 130–150°，不能明显过伸 / about the rest pose: elbow and knee flex 130–150° and hardly hyperextend
      for (const id of ['elbow_L', 'elbow_R', 'knee_L', 'knee_R']) {
        const d = byId.get(id)!.dofs[0]!
        expect(d.max, id).toBeGreaterThan(rad(115))
        expect(d.max, id).toBeLessThan(rad(155))
        expect(d.min, id).toBeGreaterThan(rad(-25))
      }
      // 静止姿势接近完全旋后：还能旋前 140° 以上，几乎不能再旋后
      // the rest pose is close to full supination: more than 140° of pronation left, hardly any supination
      const pro = byId.get('radioulnar_L')!.dofs[0]!
      expect(pro.max).toBeGreaterThan(rad(140))
      expect(pro.min).toBeGreaterThan(rad(-20))
      // 寰枢关节承担颈部旋转的大部分 / the atlanto-axial joint takes most of the cervical rotation
      const c1 = byId.get('C1')!.dofs.find((d) => d.axis === 2)!
      expect(c1.max).toBeGreaterThan(rad(30))
    })

    it('binds every part exactly once', () => {
      const count = new Map<string, number>()
      for (const b of rig.bindings) count.set(b.part, (count.get(b.part) ?? 0) + 1)
      expect([...count.values()].every((c) => c === 1)).toBe(true)
      for (const b of rig.bindings) {
        const rigid = b.joint !== undefined, skinned = b.offset !== undefined
        expect(rigid !== skinned, `${b.part}: exactly one of joint / offset`).toBe(true)
        if (rigid) expect(byId.has(b.joint!), `${b.part} → ${b.joint}`).toBe(true)
        else {
          expect(b.vertexCount).toBeGreaterThan(0)
          expect(b.offset! % 4).toBe(0)
          expect(b.offset! + b.vertexCount! * BYTES_PER_VERTEX).toBeLessThanOrEqual(bin.length)
        }
      }
      if (fresh) {
        const missing = data.parts.filter((p) => !count.has(p.id))
        expect(missing.map((p) => p.id)).toEqual([])
        expect(count.size).toBe(data.parts.length)
      }
    })

    it('stores weights that sum to 255 with valid joint indices and no overlapping blocks', () => {
      const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
      let end = 0
      for (const b of [...rig.bindings].filter((x) => x.offset !== undefined).sort((x, y) => x.offset! - y.offset!)) {
        expect(b.offset).toBeGreaterThanOrEqual(end)
        end = b.offset! + b.vertexCount! * BYTES_PER_VERTEX
        for (let i = 0; i < b.vertexCount!; i++) {
          const o = b.offset! + i * BYTES_PER_VERTEX
          const s = bin[o + 8]! + bin[o + 9]! + bin[o + 10]! + bin[o + 11]!
          if (s !== 255) throw new Error(`${b.part} vertex ${i}: weights sum to ${s}`)
          for (let k = 0; k < 4; k++) if (bin[o + 8 + k]! > 0 && dv.getUint16(o + k * 2, true) >= rig.joints.length) throw new Error(`${b.part} vertex ${i}: joint index out of range`)
        }
      }
      expect(end).toBe(bin.length)
      if (report) expect(report.binBytes).toBe(bin.length)
    })

    it('binds every bone with a joint of its own rigidly', () => {
      const of = new Map(rig.bindings.map((b) => [b.part, b]))
      const byName = new Map(data.parts.map((p) => [p.name, p]))
      for (const [name, joint] of [['Left femur', 'hip_L'], ['Right tibia', 'knee_R'], ['Left fibula', 'knee_L'], ['Left patella', 'patella_L'], ['Right humerus', 'gh_R'], ['Left ulna', 'elbow_L'], ['Left radius', 'radioulnar_L'], ['Right scapula', 'ac_R'], ['Left clavicle', 'sc_L'], ['Mandible', 'tmj'], ['Atlas', 'C1'], ['Axis', 'C2'], ['Sacrum', 'pelvis'], ['Left talus', 'ankle_L'], ['Right calcaneus', 'subtalar_R'], ['Left capitate', 'wrist_L'], ['Occipital bone', 'skull'], ['Left first rib', 'rib1_L']] as const) {
        const p = byName.get(name)
        if (!p) continue
        expect(of.get(p.id)?.joint, name).toBe(joint)
      }
      // 胸骨没有自己的关节：逐顶点跟随肋骨 / the sternum has no joint of its own: skinned to the ribs
      const st = byName.get('Body of sternum')
      if (st) expect(of.get(st.id)?.offset).toBeDefined()
    })

    it('states its limits in both languages', () => {
      expect(rig.cautions.length).toBeGreaterThanOrEqual(8)
      for (const c of rig.cautions) {
        expect(c.zh).toMatch(/[一-鿿]/)
        expect(c.en.length).toBeGreaterThan(40)
      }
      expect(rig.shape ?? []).toEqual([])
    })

    it('moves the limbs the way the dof names say', () => {
      const tailOf = (id: string): V3 => (byId.get(id) as Joint & { tail: V3 }).tail
      const moved = (id: string, k: number, angle: number, point: V3): V3 => {
        const pose = { [id]: byId.get(id)!.dofs.map((_, q) => (q === k ? angle : 0)) }
        const p = xfApply(jointTransforms(rig.joints, pose)[index.get(id)!]!, point)
        return [p[0] - point[0], p[1] - point[1], p[2] - point[2]]
      }
      for (const s of ['L', 'R'] as const) {
        const lateral = s === 'L' ? 1 : -1
        // 屈肘：腕向前上 / elbow flexion: the wrist goes forwards and up
        const e = moved(`elbow_${s}`, 0, rad(60), tailOf(`elbow_${s}`))
        expect(e[2]).toBeGreaterThan(0.05)
        expect(e[1]).toBeGreaterThan(0.02)
        // 屈膝：踝向后上 / knee flexion: the ankle goes backwards and up
        const k = moved(`knee_${s}`, 0, rad(60), tailOf(`knee_${s}`))
        expect(k[2]).toBeLessThan(-0.1)
        expect(k[1]).toBeGreaterThan(0.05)
        // 屈髋：膝向前；外展：膝向外 / hip flexion: the knee goes forwards; abduction: outwards
        expect(moved(`hip_${s}`, 0, rad(45), tailOf(`hip_${s}`))[2]).toBeGreaterThan(0.1)
        expect(moved(`hip_${s}`, 1, rad(30), tailOf(`hip_${s}`))[0] * lateral).toBeGreaterThan(0.05)
        // 肩外展：肘向外上 / shoulder abduction: the elbow goes outwards and up
        const a = moved(`gh_${s}`, 1, rad(60), tailOf(`gh_${s}`))
        expect(a[0] * lateral).toBeGreaterThan(0.05)
        expect(a[1]).toBeGreaterThan(0.02)
        // 踝背屈：足尖向上 / ankle dorsiflexion: the toes go up
        expect(moved(`ankle_${s}`, 0, rad(10), tailOf(`ankle_${s}`))[1]).toBeGreaterThan(0.005)
        // 旋前：桡骨远端从外侧转到内侧 / pronation: the distal radius turns from lateral to medial
        const wrist = byId.get(`wrist_${s}`)!.center as V3
        const thumbSide: V3 = [wrist[0] + 0.03 * lateral, wrist[1], wrist[2]]
        expect(moved(`radioulnar_${s}`, 0, rad(150), thumbSide)[0] * lateral).toBeLessThan(-0.02)
      }
      // 左右对称：左肘屈与右肘屈的位移互为镜像 / left and right mirror each other
      // 两侧的轴各自从自己的骨拟合，骨不对称时位移也不对称：容差取“前臂长 × 两轴（镜像后）夹角的正弦”再加 1 cm。
      // 夹角本身限制在 30° 以内：符号或左右弄反时它接近 90°–180°，位移之差则有几十厘米。
      // （女性模型两侧肱骨远端绕骨干相差约 23°，屈肘 90° 时腕的上移量两侧差 3.3 cm；男性两侧相差 1°、2 mm。）
      // Each side's axis is fitted from its own bones, so asymmetric bones give asymmetric motion: the
      // tolerance is forearm length × sine of the angle between the two axes (after mirroring), plus
      // 1 cm. The angle itself must stay under 30°: a wrong sign or swapped sides gives 90°–180° and
      // displacements that differ by tens of centimetres. (The distal ends of the female model's two
      // humeri differ by about 23° about the shaft, and at 90° of flexion her wrists rise by amounts
      // 3.3 cm apart; the male's sides differ by 1° and 2 mm.)
      const eL = byId.get('elbow_L')!, eR = byId.get('elbow_R')!
      const aL = eL.axes[0] as V3, aR = eR.axes[0] as V3
      const between = Math.acos(Math.min(1, Math.abs(-aL[0] * aR[0] + aL[1] * aR[1] + aL[2] * aR[2])))
      expect(between).toBeLessThan(rad(30))
      const tL = tailOf('elbow_L')
      const forearm = Math.hypot(tL[0] - eL.center[0], tL[1] - eL.center[1], tL[2] - eL.center[2])
      const tol = forearm * Math.sin(between) + 0.01
      const l = moved('elbow_L', 0, rad(90), tailOf('elbow_L')), r = moved('elbow_R', 0, rad(90), tailOf('elbow_R'))
      expect(Math.abs(l[0] + r[0])).toBeLessThan(tol)
      expect(Math.abs(l[1] - r[1])).toBeLessThan(tol)
      expect(Math.abs(l[2] - r[2])).toBeLessThan(tol)
      // 肩外展 90°、前屈 160°：上臂长轴与铅垂线的夹角就是所说的角度，并落在冠状面／矢状面内
      // shoulder abduction 90° and flexion 160°: the upper arm ends at the stated angle from the vertical, in the frontal / sagittal plane
      for (const [id, want, plane] of [['shoulderAbd90', 90, 0], ['shoulderFlex160', 160, 1]] as const) {
        const posture = standardPostures(rig.joints).find((p) => p.id === id)!
        const xf = jointTransforms(rig.joints, posture.pose)
        for (const s of ['L', 'R'] as const) {
          const gh = byId.get(`gh_${s}`)!, k = index.get(`gh_${s}`)!
          const a = xfApply(xf[k]!, gh.center as V3), b = xfApply(xf[k]!, tailOf(`gh_${s}`))
          const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
          const n = Math.hypot(d[0], d[1], d[2])
          expect(Math.acos(-d[1] / n) / rad(1), `${id} ${s}`).toBeCloseTo(want, 1)
          expect(Math.abs(d[plane === 0 ? 2 : 0] / n), `${id} ${s} plane`).toBeLessThan(0.01)
          expect(posture.clamped).toEqual([])
        }
      }
      // 张口：颏向下；颈左旋：鼻尖向左 / mouth opening: the chin goes down; neck rotation to the left: the nose goes left
      expect(moved('tmj', 0, rad(20), tailOf('tmj'))[1]).toBeLessThan(-0.01)
      const c1 = byId.get('C1')!
      const k = c1.dofs.findIndex((d) => d.axis === 2)
      expect(moved('C1', k, rad(30), [c1.center[0], c1.center[1], c1.center[2] + 0.1])[0]).toBeGreaterThan(0.03)
      // 肋上提：肋前端向上 / rib elevation: the front end of the rib goes up
      expect(moved('rib5_L', 0, rad(10), tailOf('rib5_L'))[1]).toBeGreaterThan(0.005)
    })

    it('couples the patella to the knee', () => {
      const d = byId.get('patella_L')!.dofs[0] as Joint['dofs'][number] & { driver?: { joint: string; dof: number; ratio: number } }
      expect(d.driver?.joint).toBe('knee_L')
      expect(d.driver!.ratio).toBeGreaterThan(0.4)
      expect(d.driver!.ratio).toBeLessThan(1.2)
      const xf = jointTransforms(rig.joints, { knee_L: [rad(90), 0] })
      const p = byId.get('patella_L')!
      const tail = (p as Joint & { tail: V3 }).tail
      const q = xfApply(xf[index.get('patella_L')!]!, tail)
      expect(Math.hypot(q[0] - tail[0], q[1] - tail[1], q[2] - tail[2])).toBeGreaterThan(0.02)
    })

    it('has muscle lines between different joints whose length follows the joints', () => {
      expect(rig.muscles.length).toBeGreaterThan(100)
      const parts = new Set(data.parts.map((p) => p.id))
      for (const m of rig.muscles) {
        expect(byId.has(m.origin.joint) && byId.has(m.insertion.joint), m.part).toBe(true)
        expect(m.origin.joint).not.toBe(m.insertion.joint)
        if (fresh) expect(parts.has(m.part)).toBe(true)
      }
      if (!fresh) return
      const byName = new Map(data.parts.map((p) => [p.name, p.id]))
      const line = (name: string) => rig.muscles.find((m) => m.part === byName.get(name))
      const lengthAt = (name: string, b: PoseBuilder): number | null => {
        const l = line(name)
        if (!l) return null
        const L = muscleLength(l, jointTransforms(rig.joints, b.pose), index)
        return L.length / L.rest
      }
      // 屈髋拉长腘绳肌；踝背屈拉长比目鱼肌；屈肘缩短肱二头肌（这些作用线若存在）
      // hip flexion lengthens the hamstrings; ankle dorsiflexion lengthens the soleus; elbow flexion shortens the biceps (where these lines exist)
      const checks: [string, PoseBuilder, 'longer' | 'shorter'][] = [
        ['Left semitendinosus', new PoseBuilder(rig.joints).anat('hip_L', 0, 80), 'longer'],
        ['Long head of left biceps femoris', new PoseBuilder(rig.joints).anat('hip_L', 0, 80), 'longer'],
        ['Left soleus', new PoseBuilder(rig.joints).anat('ankle_L', 0, 12).rel('ankle_L', 0, 0, false), 'longer'],
        ['Long head of left biceps brachii', new PoseBuilder(rig.joints).anat('elbow_L', 0, 110), 'shorter'],
        ['Left brachialis', new PoseBuilder(rig.joints).anat('elbow_L', 0, 110), 'shorter'],
      ]
      let tested = 0
      for (const [name, pose, want] of checks) {
        const r = lengthAt(name, pose)
        if (r === null) continue
        tested++
        if (want === 'longer') expect(r, name).toBeGreaterThan(1.02)
        else expect(r, name).toBeLessThan(0.95)
      }
      expect(tested).toBeGreaterThanOrEqual(2)
    })

    it('reproduces the rest pose exactly and keeps parts whole in the standard postures', () => {
      if (!fresh || !body) return
      const rest = new Poser(rig, bin, {})
      const byName = new Map(body.data.parts.map((p) => [p.name, p]))
      const sample = body.data.parts.filter((_, i) => i % 9 === 0)
      for (const p of sample) {
        const m = body.meshes.get(p.id)!
        const b = rig.bindings.find((x) => x.part === p.id)!
        if (b.vertexCount !== undefined) expect(b.vertexCount, p.id).toBe(m.positions.length / 3)
        for (const mode of ['lbs', 'dqs'] as const) {
          const out = rest.part(p.id, m.positions, mode)
          let worst = 0
          for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i]! - m.positions[i]!))
          expect(worst, `${p.name} ${mode}`).toBeLessThan(1e-6)
        }
      }
      const postures = standardPostures(rig.joints)
      expect(postures.length).toBeGreaterThanOrEqual(15)
      // 屈肘 90°：前臂皮肤随前臂走，肱二头肌仍连着肩胛骨和桡骨
      // elbow at 90°: the forearm's nerve follows the forearm and the biceps still joins scapula and radius
      const elbow = new Poser(rig, bin, postures.find((p) => p.id === 'elbow90')!.pose)
      const biceps = byName.get('Long head of left biceps brachii')
      if (biceps) {
        const m = body.meshes.get(biceps.id)!
        const out = elbow.part(biceps.id, m.positions)
        let mx = 0
        for (let t = 0; t < m.indices.length; t += 3) {
          for (let e = 0; e < 3; e++) {
            const i = m.indices[t + e]! * 3, j = m.indices[t + ((e + 1) % 3)]! * 3
            const l0 = Math.hypot(m.positions[i]! - m.positions[j]!, m.positions[i + 1]! - m.positions[j + 1]!, m.positions[i + 2]! - m.positions[j + 2]!)
            if (l0 > 0.001) mx = Math.max(mx, Math.hypot(out[i]! - out[j]!, out[i + 1]! - out[j + 1]!, out[i + 2]! - out[j + 2]!) / l0)
          }
        }
        expect(mx).toBeLessThan(6)
      }
      // 手的骨随桡骨旋前：腕骨刚性跟随 wrist / the hand follows the radius in pronation
      const hand = rig.bindings.find((b) => b.part === byName.get('Left capitate')?.id)
      expect(hand?.joint).toBe('wrist_L')
    })

    it('passed its own validation', () => {
      if (!fresh || !report?.validation) return
      const v = report.validation
      expect(v.rest.maxDisplacementDqsMm).toBeLessThan(1e-3)
      expect(v.rest.maxDisplacementLbsMm).toBeLessThan(1e-3)
      expect(v.weights).toEqual({ partsWithoutBinding: 0, partsWithTwoBindings: 0, badWeightSums: 0, badJointIndices: 0 })
      const post = (id: string) => v.postures.find((p) => p.id === id)!
      // 铰链关节拟合得好：屈肘、握拳时骨与骨几乎不相互穿入
      // the hinges fit: bones hardly enter each other in elbow flexion and in a fist
      for (const id of ['elbow90', 'elbow140']) {
        const hu = post(id).bones.find((b) => /ulna/.test(b.a + b.b) && /humerus/.test(b.a + b.b))
        // 女性骨骼的肱骨滑车拟合较差（见 rig-report.json），放宽 / the female humeral trochlea fits less well (see rig-report.json): a wider limit
        if (hu) expect(hu.maxDepthMm, id).toBeLessThan(bodyId === 'male' ? 1.5 : 8)
      }
      for (const b of post('fist').bones) expect(b.maxDepthMm, `${b.a} / ${b.b}`).toBeLessThan(bodyId === 'male' ? 1.5 : 3)
      const tf = post('knee90').bones.find((b) => /tibia/.test(b.a + b.b) && /femur/.test(b.a + b.b))
      if (tf) expect(tf.maxDepthMm).toBeLessThan(bodyId === 'male' ? 3 : 6)
      for (const p of v.postures) expect(p.skin.flippedPct, p.id).toBeLessThan(3)
    })
  })
}
