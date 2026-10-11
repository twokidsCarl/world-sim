// 校验生成的面部表情层（public/anatomy/<body>/face.json、face.bin）。
// 尚未生成时跳过：请先运行 `bun tools/face/run.ts male`。依赖几何的断言只在 face.json 记录的
// 输入哈希与磁盘上的文件一致时才执行（几何管线或骨架绑定重新生成后，需要重建面部层）。
// Validates the generated facial expression layer (public/anatomy/<body>/face.json, face.bin).
// Skipped when it has not been built: run `bun tools/face/run.ts male` first. Assertions that
// depend on the geometry run only while the input hashes recorded in face.json match the files on
// disk (after the geometry pipeline or the rig is regenerated the face layer must be rebuilt).
//
// 这里陈述的界限 / Bounds stated here
//   · 单个通道的位移 ≤ face.bounds.channel ≤ 12 mm；所有通道全激活时每个顶点位移模长之和 ≤ face.bounds.total ≤ 40 mm。
//     One channel's displacement ≤ face.bounds.channel ≤ 12 mm; the per-vertex sum of magnitudes with every channel fully active ≤ face.bounds.total ≤ 40 mm.
//   · 左右对称：线状肌的作用线互为镜像（0.01 mm 内）、幅度相同；眼周的环和眼睑中心镜像后相差 ≤ 2 mm；皮肤上的场，镜像后的平均位移向量相差 ≤ 1 mm，
//     平均位移模长之比在 0.6–1.67 之间、顶点数之比在 0.5–2 之间（皮肤网格本身左右不对称，面部顶点间距约 5–7 mm，小的场只落在二三十个顶点上）。
//     Left–right symmetry: lines of linear channels mirror each other (within 0.01 mm) with equal excursion; ring and lid centres round the eyes mirror within 2 mm; on the skin, the mirrored
//     mean displacement vectors differ by ≤ 1 mm, the ratio of mean magnitudes lies within 0.6–1.67 and that of vertex counts within 0.5–2 (the skin mesh itself
//     is not symmetric, its facial vertices are 5–7 mm apart, and a small field lands on only twenty or thirty vertices).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnatomyData, Rig } from '../src/anatomy/types.ts'
import type { FaceChannel, FaceData } from '../src/face/types.ts'
import { buildFace } from '../tools/face/build.ts'
import { AU_MAX, activations, deform, displacement, painAUs, painExpression, pspi, readField } from '../tools/face/model.ts'
import { readCurated, stale } from '../tools/face/run.ts'
import { Surface, mergeMeshes } from '../tools/rig/geom.ts'
import { type Body, readBody } from '../tools/rig/io.ts'

