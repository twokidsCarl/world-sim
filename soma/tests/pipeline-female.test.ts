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
import { boundaryLoops, edgeTopology, FACE_MUSCLE_NAME, faceRegionOfSkin, loadSkinPackage, skinResolution } from '../tools/pipeline/skinPackage.ts'
import { DISPLAY_FILE, SKIN_PIECES_FILE, SKIN_SOURCE_FILE, type OpenedSkinReport } from '../tools/pipeline/skinOpened.ts'
import { OPENED_SKIN_POSITION_BITS, positionStep, readGlb } from '../tools/pipeline/glb.ts'

// 这组测试接受三种状态，按 pipeline-report.json 自己判断（与 pipeline-output.test.ts 对男性的做法相同）：
//   A · 没有装入皮肤包（report.skinPackage.installed 为假：包不存在，或是按别的内部结构指纹拟合的）：
//       身体带的是占位皮肤（形变来的男性皮肤，胸部抬高），附属物不动；
//   B · 装入了皮肤作者的闭合包（installed 为真，没有 report.skinPackage.opened）：一张闭合的皮肤，
//       没有 skin-source.u32、skin-pieces.u8，说明里写“眼和口不是开口”；
//   C · 装入了开口后的包（report.skinPackage.opened 存在；<包>-open 由 tools/skinopen 写出）：发布的皮肤有
//       眼和口的开口（两个边界环）、移植片，位置取 16 位，旁边有 skin-source.u32 和 skin-pieces.u8；
//       凡是判断内外的数（fit、fitShipped、notFitted、乳房的摆放、脂肪）都是在闭合的那张皮肤上量的。
// 三种状态下都有 display.json。
// These tests accept three states and tell them apart from pipeline-report.json (as pipeline-output.test.ts
// does for the male):
//   A · no skin package installed (report.skinPackage.installed false: no package, or one fitted to
//       another internals fingerprint): the body carries the placeholder skin (the warped male skin,
//       raised over the chest) and untouched appendages;
//   B · the author's closed package installed (installed true, no report.skinPackage.opened): one closed
//       skin, no skin-source.u32 or skin-pieces.u8, and the cautions say eye and mouth are not openings;
//   C · the opened package installed (report.skinPackage.opened present; <package>-open is written by
//       tools/skinopen): the shipped skin has eye and mouth openings (two boundary loops) and grafts,
//       16-bit positions, and skin-source.u32 and skin-pieces.u8 beside it; every figure that needs inside
//       tests (fit, fitShipped, notFitted, the breast placement, the fat) is measured on the closed skin.
// display.json is there in all three.

