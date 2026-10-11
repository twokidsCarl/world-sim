// 校验 public/anatomy/female（由 `bun run pipeline:female` 根据男性身体和女性锚点包构建）。
// 尚未构建时跳过。
// Validates public/anatomy/female (built by `bun run pipeline:female` from the male body and the
// female anchor package). Skipped when it has not been built.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, NervePath, Part } from '../src/anatomy/types.ts'
import { loadBuiltBody } from '../tools/pipeline/body.ts'
import { runLandmarkChecks } from '../tools/pipeline/landmarks.ts'
import { LAYERS } from '../tools/pipeline/layers.ts'

const DIR = join(import.meta.dirname, '../public/anatomy/female')
const MALE = join(import.meta.dirname, '../public/anatomy/male/anatomy.json')
const present = existsSync(join(DIR, 'anatomy.json')) && existsSync(MALE)

describe.skipIf(!present)('female body (public/anatomy/female)', () => {
  const data = (present ? JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) : null) as AnatomyData
  const male = (present ? JSON.parse(readFileSync(MALE, 'utf8')) : null) as AnatomyData
  const report = (present ? JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) : null) as Record<string, any>
  const byId = new Map<string, Part>(present ? data.parts.map((p) => [p.id, p]) : [])
  const maleById = new Map<string, Part>(present ? male.parts.map((p) => [p.id, p]) : [])
  const maleByName = (n: string) => male.parts.find((p) => p.name === n)!
  const byName = (name: string): Part => {
    const hits = data.parts.filter((p) => p.name === name)
    expect(hits.length, `parts named "${name}"`).toBe(1)
    return hits[0]!
  }
  const len = (p: Part) => Math.hypot(p.bbox[3] - p.bbox[0], p.bbox[4] - p.bbox[1], p.bbox[5] - p.bbox[2])

  it('is a female body with honest sources and provenance', () => {
    expect(data.schema).toBe(1)
    expect(data.body).toBe('female')
    const names = data.sources.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['BodyParts3D 4.0', 'Visible Human Female CT', 'Human Reference Atlas']))
    expect(data.sources.find((s) => s.name === 'Visible Human Female CT')!.attribution).toContain('Courtesy of the U.S. National Library of Medicine')
    expect(data.sources.find((s) => s.name === 'Human Reference Atlas')!.license).toBe('CC BY 4.0')
    expect(byId.size).toBe(data.parts.length)
    for (const p of data.parts) {
      expect(names, p.id).toContain(p.source)
      expect(p.id, p.id).toMatch(/^(W_(FJ\d+M?|R3_FMA\d+|ZA[0-9A-F]{8}|SOMA_[a-z_]+(_[LR])?)|VF_[A-Za-z0-9_]+|VD_[A-Za-z0-9_]+|HRA_[A-Za-z0-9_]+|SOMA_skin)$/)
      if (p.id.startsWith('W_')) {
        // 形变后的男性部件：保留男性部件的身份，并标明其几何的来源
        // warped male part: keeps the male part's identity, names where its geometry came from
        const m = maleById.get(p.id.slice(2))
        expect(m, p.id).toBeDefined()
        // 皮下脂肪在她身上重新推导，不是形变得到的 / the subcutaneous fat is derived again on her body, not warped
        expect(p.provenance, p.id).toBe(/^W_SOMA_fat_/.test(p.id) ? 'curated' : 'warped')
        expect(p.fma).toBe(m!.fma)
        expect(p.name).toBe(m!.name)
        expect(p.source).toBe(m!.source ?? 'BodyParts3D 4.0')
      } else if (p.id.startsWith('HRA_')) {
        expect(p.provenance, p.id).toBe('curated')
        expect(p.source).toBe('Human Reference Atlas')
      } else if (p.id.startsWith('VD_')) {
        // Denver 的冰冻切片模型：同一供体，经重新摆姿势和标准化，标为 warped
        // Denver cryosection models: the same donor, re-posed and standardised, labelled warped
        expect(p.provenance, p.id).toBe('warped')
        expect(p.source).toBe('University of Denver Visible Human lower extremity')
      } else if (p.id === 'SOMA_skin') {
        expect(p.provenance).toBe('curated')
      } else {
        // 标准化之后，她的 CT 部件不再是供体的原样 / after the standardisation her CT parts are no longer as the donor's
        expect(p.provenance, p.id).toBe('warped')
        expect(p.source).toBe('Visible Human Female CT')
      }
      expect(p.bbox.every(Number.isFinite) && p.centroid.every(Number.isFinite), p.id).toBe(true)
      expect(Number.isInteger(p.depth) && p.depth >= 0 && p.depth < LAYERS.length, p.id).toBe(true)
      expect(p.triangles, p.id).toBeGreaterThan(3)
    }
    expect(data.parts.filter((p) => p.system === 'other' || p.tissue === 'other')).toEqual([])
    expect(Array.isArray(report.notes) && report.notes.length).toBeGreaterThan(5)
  })

  it('has no male-only part and has the female ones', () => {
    const maleOnly = data.parts.filter((p) => /\bpenis\b|\btest(is|es|icular)\b|prostat|seminal vesicle|deferent|epididym/i.test(p.name) || p.name === 'Urethra')
    expect(maleOnly.map((p) => p.name)).toEqual([])
    expect(data.parts.filter((p) => p.system === 'reproductive').every((p) => p.provenance === 'curated')).toBe(true)
    for (const n of ['Body of uterus', 'Fundus of uterus', 'Uterine cervix', 'Vagina', 'Left ovary', 'Right ovary', 'Left uterine artery', 'Right round ligament of uterus', 'Left mammary lobe', 'Right mammary lobe']) expect(byName(n).provenance, n).toBe('curated')
    // 男性模型有、她也必须仍然有的结构 / what the male model has and she must still have
    for (const n of ['Urinary bladder', 'Rectum', 'Left kidney', 'Stomach', 'Skin', 'Left sciatic nerve', 'Thyroid gland', 'Upper lobe of left lung']) expect(byName(n)).toBeDefined()
    expect(report.sexChecks.noMaleOnlyParts.pass).toBe(true)
    expect(report.sexChecks.leftRightPresence.pass).toBe(true)
  })

  it('stands on a standardised skeleton: her bones, reference proportions, five lumbar vertebrae', () => {
    const bones = data.parts.filter((p) => p.tissue === 'bone')
    const own = bones.filter((p) => p.id.startsWith('VF_') || p.id.startsWith('VD_'))
    expect(own.length).toBeGreaterThanOrEqual(75)
    // 标准化之前只做过刚性移动；之后一律标为 warped
    // rigidly moved before the standardisation; all labelled warped after it
    expect(report.scannedBones.maxNonRigidDeviationM).toBeLessThan(1e-5)
    expect(own.every((p) => p.provenance === 'warped')).toBe(true)
    expect(data.parts.some((p) => p.provenance === 'scanned')).toBe(false)
    // 目标比例：各项骨性测量在人群均值 ±1 SD 以内（外踝高度除外，其标志点在她的腓骨上不可靠）
    // target proportions: every bony measure within ±1 SD of the population mean (except the lateral malleolus height, whose landmark is unreliable on her fibula)
    const st = report.standard
    expect(st.statureMm).toBe(1606)
    const m = Object.fromEntries(st.measures.map((r: any) => [r.measure, r]))
    expect(Math.abs(m.stature.afterMm - 1606)).toBeLessThan(8)
    for (const k of ['cervicaleheight', 'acromialheight', 'trochanterionheight', 'lateralfemoralepicondyleheight', 'acromionradialelength', 'radialestylionlength', 'biacromialbreadth', 'bicristalbreadth', 'handlengthBone']) {
      expect(Math.abs(m[k].zAfter), k).toBeLessThanOrEqual(1)
    }
    expect(st.outsideOneSd.filter((k: string) => k !== 'lateralmalleolusheight')).toEqual([])
    // 供体比例可由系数还原：每个系数都在限幅范围内并写入报告
    // the donor's proportions can be restored from the factors: each is within its limits and in the report
    for (const k of ['trunk', 'neck', 'head', 'pelvisWidth', 'thoraxWidth', 'thigh', 'shank', 'footHeight', 'footLength', 'upperArm', 'forearm', 'hand', 'clavicle']) {
      expect(st.scales[k], k).toBeGreaterThan(0.75)
      expect(st.scales[k], k).toBeLessThan(1.25)
    }
    // 肩峰在第七颈椎棘突之下（供体的肩带是耸起的） / the acromion lies below the C7 spinous tip (the donor's girdle was raised)
    expect(m.acromialheight.afterMm).toBeLessThan(m.cervicaleheight.afterMm - 30)
    expect(m.acromialheight.donorMm).toBeGreaterThan(m.cervicaleheight.donorMm)
    // 五节腰椎：多出的那一节不输出，T12 直接叠在 L1 上
    // five lumbar vertebrae: the supernumerary one is not shipped, T12 sits directly on L1
    expect(report.lumbar.decision).toBe('five')
    expect(data.parts.some((p) => /Supernumerary/.test(p.name))).toBe(false)
    expect(data.trees.isa.some((c) => c.id === 'VFC_supernumerary_lumbar_vertebra')).toBe(false)
    const stack = ['Twelfth thoracic vertebra', 'First lumbar vertebra', 'Second lumbar vertebra', 'Third lumbar vertebra', 'Fourth lumbar vertebra', 'Fifth lumbar vertebra', 'Sacrum'].map((n) => byName(n))
    for (let i = 1; i < stack.length; i++) {
      expect(stack[i]!.centroid[1], `vertebra ${i}`).toBeLessThan(stack[i - 1]!.centroid[1])
      // 相邻椎骨之间没有一个椎体高的空档 / no gap of a vertebral height between neighbours
      expect(stack[i - 1]!.bbox[1] - stack[i]!.bbox[4], `gap ${i}`).toBeLessThan(0.012)
    }
    // 右前臂是左侧的镜像 / the right forearm mirrors the left
    expect(byName('Right radius')).toMatchObject({ provenance: 'warped', source: 'Visible Human Female CT' })
    expect(Math.abs(len(byName('Right radius')) - len(byName('Left radius')))).toBeLessThan(0.01)
    // 跗骨是她自己的（Denver），手骨是形变后的男性骨 / the tarsals are her own (Denver), the hand bones are warped male bones
    expect(byName('Left calcaneus')).toMatchObject({ id: 'VD_calcaneus_left', source: 'University of Denver Visible Human lower extremity' })
    expect(byName('Left capitate').id).toMatch(/^W_/)
  })

  it('uses her real leg and pelvis muscles, knee ligaments and cartilages (Denver)', () => {
    const vd = data.parts.filter((p) => p.id.startsWith('VD_'))
    // 76 块肌中，接腱不干净的 14 块改用男性的肌 / of the 76 muscles, the 14 without a clean tendon splice fall back to the male muscle
    expect(vd.filter((p) => p.tissue === 'muscle').length).toBe(76 - report.denverTendons.maleMuscleKept.length)
    expect(report.denverTendons.maleMuscleKept.length).toBeLessThanOrEqual(16)
    expect(report.denverTendons.endsAttached).toBeGreaterThan(60)
    expect(report.denverTendons.notAttached).toEqual([])
    expect(vd.filter((p) => p.tissue === 'ligament').length).toBe(8)
    expect(vd.filter((p) => p.tissue === 'cartilage').length).toBe(16)
    expect(vd.filter((p) => p.tissue === 'bone').length).toBe(14)
    for (const n of ['Left psoas major', 'Left iliacus', 'Right obturator internus', 'Left piriformis', 'Right quadratus femoris', 'Left anterior cruciate ligament', 'Right posterior cruciate ligament', 'Left fibular collateral ligament', 'Left tibial collateral ligament']) {
      expect(byName(n)?.id, n).toMatch(/^VD_/)
    }
    // 没有与之重复的形变男性部件 / no warped male duplicate of any of them
    const names = new Map<string, number>()
    for (const p of data.parts) names.set(p.name, (names.get(p.name) ?? 0) + 1)
    for (const p of vd) expect(names.get(p.name), p.name).toBe(1)
    expect(data.parts.some((p) => /^W_/.test(p.id) && /deep part of tibial collateral ligament/i.test(p.name))).toBe(false)
    // 摆姿势后两端与骨的距离基本不变 / the ends keep their distance to the bones through the posing
    expect(report.denverEnds.checked).toBeGreaterThan(120)
    // 接腱之后，仍够不到骨 10 mm 以上的肌端只剩少数（阔筋膜张肌止于髂胫束，本就不到骨）
    // with the tendons attached, few muscle ends remain more than 10 mm short of their bone (tensor fasciae latae ends in the iliotibial tract, not on bone)
    expect(report.denverEnds.stillShort.length).toBeLessThanOrEqual(6)
    // 各有概念，并挂在树上 / each has a concept and hangs in the trees
    const inIsa = new Set(data.trees.isa.flatMap((c) => c.parts))
    for (const p of vd) expect(inIsa.has(p.id), p.id).toBe(true)
    expect(byName('Left tibial collateral ligament').fma).not.toBe(byName('Right tibial collateral ligament').fma)
    expect(data.sources.find((s) => s.name === 'University of Denver Visible Human lower extremity')!.license).toBe('CC BY 4.0')
  })

  it('hangs carried-over ligaments on her bones and thins the muscle envelope to the girth targets', () => {
    const j = report.jointLocal
    expect(j.used).toBeGreaterThan(200)
    expect(j.used / j.nearBone).toBeGreaterThan(0.7)
    for (const x of report.misplaced) expect(data.parts.some((p) => p.id === `W_${x.id}`), x.name).toBe(false)
    const env = Object.fromEntries(report.envelope.regions.map((r: any) => [r.region, r]))
    for (const k of ['upperArm', 'forearm', 'waist', 'thighMid', 'calf']) {
      // 收薄之后，包络围度不超过目标的 5 % / after thinning the envelope girth is within 5 % above its target
      expect(env[k].envelopeAfterMm / env[k].envelopeTargetMm, k).toBeLessThan(1.06)
      expect(env[k].envelopeAfterMm, k).toBeLessThanOrEqual(env[k].envelopeBeforeMm)
      expect(env[k].lambda, k).toBeGreaterThanOrEqual(0.6)
    }
    expect(report.skinPackage.internalsKey).toMatch(/^[0-9a-f]{16}$/)
    expect(typeof report.skinPackage.installed).toBe('boolean')
  })

  it('stands in the male pose on the same floor', () => {
    const minY = Math.min(...data.parts.map((p) => p.bbox[1]))
    const maxY = Math.max(...data.parts.map((p) => p.bbox[4]))
    const maleMinY = Math.min(...male.parts.map((p) => p.bbox[1]))
    expect(Math.abs(minY - maleMinY)).toBeLessThan(0.02)
    expect(maxY - minY).toBeGreaterThan(1.5)
    expect(maxY - minY).toBeLessThan(1.75)
    // 上肢垂于体侧，下肢竖直并分开，与男性相同
    // arms down beside the body, legs vertical and apart, as in the male
    for (const [n, sign] of [['Left', 1], ['Right', -1]] as const) {
      const hand = byName(`${n} capitate`)
      const shoulder = byName(`${n} humerus`)
      expect(hand.centroid[1]).toBeLessThan(shoulder.bbox[1])
      expect(hand.centroid[0] * sign).toBeGreaterThan(0.15)
      const femur = byName(`${n} femur`)
      const tibia = byName(`${n} tibia`)
      expect(Math.abs(femur.centroid[0] - tibia.centroid[0])).toBeLessThan(0.06)
      expect(Math.abs(femur.centroid[2] - tibia.centroid[2])).toBeLessThan(0.06)
      expect(byName(`${n} calcaneus`).centroid[1]).toBeLessThan(tibia.bbox[1] + 0.03)
      expect(femur.centroid[0] * sign).toBeGreaterThan(0.05)
    }
    expect(byName('Frontal bone').centroid[1]).toBeGreaterThan(byName('Mandible').centroid[1])
    expect(byName('Body of sternum').centroid[2]).toBeGreaterThan(byName('Sixth thoracic vertebra').centroid[2] + 0.06)
  })

  it('puts the female organs where they belong', () => {
    const uterus = byName('Body of uterus')
    expect(byName('Urinary bladder').centroid[2]).toBeGreaterThan(uterus.centroid[2])
    expect(uterus.centroid[2]).toBeGreaterThan(byName('Rectum').centroid[2])
    expect(Math.abs(uterus.centroid[0])).toBeLessThan(0.02)
    const hips = [byName('Left hip bone'), byName('Right hip bone')]
    for (const [n, sign] of [['Left ovary', 1], ['Right ovary', -1]] as const) {
      const o = byName(n)
      expect(o.centroid[0] * sign).toBeGreaterThan(0.02)
      expect(o.centroid[0] * sign).toBeLessThan(0.09)
      expect(o.centroid[1]).toBeGreaterThan(Math.min(...hips.map((h) => h.bbox[1])))
      expect(o.centroid[1]).toBeLessThan(Math.max(...hips.map((h) => h.bbox[4])))
      expect(o.centroid[2]).toBeGreaterThan(byName('Sacrum').bbox[2])
    }
    expect(byName('Vagina').centroid[1]).toBeLessThan(uterus.centroid[1])
    for (const side of ['left', 'right']) {
      const breast = byName(`${side[0]!.toUpperCase()}${side.slice(1)} mammary lobe`)
      const pec = byName(`Sternocostal part of ${side} pectoralis major`)
      expect(breast.centroid[2]).toBeGreaterThan(pec.centroid[2])
      expect(breast.bbox[5]).toBeGreaterThan(pec.bbox[5])
      expect(Math.abs(breast.centroid[1] - pec.centroid[1])).toBeLessThan(0.12)
    }
    for (const k of ['uterusBetweenBladderAndRectum', 'leftOvaryInPelvis', 'rightOvaryInPelvis', 'leftBreastAnteriorToPectoralis', 'rightBreastAnteriorToPectoralis']) expect(report.sexChecks[k].pass, k).toBe(true)
  })

  it('lists cautions in both languages and keeps left and right concepts apart', () => {
    expect(data.cautions!.length).toBeGreaterThanOrEqual(8)
    for (const c of data.cautions!) {
      expect(c.en.length).toBeGreaterThan(40)
      expect(c.zh).toMatch(/[\u4e00-\u9fff]/)
    }
    expect(data.cautions![0]!.en).toContain('not a scan of one person')
    expect(data.cautions!.map((c) => c.en).join(' ')).toMatch(/body surface is a (PLACEHOLDER|parametric model skin)/)
    expect(data.cautions!.map((c) => c.en).join(' ')).toMatch(/five-lumbar/)
    expect(data.cautions!.map((c) => c.zh).join(' ')).toMatch(/标准女性/)
    const sides = new Map<string, Set<string>>()
    for (const p of data.parts) if (p.id.startsWith('HRA_') && p.side !== 'M') sides.set(p.fma, (sides.get(p.fma) ?? new Set()).add(p.side))
    expect([...sides].filter(([, v]) => v.size > 1).map(([k]) => k)).toEqual([])
    expect(byName('Left mammary lobe').fma).not.toBe(byName('Right mammary lobe').fma)
  })

  it('clears the uterus, ovaries and tubes from the bowel and the bladder', () => {
    const pelvis = report.collisions.pelvis
    // 修正前：左卵巢 100 %、左输卵管 98 %、子宫 30 % 位于形变后的乙状结肠内
    // was: left ovary 100 %, left tube 98 %, uterus 30 % inside the warped sigmoid colon
    for (const k of ['uterus', 'left ovary', 'left uterine tube', 'right ovary', 'right uterine tube']) {
      expect(pelvis.insideDescendingColon.after[k], k).toBeLessThan(0.02)
      expect(pelvis.insideBladder.after[k], k).toBeLessThan(0.02)
    }
    expect(pelvis.insideDescendingColon.before['left ovary']).toBeGreaterThan(0.9)
    expect(pelvis.insideBladder.after.vagina).toBeLessThan(0.05)
    // 肠管仍是一条大小相近的管，位于她的骨和膀胱之外
    // the bowel stayed a tube of about the same size, outside her bones and bladder
    expect(pelvis.colon.volumeMlAfter / pelvis.colon.volumeMlBefore).toBeGreaterThan(0.75)
    expect(pelvis.colon.surfaceInsideBone).toBeLessThan(0.02)
    expect(pelvis.colon.surfaceInsideBladder).toBeLessThan(0.02)
    expect(report.collisions.hraSetMovedPosteriorMm).toBeLessThanOrEqual(12)
    // 不再有任何生殖结构大部分位于另一个器官内
    // nothing reproductive is mostly inside another organ any more
    const worst = Math.max(0, ...Object.values(report.collisions.hraInsideOthers as Record<string, { inside: number }>).map((v) => v.inside))
    expect(worst).toBeLessThan(0.3)
  })

  it('wraps the skin over the breasts', () => {
    const s = report.skin.breastSurfaceInFrontOfSkin
    expect(s.before.left).toBeGreaterThan(0.3)
    expect(s.after.left).toBeLessThan(0.02)
    expect(s.after.right).toBeLessThan(0.02)
    const skin = byName('Skin')
    expect(skin.provenance).toBe('warped')
    for (const n of ['Left mammary lobe', 'Right mammary lobe']) expect(byName(n).bbox[5]).toBeLessThan(skin.bbox[5] + 1e-6)
    // 包络是局部的：皮肤没有比原先更宽或更高，只是在胸部前后方向更深
    // the envelope is local: the skin is no wider or taller than before, only deeper at the chest
    expect(report.skin.verticesRaised / report.skin.ofVertices).toBeLessThan(0.1)
    expect(report.shoulder.left.differenceMm).toBeDefined()
  })

  it('keeps the deformation in bounds and reports where it is not', () => {
    const j = report.jacobian
    expect(j.samples).toBeGreaterThan(20000)
    // 空间折叠：相邻骨彼此相对移动的地方可以容忍，但应很少
    // folded space: tolerated where neighbouring bones moved against each other, but rare
    expect(j.folded / j.samples).toBeLessThan(0.01)
    expect(j.median).toBeGreaterThan(0.8)
    expect(j.median).toBeLessThan(1.1)
    expect(j.p01).toBeGreaterThan(0)
    expect(j.p99).toBeLessThan(3)
    const all = report.registration.byRegion.find((r: any) => r.region === 'all')
    expect(Number(all.residual.split(' / ')[0])).toBeLessThan(4) // 锚点残差的中位数，mm / median anchor residual, mm
    expect(report.interpenetration.meanInsideAfter).toBeLessThan(0.03)
    expect(report.interpenetration.nerves.inBoneAfter).toBeLessThan(0.01)
    // 长肌的两端仍止于各自的骨上 / long muscles still end on their bones
    const att = report.attachments as { ok: boolean; femaleMm: number; muscle: string; end: string }[]
    // （下肢的肌现在是 Denver 的肌腹模型，另行检查；这里是仍由男性形变而来的肌）
    // (the leg muscles are now the Denver belly models, checked elsewhere; these are the muscles still warped from the male)
    expect(att.length).toBeGreaterThanOrEqual(24)
    expect(att.filter((a) => a.ok).length / att.length).toBeGreaterThan(0.85)
    for (const a of att.filter((x) => /calcaneal tendon/.test(x.muscle))) expect(a.femaleMm, `${a.muscle} ${a.end}`).toBeLessThan(5)
  })

  it('puts every part in one GLB and passes the nerve landmark checks on the shipped geometry', async () => {
    const body = await loadBuiltBody(DIR)
    expect(body.meshes.size).toBe(data.parts.length)
    for (const s of data.systems) expect(s.partCount, s.id).toBe(data.parts.filter((p) => p.system === s.id).length)
    const meshes = new Map<string, any>()
    const nerves = new Map<string, any>()
    for (const p of data.parts) {
      if (!meshes.has(p.name)) meshes.set(p.name, body.meshes.get(p.id))
      if (body.nerves.has(p.id) && !nerves.has(p.name)) nerves.set(p.name, body.nerves.get(p.id))
    }
    const results = runLandmarkChecks({ mesh: (n) => meshes.get(n) ?? null, nerve: (n) => nerves.get(n) ?? null })
    expect(results.length).toBe(18)
    // 已知的弱点：左侧第 5–9 肋的 CT 标签不可靠，肋间神经检查可能不过
    // known weakness: the CT labels of left ribs 5–9 are unreliable and the intercostal check may fail
    // 坐骨神经是男性结构，未按她真实的腘绳肌（Denver）重新贴合：它在股二头肌与半膜肌之间的位置检查处于临界
    // the sciatic nerve is a male structure not refitted to her real hamstrings (Denver): its position between biceps femoris and semimembranosus is borderline
    expect(results.filter((r) => !r.evaluated || !r.pass).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
  }, 120_000)

  it('ships consistent nerves.json, adjacency and trees', () => {
    const nerves = JSON.parse(readFileSync(join(DIR, 'nerves.json'), 'utf8')) as NervePath[]
    expect(nerves.length).toBeGreaterThan(350)
    for (const n of nerves) {
      const part = byId.get(n.part)
      expect(part?.tissue, n.part).toBe('nerve')
      for (const b of n.branches) {
        expect(b.radius.length, n.part).toBe(b.points.length / 3)
        for (let i = 0; i < b.points.length; i += 3) for (let k = 0; k < 3; k++) {
          expect(b.points[i + k]!, part!.name).toBeGreaterThanOrEqual(part!.bbox[k]! - b.radius[i / 3]! - 2e-4)
          expect(b.points[i + k]!, part!.name).toBeLessThanOrEqual(part!.bbox[k + 3]! + b.radius[i / 3]! + 2e-4)
        }
      }
    }
    for (const p of data.parts) {
      expect(p.adjacent.length, p.id).toBeLessThanOrEqual(250)
      for (const q of p.adjacent) expect(byId.get(q)?.adjacent.includes(p.id), `${p.id} ↔ ${q}`).toBe(true)
    }
    expect(byName('Skin').adjacent).toEqual([])
    for (const tree of [data.trees.isa, data.trees.partOf]) {
      const ids = new Set<string>()
      const kids = new Set<string>()
      for (const c of tree) {
        expect(ids.has(c.id), c.id).toBe(false)
        if (c.parent !== null) {
          expect(ids.has(c.parent), `${c.id}: parent first`).toBe(true)
          kids.add(c.parent)
        }
        ids.add(c.id)
        for (const p of c.parts) expect(byId.has(p), `${c.id} → ${p}`).toBe(true)
      }
      for (const c of tree) if (!kids.has(c.id)) expect(c.parts.length, `leaf ${c.name}`).toBeGreaterThan(0)
    }
    const reached = new Set(data.trees.isa.flatMap((c) => c.parts))
    expect(data.parts.filter((p) => !reached.has(p.id)).map((p) => p.id)).toEqual([])
    const isa = new Map(data.trees.isa.map((c) => [c.id, c]))
    for (const p of data.parts) expect(isa.has(p.fma), `${p.id} ${p.fma}`).toBe(true)
    // 男性特有的概念已去掉，女性的概念已加入
    // male-only concepts are gone, female ones are there
    const names = new Set(data.trees.isa.map((c) => c.name))
    expect(names.has('prostate')).toBe(false)
    expect(names.has('testis')).toBe(false)
    expect([...names].some((n) => /ovary/.test(n))).toBe(true)
    const genital = data.trees.partOf.find((c) => c.name === 'genital system')!
    const under = data.trees.partOf.filter((c) => c.parent === genital.id).flatMap((c) => c.parts)
    expect(under).toContain('HRA_left_ovary')
  })

  it('has a subcutaneous fat layer derived on her own body', () => {
    const fat = data.parts.filter((p) => /^W_SOMA_fat_/.test(p.id))
    expect(fat.map((p) => p.id).sort()).toEqual(['head', 'lower_limb_L', 'lower_limb_R', 'neck', 'trunk', 'upper_limb_L', 'upper_limb_R'].map((r) => `W_SOMA_fat_${r}`))
    const skin = data.parts.find((p) => p.name === 'Skin')!
    for (const p of fat) {
      expect(p.tissue).toBe('fat')
      expect(p.system).toBe('integumentary')
      expect(LAYERS[p.depth]!.key).toBe('fat')
      expect(p.adjacent, p.id).toEqual([])
      // 在皮肤包围盒之内 / inside the skin's bounding box
      for (let k = 0; k < 3; k++) {
        expect(p.bbox[k]!, p.id).toBeGreaterThanOrEqual(skin.bbox[k]! - 1e-4)
        expect(p.bbox[k + 3]!, p.id).toBeLessThanOrEqual(skin.bbox[k + 3]! + 1e-4)
      }
    }
    expect(data.cautions!.some((c) => /subcutaneous fat/i.test(c.en) && /皮下脂肪/.test(c.zh))).toBe(true)
  })

  it('opens a passage for the vagina through the pelvic floor and keeps the pelvic order', () => {
    const h = report.collisions.hiatus
    // 阴道表面基本不在肛提肌各部和直肠之内 / the vaginal surface is essentially outside every levator part and the rectum
    for (const [k, v] of Object.entries(h.vaginaInside.after as Record<string, number>)) if (k !== 'Urinary bladder') expect(v, k).toBeLessThan(0.01)
    expect(h.vaginaInside.before['Right puborectalis']).toBeGreaterThan(0.05)
    // 已知的残留：阴道与膀胱仍有少量重叠 / known residue: the vagina still overlaps the bladder slightly
    expect(h.vaginaInside.after['Urinary bladder']).toBeLessThan(0.07)
    expect(h.hiatus.transverseMm).toBeGreaterThan(25)
    expect(h.hiatus.transverseMm).toBeLessThan(50)
    expect(h.vagina.lengthMm).toBeGreaterThan(45)
    expect(h.vagina.lengthMm).toBeLessThan(110)
    expect(h.vagina.upperEndIsPosterior).toBe(true)
    const z = report.sexChecks.uterusBetweenBladderAndRectum.zMm
    expect(z.bladder).toBeGreaterThan(z.uterus)
    expect(z.uterus).toBeGreaterThan(z.rectum)
    expect(data.cautions!.map((c) => c.en).join(' ')).toMatch(/arrangement of the pelvic organs is constructed/)
    expect(data.cautions!.map((c) => c.zh).join(' ')).toMatch(/盆腔器官的排列是构造出来的/)
  })
})
