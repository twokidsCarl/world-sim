// 校验生成的面部表情层（public/anatomy/<body>/face.json、face.bin）。
// 尚未生成时跳过：请先运行 `bun tools/face/run.ts male`。依赖几何的断言只在 face.json 记录的
// 输入哈希与磁盘上的文件一致时才执行（几何管线或骨架绑定重新生成后，需要重建面部层）。
// Validates the generated facial expression layer (public/anatomy/<body>/face.json, face.bin).
// Skipped when it has not been built: run `bun tools/face/run.ts male` first. Assertions that
// depend on the geometry run only while the input hashes recorded in face.json match the files on
// disk (after the geometry pipeline or the rig is regenerated the face layer must be rebuilt).
//
// 这里陈述的界限 / Bounds stated here
//   · 单个通道的位移 ≤ 该通道的 excursion ≤ face.bounds.channel ≤ 12 mm；所有通道全激活时每个顶点位移模长之和 ≤ face.bounds.total ≤ 45 mm。
//     例外：口角成形通道（kind 'corner'，只有开口的皮肤才有）抵消的是下颌转动的一半，全激活时可达约 25 mm；它不计入上面两个界限。
//     One channel's displacement ≤ that channel's excursion ≤ face.bounds.channel ≤ 12 mm; the per-vertex sum of magnitudes with every channel fully active ≤ face.bounds.total ≤ 45 mm.
//     Exception: the corner-shaping channel (kind 'corner', opened skins only) cancels half of the jaw's rotation and reaches about 25 mm at full activation; it is outside the two bounds above.
//   · 左右对称：线状肌的作用线互为镜像（0.01 mm 内）、幅度相同；眼周的环和眼睑中心镜像后相差 ≤ 2 mm；皮肤上的场，镜像后的平均位移向量相差 ≤ 1 mm，
//     平均位移模长之比在 0.6–1.67 之间、顶点数之比在 0.5–2 之间（皮肤网格本身左右不对称，面部顶点间距约 5–7 mm，小的场只落在二三十个顶点上）。
//     Left–right symmetry: lines of linear channels mirror each other (within 0.01 mm) with equal excursion; ring and lid centres round the eyes mirror within 2 mm; on the skin, the mirrored
//     mean displacement vectors differ by ≤ 1 mm, the ratio of mean magnitudes lies within 0.6–1.67 and that of vertex counts within 0.5–2 (the skin mesh itself
//     is not symmetric, its facial vertices are 5–7 mm apart, and a small field lands on only twenty or thirty vertices).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnatomyData, Rig } from '../src/anatomy/types.ts'
import type { FaceChannel, FaceData, FaceOpenings } from '../src/face/types.ts'
import { buildFace } from '../tools/face/build.ts'
import { AU_MAX, activations, deform, displacement, expressionAUs, mergeAUs, painAUs, painExpression, pspi, readField } from '../tools/face/model.ts'
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
    // 皮肤有真实的睑裂和口裂时的开口数据 / the openings data when the skin has real eye and mouth openings
    const O = (present && face.openings && existsSync(join(DIR, face.openings)) ? JSON.parse(readFileSync(join(DIR, face.openings), 'utf8')) : null) as FaceOpenings | null
    const cornerMax = present ? Math.max(0, ...face.channels.filter((c) => c.kind === 'corner').map((c) => c.excursion)) : 0
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
        // 口裂内陷是皮肤上的几何替代，不是肌肉 / the oral recess is a geometric stand-in on the skin, not a muscle
        if (ch.kind === 'recess' || ch.kind === 'corner') expect(ch.parts, ch.id).toEqual([])
        else expect(ch.parts.length, ch.id).toBeGreaterThan(0)
        // 舌的示意姿势只作用在舌这个部件上（它不是肌肉组织的部件，也不动皮肤）/ a schematic tongue pose acts on the tongue part only (not a part of muscle tissue, and it leaves the skin alone)
        if (ch.kind === 'tongue') {
          expect(ch.fields.map((f) => f.part), ch.id).toEqual(ch.parts)
          continue
        }
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
      for (const m of ['frontalis_medial', 'frontalis_lateral', 'corrugator', 'procerus', 'llsan', 'lls', 'zygomaticus_minor', 'zygomaticus_major', 'levator_anguli_oris', 'risorius', 'buccinator', 'depressor_anguli_oris', 'depressor_labii_inferioris', 'mentalis', 'nasalis', 'platysma', 'orbicularis_oculi_orbital', 'orbicularis_oculi_palpebral_upper', 'orbicularis_oculi_palpebral_lower']) {
        expect(ids.has(`${m}_L`), `${m}_L`).toBe(true)
        expect(ids.has(`${m}_R`), `${m}_R`).toBe(true)
      }
      expect(ids.has('orbicularis_oris')).toBe(true)
      // 替代通道：闭合的皮肤用口裂内陷，开口的皮肤用口角成形，二者只有其一
      // the stand-in channel: the oral recess on a closed skin, corner shaping on an opened one, never both
      const standIn = O ? 'mouth_corner' : 'oral_recess'
      expect(ids.has(standIn)).toBe(true)
      expect(ids.has(O ? 'oral_recess' : 'mouth_corner')).toBe(false)
      // 口裂内陷只作用于皮肤 / the oral recess acts on the skin only
      expect(chan(standIn).fields.map((f) => f.part)).toEqual([face.skin])
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
      // 唇的几何通道（kind 'lip'）同样在界限之外：lip_seal 抵消的是下颌在 refJaw 处带给下唇的全部位移（约 16 mm）
      // the geometric lip channels (kind 'lip') are outside the bounds too: lip_seal undoes everything the jaw does to the lower lip at refJaw (about 16 mm)
      const lipKind = face.channels.filter((c) => c.kind === 'lip')
      expect(Math.max(...face.channels.filter((c) => c.kind !== 'corner' && c.kind !== 'lip').map((c) => c.excursion))).toBeLessThanOrEqual(12 * MM)
      for (const c of lipKind) expect(c.excursion, c.id).toBeLessThanOrEqual(20 * MM)
      expect(face.bounds.total).toBeLessThanOrEqual(45 * MM + cornerMax + lipKind.reduce((a, c) => a + c.excursion, 0))
      expect(cornerMax).toBeLessThanOrEqual(30 * MM)
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
          expect(R.excursion / L.excursion, L.id).toBeGreaterThan(0.9)
          expect(R.excursion / L.excursion, L.id).toBeLessThan(1.11)
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
      expect(v('frontalis_medial_L').up).toBeGreaterThan(0.5)
      expect(v('frontalis_lateral_L').up).toBeGreaterThan(0.5)
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
      expect(v('mentalis_L').up).toBeGreaterThan(0.5)
      // 颏肌向上提颏部皮肤，几乎没有横向分量（网格是个团块，作用线取精编的方向）
      // mentalis lifts the chin skin with hardly any sideways part (its mesh is a blob, so the line takes the curated direction)
      expect(Math.abs(v('mentalis_L').lateral)).toBeLessThan(0.3)
      expect(Math.abs(v('mentalis_R').lateral)).toBeLessThan(0.3)
      // 颈阔肌：作用到的主要是颏下和颈前的皮肤（法线朝下），所以位移以向后、向外为主，向下的分量小
      // platysma: it mostly reaches the skin under the chin and on the front of the neck (normals pointing down), so the displacement is chiefly backwards and lateral, with a small downward part
      expect(v('platysma_L').up).toBeLessThan(0)
      expect(v('platysma_L').lateral).toBeGreaterThan(0.3)
      expect(meanVec('platysma_L')[2]).toBeLessThan(-0.5)
      expect(v('orbicularis_oculi_palpebral_upper_L').up).toBeLessThan(-0.5)
      expect(v('orbicularis_oculi_palpebral_lower_L').up).toBeGreaterThan(0.1)
      // 作用线：固定端在骨一侧 / lines of action: the fixed end is the bony one
      expect(chan('frontalis_medial_L').line.origin[1]).toBeGreaterThan(chan('frontalis_medial_L').line.insertion[1])
      expect(Math.abs(chan('corrugator_L').line.origin[0] - mid)).toBeLessThan(Math.abs(chan('corrugator_L').line.insertion[0] - mid))
      expect(chan('zygomaticus_major_L').line.origin[1]).toBeGreaterThan(chan('zygomaticus_major_L').line.insertion[1])
      expect(chan('zygomaticus_major_L').line.origin[0] - mid).toBeGreaterThan(chan('zygomaticus_major_L').line.insertion[0] - mid)
      expect(chan('depressor_anguli_oris_L').line.origin[1]).toBeLessThan(chan('depressor_anguli_oris_L').line.insertion[1])
      expect(chan('lls_L').line.origin[1]).toBeGreaterThan(chan('lls_L').line.insertion[1])
    })

    it.skipIf(!fresh)('keeps upper-lip muscles off the lower lip and lower-lip muscles off the upper lip', () => {
      const pos = body!.meshes.get(face.skin)!.positions
      const st = face.landmarks.stomionY.skin
      // inMouth：只看两口角之间（正中 ±18 mm）的顶点。出了口角，上下唇的分界是有意逐渐放宽的。
      // inMouth: only vertices between the mouth corners (midline ± 18 mm). Beyond the corners the split between the lips is widened on purpose.
      const range = (id: string, inMouth = false): [number, number] => {
        const f = skinField(id)
        let lo = Infinity, hi = -Infinity
        for (let i = 0; i < f.index.length; i++) {
          if (Math.hypot(f.delta[i * 3]!, f.delta[i * 3 + 1]!, f.delta[i * 3 + 2]!) < 0.1 * MM) continue
          if (inMouth && Math.abs(pos[f.index[i]! * 3]! - face.landmarks.midX) > 18 * MM) continue
          const y = pos[f.index[i]! * 3 + 1]!
          ;(lo = Math.min(lo, y)), (hi = Math.max(hi, y))
        }
        return [lo, hi]
      }
      // 皮肤按它自己那道随 x 起伏的褶分上下唇，这里只知道正中的高度，所以放宽到 6 mm
      // the skin is split along its own crease, which rises and falls with x; only its midline height is known here, hence the 6 mm allowance
      // 开口的皮肤上，口角 8 mm 内上下唇肌的场是交接的（各占一部分），所以再放宽到 10 mm / on an opened skin the fields of upper-lip and lower-lip muscles hand over within 8 mm of a corner (a share each), hence 10 mm there
      const allow = face.openings ? 10 * MM : 6 * MM
      for (const m of ['lls', 'llsan', 'zygomaticus_minor']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`, true)[0], `${m}_${s}`).toBeGreaterThan(st - allow)
      for (const m of ['depressor_labii_inferioris', 'mentalis', 'platysma']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`, true)[1], `${m}_${s}`).toBeLessThan(st + allow)
      // 眉部的肌肉带动眉下的皮肤，但到上睑缘为止（留 10 mm：睑缘在两眦处比中间低，平滑过的厚度变化还会再越界几毫米）
      // brow muscles carry the skin under the brow, but stop at the upper lid margin (10 mm allowed: the margin is lower at the canthi than in the middle, and the smoothed thickness change spills a few millimetres further)
      const lidTop = Math.max(...face.landmarks.eyes.map((e) => (e.skinFissure ?? e.fissure)!.upperY!))
      for (const m of ['frontalis_medial', 'frontalis_lateral', 'corrugator', 'procerus']) for (const s of ['L', 'R']) expect(range(`${m}_${s}`)[0], `${m}_${s}`).toBeGreaterThan(lidTop - 10 * MM)
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
      expect(ids).toEqual(['AU1', 'AU2', 'AU4', 'AU5', 'AU6', 'AU7', 'AU9', 'AU10', 'AU11', 'AU12', 'AU13', 'AU14', 'AU15', 'AU16', 'AU17', 'AU18', 'AU20', 'AU22', 'AU23', 'AU24', 'AU25', 'AU26', 'AU27', 'AU28', 'AU43'])
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
      expect(new Set(of('AU9'))).toEqual(new Set(['llsan', 'procerus']))
      expect(new Set(of('AU10'))).toEqual(new Set(['lls']))
      expect(new Set(of('AU12'))).toEqual(new Set(['zygomaticus_major']))
      expect(of('AU20')).toContain('risorius')
      expect(of('AU43')).toContain('orbicularis_oculi_palpebral_upper')
      // 模型里没有的肌肉要写明 / muscles the model lacks are declared
      expect(face.aus.find((a) => a.id === 'AU4')!.missing?.join(' ')).toMatch(/depressor supercilii/)
    })

    it('drives the orbital channel with the part named orbital, which is the larger, outer ring', () => {
      for (const side of ['L', 'R']) {
        const outer = byId.get(chan(`orbicularis_oculi_orbital_${side}`).parts[0]!)!, inner = byId.get(chan(`orbicularis_oculi_palpebral_upper_${side}`).parts[0]!)!
        expect(outer.id).not.toBe(inner.id)
        expect(outer.name).toMatch(/orbital part/i)
        expect(inner.name).toMatch(/palpebral part/i)
        expect(chan(`orbicularis_oculi_palpebral_lower_${side}`).parts[0]).toBe(inner.id)
        // 几何上也成立：眶部是外环 / and it holds geometrically: the orbital part is the outer ring
        const size = (p: typeof outer): number => (p.bbox[3] - p.bbox[0]) * (p.bbox[4] - p.bbox[1])
        expect(size(outer)).toBeGreaterThan(size(inner))
      }
      expect(face.cautions.some((c) => /disagree with their ring sizes/.test(c.en))).toBe(false)
    })

    it.skipIf(!fresh || !!O)('closes the shape of the fissure on the skin at AU43, although the skin has no opening', () => {
      // 皮肤上两睑之间那片皮肤：闭眼后，它的顶点在竖直方向上挤到 1.5 mm 以内（睑裂中部 60% 的宽度内）
      // the patch of skin between the lids: with the eyes closed its vertices are squeezed to within 1.5 mm vertically (over the middle 60% of the fissure's width)
      const pos = body!.meshes.get(face.skin)!.positions
      const closed = deform(face.channels, bin, face.skin, pos, activations(face, { AU43: AU_MAX }).channels)
      for (const e of face.landmarks.eyes) {
        const f = e.skinFissure
        expect(f, e.side).toBeTruthy()
        expect(f!.aperture / MM, e.side).toBeGreaterThan(5)
        expect(f!.aperture / MM, e.side).toBeLessThan(14)
        expect((f!.x1 - f!.x0) / MM, e.side).toBeGreaterThan(18)
        expect((f!.x1 - f!.x0) / MM, e.side).toBeLessThan(36)
        const up = skinField(`orbicularis_oculi_palpebral_upper_${e.side}`), lo = skinField(`orbicularis_oculi_palpebral_lower_${e.side}`)
        const moved = new Set<number>([...up.index, ...lo.index])
        const xa = f!.x0 + 0.2 * (f!.x1 - f!.x0), xb = f!.x1 - 0.2 * (f!.x1 - f!.x0)
        // 眼睑的最大行程应接近睑裂的开度 / the largest lid travel should be close to the aperture of the fissure
        let travel = 0
        for (let i = 0; i < up.index.length; i++) travel = Math.max(travel, -up.delta[i * 3 + 1]!)
        expect(travel / f!.aperture, e.side).toBeGreaterThan(0.6)
        expect(travel / f!.aperture, e.side).toBeLessThan(1.1)
        let n = 0
        for (const v of moved) if (pos[v * 3]! > xa && pos[v * 3]! < xb) n++
        expect(n, e.side).toBeGreaterThan(100)
        void closed
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

    it('splits frontalis into a medial and a lateral channel that add up to the whole, for AU1 and AU2', () => {
      const pos = present && fresh && body ? body.meshes.get(face.skin)!.positions : null
      for (const side of ['L', 'R']) {
        const med = skinField(`frontalis_medial_${side}`), lat = skinField(`frontalis_lateral_${side}`)
        expect(chan(`frontalis_medial_${side}`).parts).toEqual(chan(`frontalis_lateral_${side}`).parts)
        if (!pos) continue
        // 内侧通道的位移重心比外侧通道更靠近正中 / the medial channel's displacement is centred nearer the midline than the lateral one's
        const cx = (f: typeof med): number => {
          let sw = 0, sx = 0
          for (let i = 0; i < f.index.length; i++) {
            const w = Math.hypot(f.delta[i * 3]!, f.delta[i * 3 + 1]!, f.delta[i * 3 + 2]!)
            sw += w
            sx += w * Math.abs(pos[f.index[i]! * 3]! - face.landmarks.midX)
          }
          return sx / sw
        }
        expect(cx(lat) - cx(med), side).toBeGreaterThan(10 * MM)
      }
      expect(Object.keys(face.aus.find((a) => a.id === 'AU1')!.channels).sort()).toEqual(['frontalis_medial_L', 'frontalis_medial_R'])
      expect(Object.keys(face.aus.find((a) => a.id === 'AU2')!.channels).sort()).toEqual(['frontalis_lateral_L', 'frontalis_lateral_R'])
    })

    it('has expression prototypes whose AUs exist, scaled by expressionAUs and merged by the larger value', () => {
      const ex = face.expressions ?? []
      // 六种基本情绪在前，其后是 15 种复合情绪（du2014 表 1）/ the six basic emotions first, then the 15 compound ones (Table 1 of du2014)
      expect(ex.slice(0, 6).map((e) => e.id)).toEqual(['happy', 'sad', 'fearful', 'angry', 'surprised', 'disgusted'])
      expect(ex.length).toBe(21)
      for (const e of ex) {
        expect(e.basis.source, e.id).toBe('du2014')
        for (const au of e.prototypical ?? []) expect(Object.keys(e.aus), `${e.id} ${au}`).toContain(au)
        for (const v of Object.values(e.variants ?? {})) expect(v > 0 && v < 1, e.id).toBe(true)
      }
      const defined = new Set(face.aus.map((a) => a.id))
      for (const e of ex) {
        for (const [au, v] of Object.entries(e.aus)) {
          expect(defined.has(au), `${e.id}: ${au}`).toBe(true)
          expect(v).toBeGreaterThan(0)
          expect(v).toBeLessThanOrEqual(AU_MAX)
        }
        // 出处没有打开，必须标明是假设 / the source was not opened, so each must say it is an assumption
        // AU 组合有出处（du2014 表 1），强度是假设，写在 note 里 / the AU set is sourced (Table 1 of du2014); the intensities are assumptions, as the note says
        expect(e.basis.source).toBe('du2014')
        expect(e.basis.note.en).toMatch(/assumption/i)
        expect(e.basis.note.en).toMatch(/[Aa]ssumption|unverified/)
        expect(expressionAUs(ex, e.id, 0)).toEqual({})
        const half = expressionAUs(ex, e.id, 0.5), full = expressionAUs(ex, e.id, 1)
        for (const au of Object.keys(full)) expect(half[au]).toBeCloseTo(full[au]! / 2, 12)
        // 每种表情都真的动了皮肤 / every expression really moves the skin
        const d = displacement(face.channels, bin, face.skin, face.parts[0]!.vertexCount, activations(face, full).channels)
        let max = 0
        for (let i = 0; i < d.length; i += 3) max = Math.max(max, Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!))
        expect(max / MM, e.id).toBeGreaterThan(2)
      }
      expect(expressionAUs(ex, 'nonsense', 1)).toEqual({})
      expect(mergeAUs({ AU4: 2, AU7: 1 }, { AU4: 3, AU12: 4 })).toEqual({ AU4: 3, AU7: 1, AU12: 4 })
    })

    it.skipIf(!O || !fresh)('raises the upper lid margin at AU5 without touching the lower lid or the canthi', () => {
      const d = displacement(face.channels, bin, face.skin, face.parts[0]!.vertexCount, activations(face, { AU5: AU_MAX }).channels)
      for (const side of ['L', 'R'] as const) {
        const up = side === 'L' ? O!.margins.upperLidL : O!.margins.upperLidR, lo = side === 'L' ? O!.margins.lowerLidL : O!.margins.lowerLidR
        const mid = up[up.length >> 1]!
        expect(d[mid * 3 + 1]! / MM, side).toBeGreaterThan(1.5)
        expect(d[mid * 3 + 1]! / MM, side).toBeLessThan(5)
        expect(Math.hypot(d[up[0]! * 3]!, d[up[0]! * 3 + 1]!, d[up[0]! * 3 + 2]!)).toBe(0)
        for (const v of lo.slice(1, -1)) expect(Math.hypot(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!)).toBe(0)
      }
    })

    describe.skipIf(!O)('with real openings in the skin', () => {
      const all = (aus: Record<string, number>): Float32Array => displacement(face.channels, bin, face.skin, face.parts[0]!.vertexCount, activations(face, aus).channels)
      const at = (d: Float32Array, v: number): [number, number, number] => [d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!]
      const gap = (d: Float32Array, a: number, b: number, rest: Float32Array | null = null): number => {
        const p = rest ? [rest[a * 3]! - rest[b * 3]!, rest[a * 3 + 1]! - rest[b * 3 + 1]!, rest[a * 3 + 2]! - rest[b * 3 + 2]!] : [0, 0, 0]
        return Math.hypot(p[0]! + d[a * 3]! - d[b * 3]!, p[1]! + d[a * 3 + 1]! - d[b * 3 + 1]!, p[2]! + d[a * 3 + 2]! - d[b * 3 + 2]!)
      }

      it('has well-formed openings data for this skin', () => {
        const n = face.parts[0]!.vertexCount
        expect(O!.skin).toBe(face.skin)
        expect(O!.vertexCount).toBe(n)
        const lists = [...Object.values(O!.margins), ...Object.values(O!.sheets), ...O!.lidRims.flatMap((r) => [r.vertices, r.of]), O!.oralPouch.upper, O!.oralPouch.lower, O!.oralPouch.seam]
        for (const l of lists) for (const v of l) if (!(Number.isInteger(v) && v >= 0 && v < n)) throw new Error(`bad vertex index ${v}`)
        expect(O!.margins.upperLip.length).toBe(O!.margins.lowerLip.length)
        expect(O!.margins.upperLip[0]).toBe(O!.margins.lowerLip[0])
        expect(O!.margins.upperLip[0]).toBe(O!.points.mouthCornerR)
        expect(O!.margins.upperLip.at(-1)).toBe(O!.points.mouthCornerL)
        expect(O!.oralPouch.upper.length).toBe(O!.oralPouch.rows * O!.oralPouch.columns)
        expect(O!.oralPouch.columns).toBe(O!.margins.upperLip.length - 2)
        for (const r of O!.lidRims) expect(r.of.length).toBe(r.vertices.length)
        // 上下唇两片不相交 / the two lip sheets are disjoint
        const up = new Set(O!.sheets.mouthUpper)
        expect(O!.sheets.mouthLower.some((v) => up.has(v))).toBe(false)
      })

      it('keeps the fissure shut under channels that do not tell the lips apart, and parts the lips under those that do', () => {
        const pairs = O!.margins.upperLip.map((u, i) => [u, O!.margins.lowerLip[i]!] as const).slice(1, -1)
        for (const aus of [{ AU12: AU_MAX }, { AU20: AU_MAX }, { AU4: AU_MAX }, { AU6: AU_MAX }] as Record<string, number>[]) {
          const d = all(aus)
          expect(Math.max(...pairs.map(([a, b]) => gap(d, a, b))), JSON.stringify(aus)).toBeLessThan(0.05 * MM)
        }
        // AU10 上提上唇、AU25 下拉下唇：唇缘分开，且没有下颌转动 / AU10 raises the upper lip and AU25 lowers the lower: the margins part, with no jaw rotation
        expect(activations(face, { AU25: AU_MAX }).jaw).toBe(0)
        // 1.5 mm：提上唇肌的场到唇缘处已经衰减，唇越厚（女性 1.9 mm，男性更大）唇缘抬得越少
        // 1.5 mm: the levator's field has decayed by the time it reaches the margin, and the thicker the lip the less the margin rises (1.9 mm in the female, more in the male)
        expect(Math.max(...pairs.map(([a, b]) => gap(all({ AU10: AU_MAX }), a, b)))).toBeGreaterThan(1.5 * MM)
        expect(Math.max(...pairs.map(([a, b]) => gap(all({ AU25: AU_MAX }), a, b)))).toBeGreaterThan(1.5 * MM)
        // 上唇肌只动上唇缘，下唇肌只动下唇缘 / upper-lip muscles move only the upper margin, lower-lip muscles only the lower
        const d10 = all({ AU10: AU_MAX }), d25 = all({ AU25: AU_MAX })
        // 口角旁的几对除外：口角顶点两片共用，上下唇的肌肉都带着它 / the pairs next to a corner are left out: the corner vertex belongs to both sheets and muscles of either lip carry it
        // 口角 10 mm 内的几对除外：那里上下唇肌的场是交接的 / the pairs within 10 mm of a corner are left out: there the fields of upper-lip and lower-lip muscles hand over
        const rest = body!.meshes.get(face.skin)!.positions
        const cornerPts = [O!.points.mouthCornerL, O!.points.mouthCornerR].map((v) => [rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!])
        const farFromCorners = ([a]: readonly [number, number]): boolean => cornerPts.every((c) => Math.hypot(rest[a * 3]! - c[0]!, rest[a * 3 + 1]! - c[1]!, rest[a * 3 + 2]! - c[2]!) > 10 * MM)
        // AU25 里有 0.15 的提上唇肌，所以这里单看降下唇肌 / AU25 carries 0.15 of levator labii superioris, so the depressor is looked at alone here
        const dDli = displacement(face.channels, bin, face.skin, rest.length / 3, { depressor_labii_inferioris_L: 1, depressor_labii_inferioris_R: 1 })
        for (const [a, b] of pairs.filter(farFromCorners)) {
          // 0.2 mm：褶皱附近的抹匀会从口角带进来一点位移 / 0.2 mm: the evening-out near creases carries a little displacement in from the corners
          expect(Math.hypot(...at(d10, b))).toBeLessThan(0.2 * MM)
          expect(Math.hypot(...at(dDli, a))).toBeLessThan(0.2 * MM)
          expect(at(d10, a)[1]).toBeGreaterThanOrEqual(-0.05 * MM)
          expect(at(d25, b)[1]).toBeLessThanOrEqual(0.05 * MM)
        }
      })

      it('moves the lid rims with their margins and the pouch with the lips', () => {
        const d = all({ AU43: AU_MAX, AU10: AU_MAX, AU20: AU_MAX })
        for (const r of O!.lidRims) r.vertices.forEach((v, i) => expect(gap(d, v, r.of[i]!), `rim ${v}`).toBeLessThan(0.01 * MM))
        // 口腔袋的壁跟随它前面的皮肤：上唇上提时上半有顶点在动，位移不超过皮肤的最大位移；缝不动
        // the pouch wall follows the skin in front of it: with the upper lip raised some of the upper half moves, by no more than the skin's largest displacement; the seam stays
        const d10 = all({ AU10: AU_MAX })
        let skinMax = 0
        // 袋的前壁一直伸到鼻底，所以与整张皮肤的最大位移比较 / the front wall of the pouch reaches up to the base of the nose, hence the comparison with the whole skin
        const pouch = new Set([...O!.oralPouch.upper, ...O!.oralPouch.lower, ...O!.oralPouch.seam])
        for (let v = 0; v < face.parts[0]!.vertexCount; v++) if (!pouch.has(v)) skinMax = Math.max(skinMax, Math.hypot(...at(d10, v)))
        const moved = O!.oralPouch.upper.map((v) => Math.hypot(...at(d10, v)))
        expect(moved.filter((x) => x > 0.5 * MM).length).toBeGreaterThan(10)
        expect(Math.max(...moved)).toBeLessThanOrEqual(skinMax + 1e-6)
        for (const v of O!.oralPouch.seam) expect(Math.hypot(...at(d, v))).toBe(0)
      })

      it.skipIf(!fresh)('closes the eyes at AU43 by bringing the lid margins together, and narrows them at AU7', () => {
        const rest = body!.meshes.get(face.skin)!.positions
        for (const side of ['L', 'R'] as const) {
          const up = side === 'L' ? O!.margins.upperLidL : O!.margins.upperLidR, lo = side === 'L' ? O!.margins.lowerLidL : O!.margins.lowerLidR
          /** 上睑缘各顶点到下睑缘（折线顶点）的最大距离 / the largest distance from an upper-margin vertex to the lower margin (its vertices). */
          const aperture = (aus: Record<string, number>): number => {
            const d = all(aus)
            let worst = 0
            for (const a of up.slice(2, -2)) worst = Math.max(worst, Math.min(...lo.map((b) => gap(d, a, b, rest))))
            return worst
          }
          const open = aperture({}), closed = aperture({ AU43: AU_MAX }), tight = aperture({ AU7: AU_MAX })
          expect(open / MM, side).toBeGreaterThan(5)
          expect(closed / MM, `${side}: closed`).toBeLessThan(1.5)
          expect(tight / open, `${side}: AU7`).toBeGreaterThan(0.3)
          expect(tight / open, `${side}: AU7`).toBeLessThan(0.8)
          // 眦不动 / the canthi stay put
          const d = all({ AU43: AU_MAX })
          expect(Math.hypot(...at(d, up[0]!))).toBe(0)
          expect(Math.hypot(...at(d, up.at(-1)!))).toBe(0)
        }
      })

      it.skipIf(!fresh)('keeps the closing lid margin outside the globe, half-closed and closed', () => {
        const rest = body!.meshes.get(face.skin)!.positions
        for (const e of face.landmarks.eyes) {
          const sgn = e.side === 'L' ? 1 : -1
          const globeParts = data.parts.filter((p) => body!.meshes.has(p.id) && /cornea|sclera/i.test(p.name) && (p.centroid[0] - face.landmarks.midX) * sgn > 0)
          const globe = new Surface(mergeMeshes(globeParts.map((p) => body!.meshes.get(p.id)!)))
          const up = e.side === 'L' ? O!.margins.upperLidL : O!.margins.upperLidR
          for (const k of [2.5, AU_MAX]) {
            const d = all({ AU43: k })
            for (const v of up.slice(1, -1)) {
              const p: [number, number, number] = [rest[v * 3]! + d[v * 3]!, rest[v * 3 + 1]! + d[v * 3 + 1]!, rest[v * 3 + 2]! + d[v * 3 + 2]!]
              const dir = [p[0] - e.globe[0], p[1] - e.globe[1], p[2] - e.globe[2]], l = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
              const far: [number, number, number] = [e.globe[0] + (dir[0]! / l) * 0.05, e.globe[1] + (dir[1]! / l) * 0.05, e.globe[2] + (dir[2]! / l) * 0.05]
              const h = globe.firstHit(far, e.globe as [number, number, number])
              if (h) expect(l - (0.05 - h.distance), `${e.side} AU43 ${k} vertex ${v}`).toBeGreaterThan(0.2 * MM)
            }
          }
        }
      })

      it.skipIf(!fresh)('rounds the mouth corners when the jaw opens: near a corner both margins follow the jaw by about half', () => {
        const corner = chan('mouth_corner')
        expect(corner.kind).toBe('corner')
        expect(face.aus.find((a) => a.id === 'AU27')!.channels.mouth_corner).toBe(1)
        expect(face.aus.find((a) => a.id === 'AU26')!.channels.mouth_corner).toBeCloseTo(face.aus.find((a) => a.id === 'AU26')!.jaw! / face.jaw.max, 3)
        const d = displacement(face.channels, bin, face.skin, face.parts[0]!.vertexCount, { mouth_corner: 1 })
        const n = O!.margins.upperLip.length, mid = n >> 1
        // 正中不动；紧挨口角的一对：上唇缘向下、下唇缘向上（在静止空间里，蒙皮之前）
        // nothing at the middle; the pair next to a corner: upper margin down, lower margin up (in rest space, before skinning)
        expect(Math.hypot(...at(d, O!.margins.upperLip[mid]!))).toBe(0)
        expect(Math.hypot(...at(d, O!.margins.lowerLip[mid]!))).toBe(0)
        for (const i of [1, n - 2]) {
          expect(at(d, O!.margins.upperLip[i]!)[1]).toBeLessThan(-3 * MM)
          expect(at(d, O!.margins.lowerLip[i]!)[1]).toBeGreaterThan(3 * MM)
        }
      })
    })

    it.skipIf(!fresh)('rebuilds to exactly the same bytes', async () => {
      const inputs: Record<string, string> = {}
      const built = buildFace(await readBody(DIR), rig, readCurated(inputs), () => {}, { openings: O, rigBin: new Uint8Array(readFileSync(join(DIR, 'rig.bin'))) })
      built.face.inputs = face.inputs
      expect(Buffer.from(built.bin).equals(Buffer.from(bin))).toBe(true)
      expect(JSON.stringify(built.face)).toBe(raw)
    }, 120_000)
  })
}