// SOMA_FEMALE_DIR：改为校验另一个目录里的构建（管线的 --out） / SOMA_FEMALE_DIR: validate a build in another directory instead (the pipeline's --out)
const DIR = process.env.SOMA_FEMALE_DIR ?? join(import.meta.dirname, '../public/anatomy/female')
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
  const skinInstalled = !!report?.skinPackage?.installed
  // 状态 C：装入的是开口后的包 / state C: the opened package is the one installed
  const skinOpened = skinInstalled && !!report?.skinPackage?.opened

  it('is a female body with honest sources and provenance', () => {
    expect(data.schema).toBe(1)
    expect(data.body).toBe('female')
    const names = data.sources.map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['BodyParts3D 4.0', 'Visible Human Female CT', 'Human Reference Atlas', 'Wu et al. 2015 pelvic floor']))
    expect(data.sources.find((s) => s.name === 'Visible Human Female CT')!.attribution).toContain('Courtesy of the U.S. National Library of Medicine')
    expect(data.sources.find((s) => s.name === 'Human Reference Atlas')!.license).toBe('CC BY 4.0')
    expect(byId.size).toBe(data.parts.length)
    for (const p of data.parts) {
      expect(names, p.id).toContain(p.source)
      expect(p.id, p.id).toMatch(/^(W_(FJ\d+M?(_upper|_lower)?|R3_FMA\d+|ZA[0-9A-F]{8}|SOMA_[a-z_]+(_[LR])?)|VF_[A-Za-z0-9_]+|VD_[A-Za-z0-9_]+|HRA_[A-Za-z0-9_]+|WU_[a-z_]+(_[LR])?|SOMA_skin)$/)
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
      } else if (p.id.startsWith('WU_')) {
        // Wu 等 2015 的盆底结构：另一位女性，作者重建并平滑 / pelvic-floor structures of Wu et al. 2015: another woman, reconstructed and smoothed by the authors
        expect(p.provenance, p.id).toBe('curated')
        expect(p.source).toBe('Wu et al. 2015 pelvic floor')
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
    for (const n of ['Uterus', 'Vagina', 'Left ovary', 'Right ovary', 'Left uterine tube', 'Left uterine artery', 'Right round ligament of uterus', 'Left mammary lobe', 'Right mammary lobe']) expect(byName(n).provenance, n).toBe('curated')
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
    const uterus = byName('Uterus')
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
      // 高度：腺体中心距胸大肌胸肋部中心不超过 12 cm，且落在胸肋部的上下缘之间（sexChecks 的 leftBreastLevel / rightBreastLevel）。
      // （皮肤包第一版把乳房放得偏低，这两项当时不通过，12 cm 曾临时放到 14 cm；重发的包已通过，界限已恢复。）
      // Level: the gland centre within 12 cm of the centre of the sternocostal pectoralis, and between its upper and lower
      // border (sexChecks leftBreastLevel / rightBreastLevel).
      // (The first issue of the skin package put the breasts too low; both failed then and the 12 cm was moved to 14 cm
      // for a time. The re-issued package passes and the bound is restored.)
      expect(Math.abs(breast.centroid[1] - pec.centroid[1])).toBeLessThan(0.12)
    }
    for (const k of ['uterusBetweenBladderAndRectum', 'leftOvaryInPelvis', 'rightOvaryInPelvis', 'leftBreastAnteriorToPectoralis', 'rightBreastAnteriorToPectoralis', 'leftBreastLevel', 'rightBreastLevel']) expect(report.sexChecks[k].pass, k).toBe(true)
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
    const bowel = report.pelvis.bowel
    // 修正前：左侧附件约 80 %、子宫约 23 % 位于形变后的乙状结肠内
    // was: about 80 % of the left adnexa and 23 % of the uterus inside the warped sigmoid colon
    for (const k of ['uterus', 'left adnexa', 'right adnexa']) expect(bowel.adnexaAndUterusInsideColonPct.after[k], k).toBeLessThan(1)
    expect(bowel.adnexaAndUterusInsideColonPct.before['left adnexa']).toBeGreaterThan(50)
    // 肠管仍是一条大小相近的管 / the bowel stayed a tube of about the same size
    expect(bowel.colonVolumeMl / report.pelvis.rectosigmoid.colonVolumeMl.before).toBeGreaterThan(0.75)
    expect(bowel.colonVolumeMl / report.pelvis.rectosigmoid.colonVolumeMl.before).toBeLessThan(1.25)
    for (const sh of bowel.shifts) expect(sh.bowelInBoneBladderOrRectumPct, sh.organ).toBeLessThan(2)
  })

  it.skipIf(!present || !!report?.skinPackage?.installed)('wraps the placeholder skin over the breasts', () => {
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
  })

  // 发布的数据必须装着开口后的皮肤包，而不是占位皮肤：指纹对不上时构建只是悄悄退回占位皮肤，其余测试会各自跳过。
  // 外展角是钉住的那个（皮肤包按它拟合），且仍满足间隙要求；自动判据的结果只作记录。
  // The shipped data must carry the opened skin package, not the placeholder: on a fingerprint mismatch the build merely
  // falls back to the placeholder and the other tests skip themselves. The abduction angle is the pinned one (the skin
  // package was fitted at it) and still meets the gap requirement; the automatic result is on record only.
  it.skipIf(!present)('ships the opened skin package, at the pinned abduction angle', () => {
    expect(report.skinPackage.installed).toBe(true)
    expect(report.skinPackage.opened).toBeDefined()
    expect(report.skinPackage.fittedTo.key).toBe(report.skinPackage.internalsKey)
    const ab = report.armAbduction
    expect(ab.applied).toBe(true)
    expect(ab.pinned).toBe(true)
    expect(ab.angleDeg).toBe(7.5)
    expect(typeof ab.automaticWouldChoose).toBe('number')
    expect(ab.gapNeededMm).toBe(ab.requirement.minGapMm + 1)
    expect(ab.gapAtPinnedAngleMm).toBeGreaterThanOrEqual(ab.gapNeededMm)
    expect(ab.reason.zh.length).toBeGreaterThan(10)
    expect(ab.reason.en.length).toBeGreaterThan(10)
  })

  it.skipIf(!present || !report?.armAbduction?.applied)('abducts the arms just far enough to open the axillae, with the male\'s criterion', () => {
    const ab = report.armAbduction
    expect(ab.angleDeg).toBeGreaterThan(0)
    expect(ab.angleDeg).toBeLessThanOrEqual(25)
    expect(ab.requirement.minGapMm).toBe(12)
    expect(ab.limbBones).toEqual({ left: 30, right: 30 })
    const bands: string[] = ab.gapBands
    const wallFrom = bands.indexOf(ab.requirement.wallFromBand)
    const foldsFrom = bands.indexOf(ab.requirement.foldsFromBand)
    expect(wallFrom).toBeGreaterThanOrEqual(0)
    expect(foldsFrom).toBeGreaterThanOrEqual(wallFrom)
    for (const side of ['left', 'right']) {
      const g = ab.sides[side].gapMm
      // 外展之前这个间隙不够，之后够了；盂肱关节间隙没有变 / the gap was short before and is met after; the glenohumeral gap did not change
      expect(Math.min(...g.before.folds.slice(foldsFrom)), side).toBeLessThan(12)
      for (let k = wallFrom; k < bands.length; k++) expect(g.after.wall[k], `${side} wall ${bands[k]}`).toBeGreaterThanOrEqual(12)
      for (let k = foldsFrom; k < bands.length; k++) expect(g.after.folds[k], `${side} folds ${bands[k]}`).toBeGreaterThanOrEqual(12)
      expect(Math.abs(ab.sides[side].glenohumeralGap.after.medianMm - ab.sides[side].glenohumeralGap.before.medianMm), side).toBeLessThan(0.5)
    }
    expect(ab.attachments.movedOffBoneByMoreThan1Mm).toBe(0)
    expect(ab.field.jacobian.nonPositive).toBe(0)
    // 外展之后才算指纹：皮肤包要按外展后的内部结构拟合 / the fingerprint is taken after the abduction: a skin must be fitted to the abducted internals
    expect(report.skinPackage.skeletonKey).not.toBe(report.skinPackage.internalsKeyBeforeShape)
    const c = data.cautions!.find((x) => /turned .*° outwards/.test(x.en))
    expect(c).toBeDefined()
    expect(c!.zh).toMatch(/向外转了/)
  })

  it('straightens the fingers to the angles within the male hand', () => {
    const rows = report.standard.fingerRays.rows as { side: string; finger: string; turnedDeg: number }[]
    expect(rows.length).toBe(10)
    // 一只手的五个指列转过的角度应当相近（整排手指相对掌骨歪了同一个角度） / the five rays of one hand turn by about the same angle (the whole row of fingers was off by one angle against the metacarpus)
    for (const side of ['left', 'right']) {
      const t = rows.filter((r) => r.side === side).map((r) => r.turnedDeg)
      expect(Math.max(...t) - Math.min(...t), side).toBeLessThan(5)
    }
    // 中指与第三掌骨大致成一线（冠状面内，与男性的手相差不到 6°） / the middle finger roughly in line with the third metacarpal (coronal plane, within 6° of the male hand)
    const ang = (parts: Part[], a: string, b: string) => {
      const p = parts.find((x) => x.name === a)!.centroid
      const q = parts.find((x) => x.name === b)!.centroid
      return (Math.atan2(q[0] - p[0], q[1] - p[1]) * 180) / Math.PI
    }
    for (const [S, s] of [['Left', 'left'], ['Right', 'right']]) {
      const kink = (parts: Part[]) => ang(parts, `Proximal phalanx of ${s} middle finger`, `Distal phalanx of ${s} middle finger`) - ang(parts, `${S} capitate`, `${S} third metacarpal bone`)
      expect(Math.abs(kink(data.parts) - kink(male.parts)), S).toBeLessThan(6)
    }
  })

  it('conforms hair, eyebrows and nails to an installed skin, and says so when there is none', () => {
    const app = report.appendages
    expect(app).toBeDefined()
    expect(app.applied).toBe(!!report.skinPackage.installed)
    if (!app.applied) {
      expect(app.reason).toMatch(/no skin package installed/)
      return
    }
    const rows = app.parts as { id: string; name: string; kind: string; before: { outside: number; maxMm: number }; after: { outside: number; maxMm: number } }[]
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const id of app.conformedIds) expect(byId.has(id), id).toBe(true)
    // 外耳不动，列在 hideWithOpaqueSkin 里；乳头、乳晕不是附属物 / the auricle is left alone and listed under hideWithOpaqueSkin; nipple and areola are no appendages
    expect(app.hideWithOpaqueSkin).toContain(data.parts.find((p) => p.name === 'External ear')!.id)
    expect(app.conformedIds.some((id: string) => /^HRA_/.test(id))).toBe(false)
  })

  it('reports the glenohumeral gap on both sides', () => {
    expect(report.shoulder.left.differenceMm).toBeDefined()
  })

  it.skipIf(!present || !report?.skinPackage?.installed)('carries the skin fitted to her internals, with the breast parts placed under it', async () => {
    const sp = report.skinPackage
    // 按这一版内部结构（体形重塑之后）拟合的皮肤包；占位皮肤和胸部抬升都不再有
    // the package fitted to these internals (after the body-shape stage); no placeholder skin and no chest raise any more
    expect(sp.fittedTo).toEqual({ body: 'female', key: sp.internalsKey })
    expect(report.skin).toMatchObject({ method: 'external skin package', chestRaise: false })
    expect(data.parts.some((p) => p.id === 'W_FJ2810')).toBe(false)
    const skin = byName('Skin')
    expect(skin).toMatchObject({ id: 'SOMA_skin', provenance: 'curated', tissue: 'skin', system: 'integumentary', depth: 0 })
    // 来源记录带许可证和署名，且只列一次 / the source record carries licence and attribution, and is listed once
    const src = data.sources.filter((x) => x.name === skin.source)
    expect(src.length).toBe(1)
    expect(src[0]!.license).toBe('Apache-2.0')
    expect(src[0]!.attribution).toMatch(/Meta Platforms/)
    // 单层封闭曲面，包得住深部结构 / a closed single wall that encloses the deep parts
    expect(sp.fit.closed).toBe(true)
    // 应当包住的部件没有一处露出 5 mm 以上；有意不包的部件取自皮肤包的 manifest，另行报告
    // nothing that must be enclosed lies more than 5 mm outside; the parts left out by design come from the package manifest and are reported apart
    expect(sp.fit.outside).toBeLessThan(0.002)
    for (const fit of [sp.fit, sp.fitShipped]) {
      expect(fit.outside5mm).toBe(0)
      for (const w of fit.worst) expect(w.maxMm, w.name).toBeLessThanOrEqual(5)
      expect(fit.notEnclosedByDesign.parts).toBeGreaterThan(0)
    }
    for (const id of sp.notEnclosedPartIds) expect(byId.has(id), id).toBe(true)
    const exemptNames = new Set(sp.notEnclosedPartIds.map((id: string) => byId.get(id)!.name))
    for (const w of sp.fit.worst) expect(exemptNames.has(w.name), `${w.name} is exempt but counted`).toBe(false)
    expect(sp.fitShipped.closed).toBe(true)
    expect(sp.fitShipped.outside).toBeLessThan(0.003)
    // 眼关节与眼球中心相差不过几毫米（右侧巩膜的源网格带一粒碎屑，按包围盒算会差出 24 mm）
    // the eye joints lie within a few millimetres of the centres of the globes (the source mesh of the right sclera carries a speck that would put a bounding-box centre 24 mm off)
    for (const side of ['L', 'R'] as const) expect(sp.face.eyeJoint[side].distanceMm).toBeLessThan(8)
    // 不在拟合之列的薄结构露出多少，如实报告并写进说明 / how far the thin structures outside the fit come through is reported and stated in the cautions
    expect(sp.notFitted.thin.outside).toBeGreaterThan(0)
    expect(sp.notFitted.thin.outside).toBeLessThan(0.05)
    expect(data.cautions!.map((c) => c.en).join(' ')).toContain('fitted to enclose muscles, bones, cartilages and organs only')
    expect(report.fat.skinSingleWalled).toBe(true)
    expect(report.fat.fatVolumeL / report.fat.bodyVolumeL).toBeGreaterThan(0.1)
    expect(report.fat.fatVolumeL / report.fat.bodyVolumeL).toBeLessThan(0.4)
    // 面部保持原始分辨率，其余照旧简化；仍是一个没有边界边的部件
    // the face keeps its source resolution and the rest is simplified as before; still one part with no boundary edge
    const res = sp.resolution
    expect(res.source.face.vertices).toBeGreaterThan(14_000)
    expect(res.shipped.face.vertices).toBe(res.source.face.vertices)
    expect(res.shipped.face.meanEdgeMm).toBeLessThanOrEqual(2)
    expect(res.simplifiedWhole.face.vertices).toBeLessThan(res.shipped.face.vertices / 5)
    // 状态 C 下标签非 0 的顶点（移植片等）也原样保留，先从“其余”里减去（有些带标签的顶点在面部区域内，被减了两次，所以这个上限比实际略松）
    // in state C the tagged vertices (grafts and so on) are kept as they are too and are taken off "the rest" first (some lie in the face region and are taken off twice, so the bound is slightly looser than the truth)
    const op = sp.opened as OpenedSkinReport | undefined
    const tagged = op ? Object.entries(op.byTag).filter(([k]) => k !== 'skin').reduce((a, [, c]) => a + c.shipped, 0) : 0
    expect(res.shipped.vertices - res.shipped.face.vertices - tagged).toBeLessThan(16_000)
    // B：发布的皮肤是闭合的。C：它有且只有两个边界环（两眼内卷的内缘），另报，不算“闭合”；fit、fitShipped 量的是闭合的那张
    // B: the shipped skin is closed. C: it has exactly two boundary loops (the inner edges of the two lid rims), reported apart from "closed"; fit and fitShipped are measured on the closed skins
    if (op) {
      expect(op.shipped.boundaryLoops).toBe(2)
      expect(res.shippedTopology.boundaryEdges).toBe(op.shipped.boundaryEdges)
      expect(op.closedCounterpart).toMatchObject({ boundaryEdges: 0, used: true })
    } else expect(res.shippedTopology.boundaryEdges).toBe(0)
    expect(skin.triangles).toBe(res.shipped.triangles)
    const body = await loadBuiltBody(DIR, (p) => p.id === skin.id || (p.tissue === 'muscle' && FACE_MUSCLE_NAME.test(p.name)))
    const mesh = body.meshes.get(skin.id)!
    if (op) expect(boundaryLoops(mesh)).toMatchObject({ loops: 2, edges: op.shipped.boundaryEdges })
    else expect(edgeTopology(mesh).boundaryEdges).toBe(0)
    const facial = [...body.parts.values()].filter((p) => p.id !== skin.id && body.meshes.has(p.id)).map((p) => body.meshes.get(p.id)!)
    const shipped = skinResolution(mesh, faceRegionOfSkin(mesh, facial))
    // 状态 C：报告里的面部不算构造物（内卷、口腔袋），而这里按位置重量的面部区域把它们也算了进去，
    // 所以顶点数最多多出这些构造物的个数，平均边长也因为口腔袋较粗而略大（上限放到 2.3 mm，只在状态 C；与男性的测试相同）
    // state C: the face of the report leaves out the construction aids (rims, pouch) while the region measured again
    // here by position includes them, so the count may exceed the report by up to their number and the mean edge is a
    // little longer because the pouch is coarser (bound 2.3 mm, in state C only; as in the male's test)
    const aids = op ? ['lidRimL', 'lidRimR', 'oralPouchUpper', 'oralPouchLower', 'oralPouchSeam'].reduce((a, k) => a + (op.byTag[k]?.shipped ?? 0), 0) : 0
    expect(shipped.face.vertices - res.shipped.face.vertices).toBeGreaterThan(-400)
    expect(shipped.face.vertices - res.shipped.face.vertices).toBeLessThan(aids + 400)
    expect(shipped.face.meanEdgeMm).toBeLessThanOrEqual(op ? 2.3 : 2)
    // 乳房：HRA 各部按皮肤包给的变换缩小并移位；腺体在皮肤之内，乳晕贴着皮肤，乳头尖略微露出
    // breasts: the HRA parts scaled and moved by the transform the package gives; gland inside the skin, areola on it, the tip of the nipple just through it
    for (const side of ['L', 'R'] as const) {
      const b = sp.breastPlacement.sides[side]
      expect(b.parts).toBe(8)
      expect(b.scale).toBeGreaterThan(0.3)
      expect(b.scale).toBeLessThan(0.7)
      expect(b.nippleAndAreola.parts).toEqual([`HRA_areola_${side}`, `HRA_areolar_tubercles_${side}`, `HRA_nipple_${side}`])
      expect(b.nippleAndAreola.ignoredIds).toEqual([])
      expect(b.againstSkin.mammaryLobes.outside).toBe(0)
      expect(b.againstSkin.mammaryLobes.maxMm).toBeLessThan(-2)
      expect(b.againstSkin.allPartsButNippleAndAreola.outside).toBeLessThan(0.005)
      // 乳晕贴着皮肤或略在其下：皮肤作者最后把皮肤抬到乳头上（breast-placement.txt 的 “skin raised onto the nipples”，3.6–4.9 mm），
      // 乳头尖因此只露出 0.2 mm，乳晕的中位数落在皮肤下约 2 mm。原先的上限是 |中位数| < 1.5 mm，是为抬高之前的皮肤定的。
      // the areola lies on the skin or just under it: the skin's author finally raised the skin onto the nipples ("skin raised onto
      // the nipples" in breast-placement.txt, 3.6–4.9 mm), so the tip of the nipple shows by 0.2 mm only and the median of the areola
      // lies about 2 mm under the skin. The earlier bound, |median| < 1.5 mm, was set for the skin before that raise.
      expect(b.againstSkin.areola.medianMm).toBeGreaterThan(-3)
      expect(b.againstSkin.areola.medianMm).toBeLessThan(1.5)
      expect(b.againstSkin.nippleTip.signedDistanceMm).toBeGreaterThan(0)
      expect(b.againstSkin.nippleTip.signedDistanceMm).toBeLessThan(6)
      // 乳头在腺体前方 / the nipple lies in front of the gland
      expect(byName(`${side === 'L' ? 'Left' : 'Right'} nipple`).centroid[2]).toBeGreaterThan(byName(`${side === 'L' ? 'Left' : 'Right'} mammary lobe`).centroid[2])
    }
    // 有意不包住的表情肌（皮肤包 manifest 的豁免名单上组织为肌的部件）：本次构建自己量的露出量，都在名单上，最多几毫米；
    // 不在名单上的部件露出 5 mm 以上，上面 fit.outside5mm / fit.worst 两项就不通过
    // the muscles deliberately not enclosed (the parts on the manifest's exemption list whose tissue is muscle): this build's own
    // measurement of how far they come through, all of them on the list and by a few millimetres at most; a part not on the list
    // lying more than 5 mm outside fails fit.outside5mm / fit.worst above
    const mm = sp.notEnclosedMusclesMeasured as { parts: number; outside: number; rows: { id: string; name: string; shareOutside: number; maxOutsideMm: number }[] } | undefined
    if (mm) {
      expect(mm.outside).toBe(mm.rows.length)
      expect(mm.parts).toBeGreaterThanOrEqual(mm.outside)
      for (const r of mm.rows) {
        expect(sp.notEnclosedPartIds, r.name).toContain(r.id)
        expect(byId.get(r.id)!.tissue, r.name).toBe('muscle')
        expect(r.maxOutsideMm, r.name).toBeGreaterThan(0)
        expect(r.maxOutsideMm, r.name).toBeLessThan(5)
      }
      // 名单上有睑部眼轮匝肌以外的表情肌露出时，说明里写明“只在骨上留覆盖” / when muscles other than the palpebral orbicularis oculi come through, the cautions say the skin kept cover over bone only
      if (mm.rows.some((r) => !/^palpebral part/i.test(r.name))) expect(data.cautions!.map((c) => c.en).join(' ')).toMatch(/only as far as her bones need cover.*lie partly outside the skin, by up to \d+(\.\d+)? mm in this build/)
    }
    // 皮肤上的乳房按什么数值塑形：皮肤包记了就写进说明 / what the breasts of the skin were shaped to: stated in the cautions when the package records it
    if (sp.breastShape) {
      expect(sp.breastShape.asBuiltByTheSkinAuthor.apexesApartMm).toBeGreaterThan(150)
      expect(sp.breastShape.asBuiltByTheSkinAuthor.apexesApartMm).toBeLessThan(250)
      expect(data.cautions!.map((c) => c.en).join(' ')).toContain('shaped to Chinese reference figures')
      expect(data.cautions!.map((c) => c.zh).join(' ')).toContain('按中国女性的参考数值塑形')
    }
    // 体表的各条说明：每条中文不超过 260 个字（与男性的测试相同的上限），中英文都有
    // the cautions about the body surface: each Chinese text under 260 characters (the bound of the male's test), both languages present
    if (report.skinCautions) {
      expect(report.skinCautions.count).toBeGreaterThanOrEqual(4)
      for (const c of data.cautions!.slice(report.skinCautions.from, report.skinCautions.from + report.skinCautions.count)) {
        expect(c.zh.length, c.zh.slice(0, 30)).toBeLessThan(260)
        expect(c.zh).toMatch(/[\u4e00-\u9fff]/)
        expect(c.en.length, c.en.slice(0, 30)).toBeGreaterThan(40)
      }
    }
    const en = data.cautions!.map((c) => c.en).join(' ')
    expect(en).not.toMatch(/PLACEHOLDER|raised into a smooth envelope/)
    expect(en).toMatch(/not a scan and not her own skin/)
    expect(en).toMatch(/scaled to 0\.\d\d (\(left\) and 0\.\d\d \(right\) of its size|of its size on both sides)/)
    expect(en).not.toMatch(/They sit too low|horizontal steps/)
  }, 60_000)

  // 早于 display.json 的构建（报告的 output 里没有 displayJsonBytes，目录里也没有这个文件）跳过；报告说写了而文件不在则不通过
  // a build older than display.json (no displayJsonBytes under `output` of its report and no such file) is skipped; a report that says it was written while the file is missing fails
  it.skipIf(!present || (report?.output?.displayJsonBytes === undefined && !existsSync(join(DIR, DISPLAY_FILE))))('writes display.json with exactly the fields the viewer reads, in every state', () => {
    const d = JSON.parse(readFileSync(join(DIR, DISPLAY_FILE), 'utf8'))
    expect(Object.keys(d).sort()).toEqual(['hideWithOpaqueSkin', 'notEnclosedPartIds', 'skin'])
    expect(Object.keys(d.skin).sort()).toEqual(['opened', 'part', 'pieces'])
    expect(d.skin.part).toBe(byName('Skin').id)
    expect(d.skin.opened).toBe(skinOpened)
    expect(d.skin.opened).toBe(existsSync(join(DIR, SKIN_SOURCE_FILE)))
    expect(d.skin.pieces).toBe(existsSync(join(DIR, SKIN_PIECES_FILE)))
    expect(d.hideWithOpaqueSkin).toEqual(report.appendages.hideWithOpaqueSkin ?? [])
    expect(d.notEnclosedPartIds).toEqual([...(report.skinPackage.notEnclosedPartIds ?? [])].sort())
    for (const id of [...d.hideWithOpaqueSkin, ...d.notEnclosedPartIds]) expect(byId.has(id), id).toBe(true)
    expect(report.output.displayJsonBytes).toBe(readFileSync(join(DIR, DISPLAY_FILE)).length)
    // A：没有装入皮肤包，两份名单都是空的，说明里写的是占位皮肤 / A: nothing installed, both lists are empty and the cautions speak of the placeholder
    if (!skinInstalled) {
      expect(d).toMatchObject({ hideWithOpaqueSkin: [], notEnclosedPartIds: [], skin: { opened: false, pieces: false } })
      expect(data.cautions!.map((c) => c.en).join(' ')).toContain('The body surface is a PLACEHOLDER')
    }
  })

  it.skipIf(!present || !skinInstalled || skinOpened)('ships no index sidecar and no composition with a closed skin package (state B)', () => {
    expect(existsSync(join(DIR, SKIN_SOURCE_FILE))).toBe(false)
    expect(existsSync(join(DIR, SKIN_PIECES_FILE))).toBe(false)
    expect((byName('Skin') as Part & { composition?: unknown }).composition).toBeUndefined()
    expect(report.skinPackage.dir).not.toMatch(/-open$/)
    const all = data.cautions!.map((c) => c.en).join(' ')
    expect(all).toContain('the eyes and mouth are not openings')
    expect(all).not.toContain('real openings')
  })

  it.skipIf(!present || !skinOpened)('ships the opened skin with an index sidecar that maps every vertex to the package by index (state C)', async () => {
    const sp = report.skinPackage
    const op = sp.opened as OpenedSkinReport
    const skin = byName('Skin')
    expect(sp.dir).toBe(op.dir)
    expect(sp.dir).toMatch(/-open$/)
    expect(sp.openedPackage).toMatchObject({ dir: op.dir, used: true })
    // 下标对照文件：小端 uint32，每个发布的皮肤顶点一个，按 GLB 解码次序
    // the sidecar: little-endian uint32, one per shipped skin vertex, in GLB decode order
    const bytes = readFileSync(join(DIR, SKIN_SOURCE_FILE))
    const doc = await readGlb(join(DIR, 'integumentary.glb'))
    const node = doc.getRoot().listNodes().find((n) => n.getName() === skin.id)!
    const prim = node.getMesh()!.listPrimitives()[0]!
    const pos = prim.getAttribute('POSITION')!
    const nv = pos.getCount()
    expect(bytes.length).toBe(4 * nv)
    expect(op.sidecar).toMatchObject({ file: SKIN_SOURCE_FILE, vertices: nv })
    expect(op.sidecar!.maxErrorMm).toBeLessThanOrEqual(0.5 * op.sidecar!.stepMm + 0.002)
    expect(report.output.skinSourceBytes).toBe(4 * nv)
    expect(op.shipped.vertices).toBe(nv)
    expect(prim.getIndices()!.getCount() / 3).toBe(op.shipped.triangles)
    const source = new Uint32Array(nv)
    for (let j = 0; j < nv; j++) source[j] = bytes.readUInt32LE(4 * j)
    // 每个包顶点至多发布一次 / no package vertex is shipped twice
    expect(new Set(source).size).toBe(nv)
    for (const v of source) expect(v).toBeLessThan(op.package.vertices)
    // 发布的顶点按标签的个数与报告一致；被切掉的顶点（removed）一个也不发布，其余标签非 0 的一个不少
    // shipped vertices by tag as reported; no removed vertex is shipped and every other tagged vertex is
    for (const [name, c] of Object.entries(op.byTag)) {
      if (name === 'removed') expect(c.shipped, name).toBe(0)
      else if (name !== 'skin') expect(c.shipped, name).toBe(c.inPackage)
    }
    expect(op.lockedVerticesMissing).toBe(0)
    expect(Object.values(op.byTag).reduce((a, c) => a + c.shipped, 0)).toBe(nv)
    for (const k of ['upperLip', 'lowerLip', 'mouthCorner', 'upperLidL', 'lowerLidL', 'upperLidR', 'lowerLidR', 'canthus', 'lidRimL', 'lidRimR', 'oralPouchUpper', 'oralPouchLower', 'oralPouchSeam']) expect(op.byTag[k]?.shipped ?? 0, k).toBeGreaterThan(0)
    // 两个边界环，与“闭合”分开报告 / two boundary loops, reported apart from "closed"
    expect(op.shipped.boundaryLoops).toBe(2)
    expect(op.package.boundaryLoops).toBe(2)
    expect(sp.fit.closed).toBe(true)
    expect(sp.fitShipped.closed).toBe(true)
    // 位置取 16 位：唇缘的顶点对发布为两个顶点，量化后仍然重合；口区没有不同的位置被量化到一起
    // 16-bit positions: the lip margin pairs ship as two vertices each and still coincide after quantisation; no distinct positions of the mouth sheets quantise together
    const q = op.quantisation!.chosen
    expect(q.bits).toBe(OPENED_SKIN_POSITION_BITS)
    expect(q.stepMm).toBeLessThan(0.03)
    expect(q.marginPairs).toBeGreaterThan(30)
    expect(q.marginPairsShippedApart).toBe(q.marginPairs)
    expect(q.marginPairsCoincidentAfter).toBe(q.marginPairs)
    expect(q.walls.mergedPositions).toBe(0)
    expect(q.walls.flipped).toBeLessThanOrEqual(op.quantisation!.at14Bits.walls.flipped)
    expect(q.walls.flippedGapInPackageMmMax).toBeLessThan(q.stepMm)
    expect(pos.getArray()!.constructor.name).toBe('Int16Array')
    // 包还在磁盘上时，逐顶点核对：GLB 里每个皮肤顶点与它所指的包顶点位置相同（半个量化步长之内）；
    // 唇缘的每一对在 GLB 里是两个不同的顶点、指向两个不同的包顶点
    // with the package still on disk, vertex by vertex: every skin vertex of the GLB sits where the package vertex it
    // names does (within half a quantisation step); each lip margin pair is two vertices of the GLB naming two package vertices
    const dir = join(import.meta.dirname, '..', op.dir)
    const pkg = existsSync(join(dir, 'manifest.json')) ? loadSkinPackage(dir) : null
    if (pkg?.opened && pkg.mesh.positions.length / 3 === op.package.vertices) {
      const m = node.getWorldMatrix()
      const el = [0, 0, 0]
      const shipped = new Float32Array(3 * nv)
      let max = 0
      for (let j = 0; j < nv; j++) {
        pos.getElement(j, el)
        for (let k = 0; k < 3; k++) {
          shipped[3 * j + k] = el[k]! * m[5 * k]! + m[12 + k]!
          max = Math.max(max, Math.abs(shipped[3 * j + k]! - pkg.mesh.positions[3 * source[j]! + k]!))
        }
      }
      expect(max).toBeLessThanOrEqual(0.5 * positionStep(shipped, OPENED_SKIN_POSITION_BITS) + 2e-6)
      const shippedOf = new Map<number, number>()
      source.forEach((v, j) => shippedOf.set(v, j))
      const margins = (pkg.manifest.face as { margins: { upperLip: number[]; lowerLip: number[] } }).margins
      for (let i = 1; i + 1 < margins.upperLip.length; i++) {
        const a = shippedOf.get(margins.upperLip[i]!), b = shippedOf.get(margins.lowerLip[i]!)
        expect(a, `upper margin ${i}`).toBeDefined()
        expect(b, `lower margin ${i}`).toBeDefined()
        expect(a).not.toBe(b)
        expect(source[a!]).not.toBe(source[b!])
        expect(pos.getElement(a!, [0, 0, 0])).toEqual(pos.getElement(b!, [0, 0, 0]))
      }
      for (let j = 0; j < nv; j++) if (pkg.opened.tags[source[j]!] === pkg.opened.tagNames.removed) throw new Error(`shipped vertex ${j} is a removed vertex`)
    }
    // 皮肤部件的记录如实说明它由什么构成；数据源带许可 / the skin part's record says what it is made of; the sources carry their licences
    const comp = (skin as Part & { composition?: { what: { zh: string; en: string }; provenance: string; source: string | null; vertices: number }[] }).composition!
    expect(comp.length).toBeGreaterThanOrEqual(3)
    expect(comp.reduce((a, c) => a + c.vertices, 0)).toBe(nv)
    expect(comp[0]).toMatchObject({ provenance: 'curated', source: skin.source })
    expect(comp.filter((c) => c.provenance === 'construction').length).toBeGreaterThanOrEqual(2)
    for (const c of comp) {
      expect(['scanned', 'curated', 'construction']).toContain(c.provenance)
      if (c.provenance === 'construction') expect(c.source).toBeNull()
      else expect(data.sources.find((x) => x.name === c.source)!.license.length, c.source!).toBeGreaterThan(2)
      expect(c.what.zh).toMatch(/[\u4e00-\u9fff]/)
    }
    for (const g of op.grafts) {
      expect(['scanned', 'curated']).toContain(g.provenance)
      expect(comp.some((c) => c.provenance === g.provenance && c.vertices === g.shipped.patch), g.name).toBe(true)
      expect(g.shipped.patch).toBe(g.inPackage.patch)
    }
    // skin-pieces.u8：每个发布顶点一个字节，各片的个数与 composition 一致 / skin-pieces.u8: one byte per shipped vertex, and its histogram is the composition
    const pieces = readFileSync(join(DIR, SKIN_PIECES_FILE))
    expect(pieces.length).toBe(nv)
    expect(report.output.skinPiecesBytes).toBe(nv)
    const hist = new Array<number>(comp.length).fill(0)
    for (const b of pieces) {
      expect(b).toBeLessThan(comp.length)
      hist[b]!++
    }
    expect(hist).toEqual(comp.map((c) => c.vertices))
    // 皮肤包的数据源只列一次，带着修改声明（Apache-2.0 第 4(b) 条） / the package's source is listed once and carries the statement of changes (section 4(b) of the Apache License 2.0)
    const src = data.sources.filter((x) => x.name === skin.source)
    expect(src.length).toBe(1)
    expect(src[0]!.license).toBe('Apache-2.0')
    expect(src[0]!.attribution).toMatch(/oral fissure cut/)
    // 说明：眼和口是开口，内卷和口腔袋是构造物；不再说“不是开口”，也不再有占位皮肤的话
    // cautions: eye and mouth are openings, rims and pouch are construction; "not openings" and the placeholder statements are gone
    const all = data.cautions!.map((c) => c.en).join(' ')
    expect(all).toContain('The eyes and the mouth of the skin are real openings')
    expect(all).toContain('construction aids')
    expect(all).not.toContain('are not openings')
    expect(all).not.toMatch(/PLACEHOLDER|placeholder|raised into a smooth envelope/)
    expect(data.cautions!.map((c) => c.zh).join(' ')).not.toMatch(/占位/)
    if (op.grafts.some((g) => /^toes/i.test(g.name))) {
      expect(all).not.toMatch(/toes (of the skin )?are one block/)
      expect(all).toContain('they are not hers')
      expect(all).not.toMatch(/\bhis (toe bones|phalanges)\b/)
      // 足趾移植片是带着毛病发布的：说明里写明哪几个趾、什么样，并给出本次构建量的对折小面数；第 3–5 趾被拉长的倍数也在
      // the toe grafts ship with their faults: the cautions say which toes and what it looks like, with this build's count of folded facets; the stretch of toes three to five is stated too
      expect(all).toContain('The grafted toes still show small faults: near the tips of the second to fifth toes a shallow ring step')
      expect(all).toMatch(/third to fifth toes are stretched \d\.\d\d–\d\.\d\d times/)
      const tg = sp.toeGraftSurface.grafts as Record<string, { triangles: number; over90: number; folded: number }>
      expect(Object.keys(tg).sort()).toEqual(['toesL', 'toesR'])
      for (const g of Object.values(tg)) {
        expect(g.triangles).toBeGreaterThan(5000)
        expect(g.over90).toBeGreaterThanOrEqual(g.folded)
      }
      expect(all).toContain(`${tg.toesL!.folded} edges of the left graft and ${tg.toesR!.folded} of the right are folded right over`)
    } else {
      // 没有足趾移植片：说明里写足趾连成一块，并说明分开的足趾为什么没有采用
      // no toe graft: the cautions say the toes are one block and why the separate toes are not used
      expect(all).toMatch(/toes (of the skin )?are one block/)
      expect(all).toContain('so that graft is not used')
      expect(comp.every((c) => !/toes/i.test(c.what.en))).toBe(true)
    }
    // 深层的唇是两个部件（男性的 Lip 切开后的上唇、下唇，形变而来；见 lipSplit.ts）：原 id 退役，两个都列在皮肤不透明时要隐藏的名单里，
    // 也都在皮肤有意不包住的名单和 display.json 里；各有自己的 FMA 概念，挂在 FMA59816 之下
    // the deep lip is two parts (upper and lower lip, the halves of the male Lip, warped; see lipSplit.ts): the original id is retired, both are
    // on the list to hide while the skin is opaque, on the list the skin deliberately does not enclose and in display.json; each has its own FMA concept under FMA59816
    expect(byId.has('W_FJ2814')).toBe(false)
    const up = byId.get('W_FJ2814_upper')!
    const lo = byId.get('W_FJ2814_lower')!
    expect([up.name, up.fma, lo.name, lo.fma]).toEqual(['Upper lip', 'FMA59817', 'Lower lip', 'FMA59818'])
    expect(data.parts.filter((p) => /^(upper |lower )?lip$/i.test(p.name) && p.system !== 'integumentary').map((p) => p.id).sort()).toEqual(['W_FJ2814_lower', 'W_FJ2814_upper'])
    expect(up.centroid[1]).toBeGreaterThan(lo.centroid[1])
    for (const p of [up, lo]) {
      expect(p.provenance).toBe('warped')
      expect(report.appendages.hideWithOpaqueSkin).toContain(p.id)
      expect(report.skinPackage.notEnclosedPartIds).toContain(p.id)
    }
    expect(report.appendages.deepLip.ids).toEqual(['W_FJ2814_upper', 'W_FJ2814_lower'])
    expect(report.appendages.deepLip.note).toContain('upper and lower lip')
    expect(report.skinPackage.notEnclosedPartIds).not.toContain('W_FJ2814')
    const isaById = new Map(data.trees.isa.map((c) => [c.id, c]))
    expect(isaById.get('FMA59817')).toMatchObject({ parent: 'FMA59816', parts: ['W_FJ2814_upper'] })
    expect(isaById.get('FMA59818')).toMatchObject({ parent: 'FMA59816', parts: ['W_FJ2814_lower'] })
    for (const t of [data.trees.isa, data.trees.partOf]) for (const c of t) expect(c.parts).not.toContain('W_FJ2814')
    const displayFile = join(DIR, 'display.json')
    if (existsSync(displayFile)) {
      const display = JSON.parse(readFileSync(displayFile, 'utf8')) as { hideWithOpaqueSkin: string[] }
      for (const id of ['W_FJ2814_upper', 'W_FJ2814_lower']) expect(display.hideWithOpaqueSkin).toContain(id)
      expect(display.hideWithOpaqueSkin).not.toContain('W_FJ2814')
    }
  }, 120_000)

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
    // 上肢外展过时，桡神经沟一项沿肱骨自身的轴取样（与构建时相同） / with the arms abducted the radial-groove check samples along the humerus' own axis (as the build does)
    const results = runLandmarkChecks({ mesh: (n) => meshes.get(n) ?? null, nerve: (n) => nerves.get(n) ?? null }, { shaftAligned: !!report.armAbduction?.applied })
    expect(results.length).toBe(18)
    // 已知的弱点：左侧第 5–9 肋的 CT 标签不可靠，肋间神经检查可能不过
    // known weakness: the CT labels of left ribs 5–9 are unreliable and the intercostal check may fail
    // 坐骨神经是男性结构，未按她真实的腘绳肌（Denver）重新贴合：它在股二头肌与半膜肌之间的位置检查处于临界
    // the sciatic nerve is a male structure not refitted to her real hamstrings (Denver): its position between biceps femoris and semimembranosus is borderline
    expect(results.filter((r) => !r.evaluated || !r.pass).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
  }, 120_000)

  it('brings her thin structures under her skin and records how', () => {
    const tp = report.thinParts
    if (!tp?.applied) return
    // 参考皮肤：相对目录、SHA-1；按本次的内部结构拟合（与装入皮肤同一个指纹） / the reference skin: a relative directory, a SHA-1; fitted to these internals (the fingerprint that decides installing)
    expect(tp.reference.sha1).toMatch(/^[0-9a-f]{40}$/)
    expect(tp.reference.dir.startsWith('/')).toBe(false)
    expect(tp.reference.fittedTo).toEqual({ body: 'female', key: report.skinPackage.internalsKey })
    expect(tp.internalsKey).toBe(report.skinPackage.internalsKey)
    expect(tp.marginMm).toBe(2.5)
    // 另一位女性的标本和美术模型不跟着皮肤走 / the other woman's specimen and the artist models do not follow the skin
    for (const row of tp.parts as { id: string; outsideCm2: { before: number; after: number }; moved: unknown; clipped?: unknown }[]) {
      expect(/^(WU_|HRA_)/.test(row.id), row.id).toBe(false)
      expect(byId.has(row.id), row.id).toBe(true)
      expect(row.moved !== null || row.clipped !== undefined, row.id).toBe(true)
    }
    expect(tp.outsideCm2.before).toBeGreaterThan(100)
    expect(tp.outsideCm2.after).toBeLessThan(0.1 * tp.outsideCm2.before)
    // 指、趾的血管和神经：收到皮下之后落在骨内的比例比之前最多高 1 个百分点（位移在会进骨的地方被收回）
    // vessels and nerves of the digits: after being taken under the skin, at most one percentage point more of their surface lies inside bone than before (the move is held back where it would enter bone)
    expect(tp.insideBone.partsMeasured).toBeGreaterThan(20)
    // 量得 4.43 % → 4.98 %（不收回位移时是 6.92 %）：顶点都退到了骨外，顶点之间的面仍略有增加
    // measured 4.43 % → 4.98 % (6.92 % without holding back): every vertex is kept out of bone, the surface between vertices still gains a little
    expect(tp.insideBone.shareAfter).toBeLessThanOrEqual(tp.insideBone.shareBefore + 0.01)
    const all = data.cautions!.map((c) => c.en).join(' ')
    expect(all).toContain('Measured by area')
    expect(all).not.toContain('were not considered')
    expect(all).not.toMatch(/sheets of fascia show between the toes/)
  })

  it('ends the thoraco-abdominal nerves at her xiphoid process and her navel', () => {
    const ic = report.intercostalNerves
    if (!ic?.applied) return
    const L = ic.landmarks as { xiphoidTipY: number; navelY: number; pubicTubercleY: number }
    // 出处是打开核对过的；脐取自皮肤包的 manifest / the sources were opened; the navel is the one of the skin package's manifest
    expect(ic.sources.length).toBeGreaterThanOrEqual(2)
    for (const s of ic.sources as { url: string; name: string }[]) {
      expect(s.url).toMatch(/^https:\/\//)
      expect(s.name).toContain('opened')
    }
    expect(ic.landmarks.navelFrom).toContain('manifest.json')
    expect(L.navelY).toBeLessThan(L.xiphoidTipY - 0.12)
    expect(L.navelY).toBeGreaterThan(L.pubicTubercleY + 0.1)
    const nerves = JSON.parse(readFileSync(join(DIR, 'nerves.json'), 'utf8')) as NervePath[]
    for (const side of ['L', 'R']) {
      const rows = (ic.rows as { id: string; side: string; nerve: number; endYMm: { before: number; target: number; after: number }; inBoneAfter?: number }[]).filter((r) => r.side === side).sort((a, b) => a.nerve - b.nerve)
      expect(rows.map((r) => r.nerve)).toEqual([7, 8, 9, 10, 11])
      for (const r of rows) {
        expect(Math.abs(r.endYMm.after - r.endYMm.target), r.id).toBeLessThan(1.5)
        expect(r.inBoneAfter ?? 0, r.id).toBe(0)
        // 报告里的前端就是 nerves.json 里的前端 / the end in the report is the end in nerves.json
        const b = nerves.find((n) => n.part === r.id)!.branches[0]!
        expect(Math.abs(b.points[b.points.length - 2]! * 1000 - r.endYMm.after), r.id).toBeLessThan(0.1)
      }
      // 第 7 肋间神经止于剑突尖下方 5–15 mm，第 10 止于脐（3 mm 以内），自上而下依次排列
      // the 7th ends 5–15 mm below the tip of the xiphoid process, the 10th at the navel (within 3 mm), in order from above down
      expect(L.xiphoidTipY * 1000 - rows[0]!.endYMm.after).toBeGreaterThan(5)
      expect(L.xiphoidTipY * 1000 - rows[0]!.endYMm.after).toBeLessThan(15)
      expect(Math.abs(rows[3]!.endYMm.after - L.navelY * 1000)).toBeLessThan(3)
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.endYMm.after, rows[i]!.id).toBeLessThan(rows[i - 1]!.endYMm.after - 30)
      expect(rows[4]!.endYMm.after).toBeGreaterThan(L.pubicTubercleY * 1000 + 50)
    }
    expect(data.cautions!.map((c) => c.en).join(' ')).toContain('the 10th at the navel of her skin')
  })

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
    expect(under).toContain('WU_ovary_L')
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

  it('says honestly whose pelvic organs these are', () => {
    const z = report.sexChecks.uterusBetweenBladderAndRectum.zMm
    expect(z.bladder).toBeGreaterThan(z.uterus)
    expect(z.uterus).toBeGreaterThan(z.rectum)
    const en = data.cautions!.map((c) => c.en).join(' ')
    const zh = data.cautions!.map((c) => c.zh).join(' ')
    expect(en).toMatch(/of ANOTHER woman/)
    expect(en).toMatch(/enlarged 1\.096 times/)
    expect(en).toMatch(/is a join, not anatomy/)
    expect(en).toMatch(/Absent from the pelvis/)
    expect(zh).toMatch(/来自另一位女性/)
    expect(zh).toMatch(/放大 1\.096 倍/)
    expect(zh).toMatch(/盆腔中缺失的结构/)
    const wu = data.sources.find((x) => x.name === 'Wu et al. 2015 pelvic floor')!
    expect(wu.license).toBe('CC BY 4.0')
    expect(wu.url).toContain('10.1371/journal.pone.0140736')
    expect(wu.attribution).toContain('10.1371/journal.pone.0132226')
  })
})