const MM = 0.001

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'face.json')) && existsSync(join(DIR, 'face.bin')) && existsSync(join(DIR, 'anatomy.json')) && existsSync(join(DIR, 'rig.json'))

  describe.skipIf(!present)(`face output (public/anatomy/${bodyId})`, () => {
    const raw = present ? readFileSync(join(DIR, 'face.json'), 'utf8') : '{}'
    const face = JSON.parse(raw) as FaceData
    const bin = present ? new Uint8Array(readFileSync(join(DIR, 'face.bin'))) : new Uint8Array(0)
    const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : { parts: [] }) as AnatomyData
    const rig = (present ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : { joints: [] }) as Rig
    const byId = new Map(data.parts.map((p) => [p.id, p]))
    const changed = present ? stale(DIR) : ['absent']
    const fresh = changed.length === 0
    const chan = (id: string): FaceChannel => face.channels.find((c) => c.id === id)!
    const skinField = (id: string): ReturnType<typeof readField> => readField(bin, chan(id).fields.find((f) => f.part === face.skin)!)
    /** 一个通道在皮肤上的平均位移向量（毫米）。 Mean displacement vector of a channel on the skin (mm). */
    const meanVec = (id: string): [number, number, number] => {
      const f = skinField(id)
      const s: [number, number, number] = [0, 0, 0]
      for (let i = 0; i < f.index.length; i++) for (let c = 0; c < 3; c++) s[c] = s[c]! + f.delta[i * 3 + c]! / MM / f.index.length
      return s
    }
    let body: Body | null = null
    beforeAll(async () => {
      if (present && fresh) body = await readBody(DIR)
      else if (present) console.warn(`face (${bodyId}) was built from other inputs; geometry checks skipped: ${changed.slice(0, 4).join(', ')}`)
    })

    it('says what it is: a model of pain behaviour, with sources and assumptions marked', () => {
      expect(face.schema).toBe(1)
      expect(face.body).toBe(bodyId)
      expect(face.note.en).toMatch(/no subjective experience/)
      expect(face.note.zh).toMatch(/没有主观感受/)
      expect(face.cautions.length).toBeGreaterThanOrEqual(4)
      const ids = new Set(face.sources.map((s) => s.id))
      for (const s of face.sources) {
        expect(s.url, s.id).toMatch(/^https:\/\//)
        expect(s.license.length, s.id).toBeGreaterThan(0)
        expect(s.opened.en.length, s.id).toBeGreaterThan(20)
      }
      // 每条依据要么指向一个出处，要么明说是假设 / every basis either points at a source or says it is an assumption
      const bases = [face.pain.pspi.basis, face.pain.mapping, face.pain.timing.basis, ...face.aus.map((a) => a.basis)]
      for (const b of bases) {
        if (b.source === null) expect(b.note.en).toMatch(/[Aa]ssumption/)
        else expect(ids.has(b.source), b.source).toBe(true)
      }
      expect(face.pain.mapping.source).toBeNull()
      expect(face.pain.timing.basis.source).toBeNull()
      expect(face.pain.pspi.basis.source).not.toBeNull()
    })

    it('contains no local paths or e-mail addresses', () => {
      expect(raw).not.toMatch(/\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\\\/)
      expect(raw).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/)
    })

    it('references only parts that exist, and drives channels with muscles', () => {
      expect(byId.get(face.skin)?.tissue).toBe('skin')
      expect(face.parts[0]!.part).toBe(face.skin)
      const listed = new Set(face.parts.map((p) => p.part))
      for (const p of face.parts) expect(byId.has(p.part), p.part).toBe(true)
      for (const ch of face.channels) {
        expect(ch.parts.length, ch.id).toBeGreaterThan(0)
        for (const id of ch.parts) expect(byId.get(id)?.tissue, `${ch.id}: ${id}`).toBe('muscle')
        for (const f of ch.fields) expect(listed.has(f.part), `${ch.id}: ${f.part}`).toBe(true)
        // 每个通道都在皮肤上有位移 / every channel moves the skin
        expect(ch.fields[0]?.part, ch.id).toBe(face.skin)
      }
      for (const id of [...face.jaw.closers, ...face.jaw.openers]) expect(byId.get(id)?.tissue, id).toBe('muscle')
      expect(face.jaw.closers.length).toBeGreaterThanOrEqual(6)
      expect(face.jaw.openers.length).toBeGreaterThanOrEqual(2)
      // 不动的：骨、牙、脑、眼球 / never displaced: bone, teeth, brain, the eyeball
      for (const p of face.parts) {
        const part = byId.get(p.part)!
        expect(['bone', 'tooth', 'brain'].includes(part.tissue), part.name).toBe(false)
        expect(/cornea|sclera|lens|vitreous/i.test(part.name), part.name).toBe(false)
      }
    })

    it('has the expected channels on both sides', () => {
      const ids = new Set(face.channels.map((c) => c.id))
      expect(ids.size).toBe(face.channels.length)
      for (const m of ['frontalis', 'corrugator', 'procerus', 'llsan', 'lls', 'zygomaticus_minor', 'zygomaticus_major', 'levator_anguli_oris', 'risorius', 'buccinator', 'depressor_anguli_oris', 'depressor_labii_inferioris', 'mentalis', 'nasalis', 'platysma', 'orbicularis_oculi_orbital', 'orbicularis_oculi_palpebral_upper', 'orbicularis_oculi_palpebral_lower']) {
        expect(ids.has(`${m}_L`), `${m}_L`).toBe(true)
        expect(ids.has(`${m}_R`), `${m}_R`).toBe(true)
      }
      expect(ids.has('orbicularis_oris')).toBe(true)
    })

    it('uses the tmj joint of the rig for the jaw', () => {
      const j = rig.joints.find((x) => x.id === face.jaw.joint)
      expect(j, face.jaw.joint).toBeDefined()
      expect(face.jaw.max).toBeCloseTo(j!.dofs[face.jaw.dof]!.max, 9)
      for (const au of face.aus) if (au.jaw !== undefined) expect(au.jaw).toBeLessThanOrEqual(face.jaw.max + 1e-9)
      expect(activations(face, { AU27: 5 }).jaw).toBeCloseTo(face.jaw.max, 4)
      expect(activations(face, { AU26: 5 }).jaw).toBeGreaterThan(0.1)
      expect(activations(face, { AU26: 5, AU27: 5 }).jaw).toBeLessThanOrEqual(face.jaw.max)
    })

    it('stores fields that are well-formed, finite and bounded', () => {
      expect(bin.length).toBe(face.binBytes)
      expect(face.bounds.channel).toBeLessThanOrEqual(12 * MM)
      expect(face.bounds.total).toBeLessThanOrEqual(40 * MM)
      const counts = new Map(face.parts.map((p) => [p.part, p.vertexCount]))
      const sum = new Map<string, Float64Array>()
      const entries = new Map<string, number>()
      let end = 0
      for (const ch of face.channels) {
        expect(ch.excursion, ch.id).toBeGreaterThan(0)
        expect(ch.excursion, ch.id).toBeLessThanOrEqual(face.bounds.channel + 1e-9)
        for (const f of ch.fields) {
          expect(f.offset % 4).toBe(0)
          expect(f.offset).toBeGreaterThanOrEqual(end)
          end = f.offset + f.count * 10
          expect(end).toBeLessThanOrEqual(bin.length)
          expect(f.count).toBeGreaterThan(0)
          expect(Number.isFinite(f.scale) && f.scale > 0, `${ch.id} ${f.part}`).toBe(true)
          const n = counts.get(f.part)!
          const { index, delta } = readField(bin, f)
          let acc = sum.get(f.part)
          if (!acc) sum.set(f.part, (acc = new Float64Array(n)))
          entries.set(f.part, (entries.get(f.part) ?? 0) + f.count)
          let prev = -1, max = 0
          for (let i = 0; i < index.length; i++) {
            if (index[i]! <= prev || index[i]! >= n) throw new Error(`${ch.id} ${f.part}: bad vertex index ${index[i]} after ${prev} (n = ${n})`)
            prev = index[i]!
            const l = Math.hypot(delta[i * 3]!, delta[i * 3 + 1]!, delta[i * 3 + 2]!)
            if (!Number.isFinite(l)) throw new Error(`${ch.id} ${f.part}: non-finite displacement`)
            max = Math.max(max, l)
            acc[index[i]!] = acc[index[i]!]! + l
          }
          expect(max, `${ch.id} ${f.part}`).toBeLessThanOrEqual(face.bounds.channel + 1e-6)
          // 皮肤上的位移不超过该通道声明的幅度（留出量化误差）/ on the skin no displacement exceeds the channel's stated excursion (quantisation allowed for)
          if (f.part === face.skin) expect(max, ch.id).toBeLessThanOrEqual(ch.excursion * 1.001 + 1e-6)
        }
      }
      let total = 0
      for (const acc of sum.values()) for (const x of acc) total = Math.max(total, x)
      expect(total).toBeLessThanOrEqual(face.bounds.total + 1e-6)
      for (const p of face.parts) expect(entries.get(p.part), p.part).toBe(p.entries)
    })

    it('is the rest shape at zero activation, and linear in the activation', () => {
      const n = face.parts[0]!.vertexCount
      expect(displacement(face.channels, bin, face.skin, n, {}).every((x) => x === 0)).toBe(true)
      expect(displacement(face.channels, bin, face.skin, n, activations(face, painAUs(face.pain, 0)).channels).every((x) => x === 0)).toBe(true)
      expect(painExpression(face, 0)).toEqual({ aus: {}, channels: {}, jaw: 0, pspi: 0 })
      const a = displacement(face.channels, bin, face.skin, n, { corrugator_L: 1 }), h = displacement(face.channels, bin, face.skin, n, { corrugator_L: 0.5 })
      for (let i = 0; i < a.length; i++) if (Math.abs(h[i]! - a[i]! / 2) > 1e-9) throw new Error('not linear')
    })

    it('is left–right symmetric within the stated tolerance', () => {
      const mid = face.landmarks.midX
      for (const L of face.channels.filter((c) => c.side === 'L')) {
        const R = chan(`${L.muscle}_R`)
        expect(R, L.id).toBeDefined()
        if (L.kind === 'linear') {
          expect(R.excursion, L.id).toBe(L.excursion)
          for (const k of ['origin', 'insertion'] as const) {
            expect(R.line[k][0] - mid, `${L.id} ${k}`).toBeCloseTo(-(L.line[k][0] - mid), 5)
            expect(R.line[k][1], `${L.id} ${k}`).toBeCloseTo(L.line[k][1], 5)
            expect(R.line[k][2], `${L.id} ${k}`).toBeCloseTo(L.line[k][2], 5)
          }
        } else {
          // 眼周的环和眼睑以各自的眼球和睑裂为准：中心镜像后相差 ≤ 2 mm，幅度相近
          // the rings and lids round the eye follow each eye's own globe and fissure: centres mirror within 2 mm, excursions are similar
          expect(Math.hypot(R.line.origin[0] - mid + (L.line.origin[0] - mid), R.line.origin[1] - L.line.origin[1], R.line.origin[2] - L.line.origin[2]), L.id).toBeLessThanOrEqual(2 * MM)
          expect(R.excursion / L.excursion, L.id).toBeGreaterThan(0.75)
          expect(R.excursion / L.excursion, L.id).toBeLessThan(1.33)
        }
        const l = skinField(L.id), r = skinField(R.id)
        const ml = meanVec(L.id), mr = meanVec(R.id)
        expect(Math.hypot(ml[0] + mr[0], ml[1] - mr[1], ml[2] - mr[2]), `${L.id}: mirrored mean vectors`).toBeLessThanOrEqual(1)
        const mag = (f: typeof l): number => {
          let s = 0
          for (let i = 0; i < f.index.length; i++) s += Math.hypot(f.delta[i * 3]!, f.delta[i * 3 + 1]!, f.delta[i * 3 + 2]!)
          return s / f.index.length
        }
        expect(mag(l) / mag(r), `${L.id}: mean magnitude`).toBeGreaterThan(0.6)
        expect(mag(l) / mag(r), `${L.id}: mean magnitude`).toBeLessThan(1.67)
        expect(l.index.length / r.index.length, `${L.id}: vertex count`).toBeGreaterThan(0.5)
        expect(l.index.length / r.index.length, `${L.id}: vertex count`).toBeLessThan(2)
      }
    })

    it('moves the skin the way each muscle is described to act', () => {
      const mid = face.landmarks.midX
      // 朝向正中为负（对左侧通道）/ towards the midline is negative (for a left channel)
      const v = (id: string): { lateral: number; up: number } => ({ lateral: meanVec(id)[0], up: meanVec(id)[1] })
      expect(v('frontalis_L').up).toBeGreaterThan(0.5)
      expect(v('corrugator_L').lateral).toBeLessThan(-0.2)
      expect(v('corrugator_L').up).toBeLessThan(0)
      expect(v('corrugator_R').lateral).toBeGreaterThan(0.2)
      expect(v('procerus_L').up).toBeLessThan(-0.2)
      expect(v('llsan_L').up).toBeGreaterThan(0.3)
      expect(v('lls_L').up).toBeGreaterThan(0.5)
      expect(v('zygomaticus_major_L').up).toBeGreaterThan(0.3)
      expect(v('zygomaticus_major_L').lateral).toBeGreaterThan(0.3)
      expect(v('risorius_L').lateral).toBeGreaterThan(0.3)
      expect(v('risorius_R').lateral).toBeLessThan(-0.3)
      expect(v('depressor_anguli_oris_L').up).toBeLessThan(-0.3)
      expect(v('depressor_labii_inferioris_L').up).toBeLessThan(-0.3)
      expect(v('mentalis_L').up).toBeGreaterThan(0.2)
      expect(v('platysma_L').up).toBeLessThan(-0.3)
      expect(v('orbicularis_oculi_palpebral_upper_L').up).toBeLessThan(-0.5)
      expect(v('orbicularis_oculi_palpebral_lower_L').up).toBeGreaterThan(0.1)
      // 作用线：固定端在骨一侧 / lines of action: the fixed end is the bony one
      expect(chan('frontalis_L').line.origin[1]).toBeGreaterThan(chan('frontalis_L').line.insertion[1])
      expect(Math.abs(chan('corrugator_L').line.origin[0] - mid)).toBeLessThan(Math.abs(chan('corrugator_L').line.insertion[0] - mid))
      expect(chan('zygomaticus_major_L').line.origin[1]).toBeGreaterThan(chan('zygomaticus_major_L').line.insertion[1])
      expect(chan('zygomaticus_major_L').line.origin[0] - mid).toBeGreaterThan(chan('zygomaticus_major_L').line.insertion[0] - mid)
      expect(chan('depressor_anguli_oris_L').line.origin[1]).toBeLessThan(chan('depressor_anguli_oris_L').line.insertion[1])
      expect(chan('lls_L').line.origin[1]).toBeGreaterThan(chan('lls_L').line.insertion[1])
    })

    it.skipIf(!fresh)('keeps upper-lip muscles off the lower lip and lower-lip muscles off the upper lip', () => {
      const pos = body!.meshes.get(face.skin)!.positions
      const st = face.landmarks.stomionY.skin
      const range = (id: string): [number, number] => {
        const f = skinField(id)
        let lo = Infinity, hi = -Infinity
        for (let i = 0; i < f.index.length; i++) {
          if (Math.hypot(f.delta[i * 3]!, f.delta[i * 3 + 1]!, f.delta[i * 3 + 2]!) < 0.1 * MM) continue
          const y = pos[f.index[i]! * 3 + 1]!
          ;(lo = Math.min(lo, y)), (hi = Math.max(hi, y))
        }
        return [lo, hi]
      }
      for (const m of ['lls', 'llsan', 'zygomaticus_minor']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`)[0], `${m}_${s}`).toBeGreaterThan(st - 1.5 * MM)
      for (const m of ['depressor_labii_inferioris', 'mentalis', 'platysma']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`)[1], `${m}_${s}`).toBeLessThan(st + 1.5 * MM)
      // 眉部的肌肉不动睑裂以下的皮肤 / brow muscles leave the skin below the eye opening alone
      const eyeY = face.landmarks.eyes.reduce((s2, e) => s2 + e.globe[1], 0) / face.landmarks.eyes.length
      for (const m of ['frontalis', 'corrugator', 'procerus']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`)[0], `${m}_${s}`).toBeGreaterThan(eyeY)
    })

    it.skipIf(!fresh)('matches the vertex counts of the meshes it displaces', () => {
      for (const p of face.parts) expect(body!.meshes.get(p.part)!.positions.length / 3, p.part).toBe(p.vertexCount)
    })

    it.skipIf(!fresh)('closes the eyes at AU43 and narrows them at AU7 (lid meshes over the globe)', () => {
      expect(face.landmarks.eyes.length).toBe(2)
      /** 从前方看得见眼球的面积，mm²。 Area of the globe visible from the front, mm². */
      const openArea = (aus: Record<string, number>, side: string): number => {
        const e = face.landmarks.eyes.find((x) => x.side === side)!
        const sgn = side === 'L' ? 1 : -1
        const act = activations(face, aus).channels
        const lidParts = data.parts.filter((p) => body!.meshes.has(p.id) && (/orbicularis oculi/i.test(p.name) || /tarsal plate/i.test(p.name)) && (p.centroid[0] - face.landmarks.midX) * sgn > 0)
        const lids = new Surface(mergeMeshes(lidParts.map((p) => ({ positions: deform(face.channels, bin, p.id, body!.meshes.get(p.id)!.positions, act), indices: body!.meshes.get(p.id)!.indices }))))
        let open = 0
        for (let x = e.globe[0] - e.radius; x <= e.globe[0] + e.radius; x += 0.5 * MM) {
          for (let y = e.globe[1] - e.radius; y <= e.globe[1] + e.radius; y += 0.25 * MM) {
            const d2 = e.radius ** 2 - (x - e.globe[0]) ** 2 - (y - e.globe[1]) ** 2
            if (d2 > 0 && !lids.firstHit([x, y, e.globe[2] + 0.06], [x, y, e.globe[2] + Math.sqrt(d2)])) open += 0.125
          }
        }
        return open
      }
      for (const side of ['L', 'R']) {
        const rest = openArea({}, side), au7 = openArea({ AU7: AU_MAX }, side), au43 = openArea({ AU43: AU_MAX }, side), half = openArea({ AU43: AU_MAX / 2 }, side)
        expect(rest, side).toBeGreaterThan(80)
        expect(au43 / rest, `${side}: closed`).toBeLessThan(0.05)
        expect(au7 / rest, `${side}: narrowed`).toBeLessThan(0.7)
        expect(au7 / rest, `${side}: narrowed, not closed`).toBeGreaterThan(0.2)
        expect(half).toBeLessThan(rest)
        expect(half).toBeGreaterThan(au43)
      }
    })

    it('defines every pain-coded AU, each acting through channels or the jaw', () => {
      const ids = face.aus.map((a) => a.id)
      expect(ids).toEqual(['AU4', 'AU6', 'AU7', 'AU9', 'AU10', 'AU12', 'AU20', 'AU25', 'AU26', 'AU27', 'AU43'])
      const channels = new Set(face.channels.map((c) => c.id))
      for (const au of face.aus) {
        expect(Object.keys(au.channels).length + (au.jaw ? 1 : 0), au.id).toBeGreaterThan(0)
        for (const [id, w] of Object.entries(au.channels)) {
          expect(channels.has(id), `${au.id}: ${id}`).toBe(true)
          expect(w).toBeGreaterThan(0)
          expect(w).toBeLessThanOrEqual(1)
        }
        // 两侧同时激活 / both sides together
        for (const id of Object.keys(au.channels)) if (id.endsWith('_L')) expect(au.channels[`${id.slice(0, -2)}_R`], `${au.id}: ${id}`).toBe(au.channels[id])
      }
      const of = (id: string): string[] => Object.keys(face.aus.find((a) => a.id === id)!.channels).map((c) => chan(c).muscle)
      expect(new Set(of('AU4'))).toEqual(new Set(['corrugator', 'procerus']))
      expect(of('AU6')).toContain('orbicularis_oculi_orbital')
      expect(of('AU7')).toContain('orbicularis_oculi_palpebral_lower')
      expect(new Set(of('AU9'))).toEqual(new Set(['llsan']))
      expect(new Set(of('AU10'))).toEqual(new Set(['lls']))
      expect(new Set(of('AU12'))).toEqual(new Set(['zygomaticus_major']))
      expect(of('AU20')).toContain('risorius')
      expect(of('AU43')).toContain('orbicularis_oculi_palpebral_upper')
      // 模型里没有的肌肉要写明 / muscles the model lacks are declared
      expect(face.aus.find((a) => a.id === 'AU4')!.missing?.join(' ')).toMatch(/depressor supercilii/)
    })

    it('uses the orbicularis oculi rings by geometry: the orbital channel drives the larger ring', () => {
      for (const side of ['L', 'R']) {
        const outer = byId.get(chan(`orbicularis_oculi_orbital_${side}`).parts[0]!)!, inner = byId.get(chan(`orbicularis_oculi_palpebral_upper_${side}`).parts[0]!)!
        expect(outer.id).not.toBe(inner.id)
        const size = (p: typeof outer): number => (p.bbox[3] - p.bbox[0]) * (p.bbox[4] - p.bbox[1])
        expect(size(outer)).toBeGreaterThan(size(inner))
      }
    })

    it('maps pain 0–10 to a PSPI that rises monotonically from 0 to its maximum', () => {
      const P = face.pain
      expect(P.pspi.terms).toEqual(['AU4', ['AU6', 'AU7'], ['AU9', 'AU10'], 'AU43'])
      expect(P.pspi.max).toBe(16)
      expect(P.keyframes[0]).toEqual({ level: 0, aus: {} })
      expect(P.keyframes[P.keyframes.length - 1]!.level).toBe(10)
      const defined = new Set(face.aus.map((a) => a.id))
      for (const k of P.keyframes) for (const [id, v] of Object.entries(k.aus)) {
        expect(defined.has(id), id).toBe(true)
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThanOrEqual(AU_MAX)
      }
      expect(pspi(P, painAUs(P, 0))).toBe(0)
      expect(pspi(P, painAUs(P, 10))).toBe(16)
      // 整数强度上严格递增；细网格上不减（AU43 取 0/1 和连续两种算法都是）
      // strictly increasing on integer levels; non-decreasing on a fine grid (with AU43 both as 0/1 and continuous)
      for (const continuous of [false, true]) {
        for (let l = 1; l <= 10; l++) expect(pspi(P, painAUs(P, l), continuous), `level ${l}`).toBeGreaterThan(pspi(P, painAUs(P, l - 1), continuous))
        let prev = 0
        for (let l = 0; l <= 10.0001; l += 0.05) {
          const s = pspi(P, painAUs(P, l), continuous)
          expect(s, `level ${l.toFixed(2)}`).toBeGreaterThanOrEqual(prev - 1e-9)
          prev = s
        }
      }
      // 每个 AU 的强度、每个通道的激活、下颌角也都不随强度下降 / no AU intensity, channel activation or jaw angle falls as the level rises
      let last = painExpression(face, 0)
      for (let l = 0.25; l <= 10; l += 0.25) {
        const cur = painExpression(face, l)
        for (const [id, v] of Object.entries(last.aus)) expect(cur.aus[id] ?? 0, `${id} at ${l}`).toBeGreaterThanOrEqual(v - 1e-9)
        for (const [id, v] of Object.entries(last.channels)) expect(cur.channels[id] ?? 0, `${id} at ${l}`).toBeGreaterThanOrEqual(v - 1e-9)
        expect(cur.jaw).toBeGreaterThanOrEqual(last.jaw - 1e-9)
        last = cur
      }
      // 低强度时只有眉和眼睑；口和闭眼出现得晚 / only brow and lids at low levels; the mouth and eye closure come late
      expect(Object.keys(painAUs(P, 2)).sort()).toEqual(['AU4', 'AU7'])
      expect(painExpression(face, 4).jaw).toBe(0)
      expect(painExpression(face, 10).jaw).toBeGreaterThan(0)
      expect(P.timing.onset).toBeGreaterThan(0)
      expect(P.timing.offset).toBeGreaterThan(0)
    })

    it.skipIf(!fresh)('rebuilds to exactly the same bytes', async () => {
      const inputs: Record<string, string> = {}
      const built = buildFace(await readBody(DIR), rig, readCurated(inputs), () => {})
      built.face.inputs = face.inputs
      expect(Buffer.from(built.bin).equals(Buffer.from(bin))).toBe(true)
      expect(JSON.stringify(built.face)).toBe(raw)
    }, 120_000)
  })
}
