// 体型控制的构建：bun tools/rig/shape-build.ts [male|female] [--no-renders]
// Build of the body-shape controls: bun tools/rig/shape-build.ts [male|female] [--no-renders]
//
// 读入 / reads
//   public/anatomy/<body>/                  当前的人体与 rig.json、rig.bin / the body as built, with rig.json and rig.bin
//   data/curated/bodyshape/rig-shape.json   体型模型（控制量、各肢段与围度的指数）/ the shape model (controls, exponents of segments and girths)
//   data/raw/bodyshape/out/<body>-skin/     skin.obj、shape-fat.f32、shape-limit.f32 / the source surface and its shape fields
//   data/curated/rig/shape.json             因子如何落到关节上 / how the factors land on the joints
// 写出 / writes
//   public/anatomy/<body>/shape.json、shape.bin   运行时数据（契约见 src/shape/types.ts）/ runtime data (contract in src/shape/types.ts)
//   public/anatomy/<body>/shape.report.json       输入哈希、增益标定、各控制量极值处的测量 / input hashes, gain calibration, measurements at the control extremes
//   tools/rig/out/<body>/shape-*.png              各控制量极值的离线渲染 / offline renders of every control at its extremes

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Part, Rig, TissueId } from '../../src/anatomy/types.ts'
import type { ShapeControl, ShapeControls, ShapeData, ShapeFactor, ShapeFollower, ShapeJointScale } from '../../src/shape/types.ts'
import { Surface, mergeMeshes } from './geom.ts'
import { type Body, hashInput, inputFile, readBody } from './io.ts'
import { type V3, xfApply } from './math.ts'
import { type Scales, Poser, jointFrames } from './pose.ts'
import { type RenderItem, type Rgb, render, sheet } from './render.ts'
import { Shaper, bmiUnits, factorValues } from './shape.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const sha = (path: string): string => createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex').slice(0, 16)

interface RigShapeSex {
  controls: { id: ShapeControl['id']; name: { zh: string; en: string }; unit: string; min: number; max: number; rest: number }[]
  segments: { id: string; name: { zh: string; en: string }; kind: 'length' | 'breadth'; bStature: number; legLength: number; centralBuild: number }[]
  girths: { id: string; name: { zh: string; en: string }; bStature: number; legLength: number; centralBuild: number }[]
  fields: { bmiToFieldUnits: [number, number][]; fittedAtBmi: number }
  presets: { id: string; values: Record<string, number> }[]
}

interface Curated {
  assign: { match: string; along?: string; across?: string }[]
  calibrate: { factor: string; from: string; to: string; axis: 'along' | 'across'; joints: string }[]
  follow: { appendages: string; fatTissues: string[]; superficialTissues: string[]; superficialDepthM: number }
  extremes: { statureDelta: Record<string, number | object>; bmi: number[]; legLength: number[]; centralBuild: number[] }
  validity: { maxOver2mmPctAboveDefault: number }
}

export interface ShapeMeasure {
  label: string
  controls: ShapeControls
  /** 皮肤的高度（最高点 − 最低点，米）。 Height of the skin (top minus bottom, metres). */
  skinHeightM: number
  /** 深部结构（骨、肌、腱、韧带、软骨、血管、神经）采样点：在皮肤外的比例、外出超过 2 mm 的比例、最远（mm）及其部件。 Sampled deep-part vertices (bone, muscle, tendon, ligament, cartilage, vessels, nerves): share outside the skin, share more than 2 mm outside, the farthest (mm) and its part. */
  deep: { sampled: number; outsidePct: number; over2mmPct: number; worstMm: number; worstPart: string; depthP5Mm: number; depthP50Mm: number }
  /** 皮下脂肪部件的同样统计。 The same for the subcutaneous fat parts. */
  fat: { sampled: number; outsidePct: number; over2mmPct: number; worstMm: number }
}

const DEEP: TissueId[] = ['bone', 'muscle', 'tendon', 'ligament', 'cartilage', 'artery', 'vein', 'nerve']
const COLORS: Partial<Record<TissueId, Rgb>> = { bone: [228, 218, 192], cartilage: [160, 205, 230], muscle: [178, 62, 58], tendon: [226, 222, 204], skin: [228, 180, 150], fat: [236, 214, 130] }

export async function buildShape(bodyId: 'male' | 'female', renders: boolean, log: (m: string) => void): Promise<void> {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const body: Body = await readBody(dir)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const rigBin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  const cur = JSON.parse(readFileSync(join(ROOT, 'data/curated/rig/shape.json'), 'utf8')) as Curated
  const model = (JSON.parse(readFileSync(join(ROOT, 'data/curated/bodyshape/rig-shape.json'), 'utf8')) as { sexes: Record<string, RigShapeSex> }).sexes[bodyId === 'male' ? 'M' : 'F']!
  // 有下标对照、且有开口后的皮肤包时，体型场按下标从开口后的包里取（不找最近点：上下唇缘的顶点位置重合）
  // with the index sidecar and an opened package, the shape fields are taken from it by index (no closest point: the upper and lower lip margins coincide in position)
  const byIndex = !!body.skinSource && existsSync(join(ROOT, `data/raw/bodyshape/out/${bodyId}-skin-open`, 'shape-fat.f32'))
  const pkgRel = `data/raw/bodyshape/out/${bodyId}-skin${byIndex ? '-open' : ''}`
  const pkg = join(ROOT, pkgRel)
  const inputs: Record<string, string> = { 'rig.json': sha(join(dir, 'rig.json')), 'rig.bin': sha(join(dir, 'rig.bin')), ...body.inputs }
  for (const f of ['data/curated/rig/shape.json#data', 'data/curated/bodyshape/rig-shape.json#data', `${pkgRel}/skin.obj`, `${pkgRel}/shape-fat.f32`, `${pkgRel}/shape-limit.f32`, `${pkgRel}/manifest.json#package`]) inputs[f] = hashInput(f, join(ROOT, inputFile(f)))
  const notes: string[] = []
  const jointById = new Map(rig.joints.map((j, i) => [j.id, i]))
  const skinPart = body.data.parts.filter((p) => p.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]!
  const skinMesh = body.meshes.get(skinPart.id)!

  // ── 控制量 / controls ────────────────────────────────────────────────────────────────────
  // 默认值 = 这副身体原样：身高和比例取 rig-shape.json 的 asBuilt 预设；BMI 取胖瘦场倍数为 0 的那个值
  // default = the body as built: stature and proportions from the asBuilt preset of rig-shape.json; BMI is the value at which the fat-field multiplier is 0
  const asBuilt = model.presets.find((p) => p.id === 'asBuilt')?.values ?? {}
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8')) as { statureM?: number; source?: { name?: string } }
  // 体型场属于皮肤包里的那张皮肤：发布的皮肤不是它（Part.source 对不上）时，不能把场套上去
  // the shape fields belong to the skin of the package: when the shipped skin is not that skin (its Part.source differs) they must not be applied
  if ((skinPart.source ?? '') !== (manifest.source?.name ?? '')) {
    throw new Error(`shape: the skin of ${bodyId} (${skinPart.id}, source "${skinPart.source ?? 'none'}") is not the skin of ${pkgRel} ("${manifest.source?.name}"); shape data are not written for it`)
  }
  const table = model.fields.bmiToFieldUnits
  let bmi0 = model.fields.fittedAtBmi
  for (let i = 1; i < table.length; i++) {
    const [b0, m0] = table[i - 1]!, [b1, m1] = table[i]!
    if (m0 <= 0 && m1 >= 0 && m1 !== m0) bmi0 = b0 - (m0 * (b1 - b0)) / (m1 - m0)
  }
  bmi0 = Math.round(bmi0 * 100) / 100
  if (Math.abs(bmi0 - model.fields.fittedAtBmi) > 0.3) notes.push(`the BMI table of rig-shape.json crosses zero at ${bmi0}, but fields.fittedAtBmi is ${model.fields.fittedAtBmi}; the default BMI is the zero of the table, so that the default leaves the body unchanged`)
  const controls: ShapeControl[] = model.controls.map((c) => {
    // 身高取皮肤包记录的实测身高（manifest.statureM），没有时取 asBuilt 预设
    // stature is the measured stature recorded in the skin package (manifest.statureM), else the asBuilt preset
    const def = c.id === 'bmi' ? bmi0 : c.id === 'stature' && typeof manifest.statureM === 'number' ? Math.round(manifest.statureM * 1e4) / 1e4 : (asBuilt[c.id] ?? c.rest)
    return { id: c.id, name: c.name, unit: c.unit, min: c.min, max: c.max, default: def, valid: { min: c.min, max: c.max, why: { zh: '模型给出的范围。', en: 'The range given by the model.' } } }
  })

  // ── 因子 / factors ───────────────────────────────────────────────────────────────────────
  const segIds = new Set(model.segments.map((s) => s.id))
  const factors: ShapeFactor[] = [
    ...model.segments.map((s): ShapeFactor => ({ id: s.id, name: s.name, kind: s.kind, exponents: { stature: s.bStature, legLength: s.legLength, centralBuild: s.centralBuild } })),
    ...model.girths.map((g): ShapeFactor => ({ id: segIds.has(g.id) ? `${g.id}.girth` : g.id, name: g.name, kind: 'girth', exponents: { stature: g.bStature, legLength: g.legLength, centralBuild: g.centralBuild } })),
  ]
  const factorIds = new Set(factors.map((f) => f.id))

  // ── 关节缩放与增益标定 / joint scales and gain calibration ─────────────────────────────────
  const joints: ShapeJointScale[] = rig.joints.map((j) => ({ joint: j.id, along: [], across: [] }))
  for (const a of cur.assign) {
    const re = new RegExp(a.match)
    for (const [axis, f] of [['along', a.along], ['across', a.across]] as const) {
      if (!f) continue
      if (!factorIds.has(f)) throw new Error(`shape: data/curated/rig/shape.json names factor "${f}", which rig-shape.json does not define`)
      for (const j of joints) if (re.test(j.joint)) j[axis].push({ factor: f, gain: 1 })
    }
  }
  const centreAt = (scales: Scales, id: string): V3 => {
    const i = jointById.get(id)
    if (i === undefined) throw new Error(`shape: no joint ${id}`)
    return xfApply(jointFrames(rig.joints, {}, scales).xfs[i]!, rig.joints[i]!.center as V3)
  }
  const distance = (scales: Scales, a: string, b: string): number => {
    const p = centreAt(scales, a), q = centreAt(scales, b)
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  }
  const calibration: { factor: string; from: string; to: string; restMm: number; gain: number; checkErrorPct: number }[] = []
  for (const c of cur.calibrate) {
    const re = new RegExp(c.joints)
    const carriers = joints.filter((j) => re.test(j.joint) && j[c.axis].some((t) => t.factor === c.factor))
    if (!carriers.length) continue
    const L0 = distance({}, c.from, c.to)
    const probe = (s: number): number => distance(Object.fromEntries(carriers.map((j) => [j.joint, { [c.axis]: s }])), c.from, c.to)
    // 距离对承担缩放的关节的缩放量是线性的：dL = k·(s − 1)，要 L = f·L0，故增益 = L0 / k
    // the distance is linear in the scale of the carrying joints: dL = k·(s − 1); L = f·L0 needs gain = L0 / k
    const k = (probe(1.1) - L0) / 0.1
    const gain = k > 1e-6 ? Math.round((L0 / k) * 1e4) / 1e4 : 1
    for (const j of carriers) for (const t of j[c.axis]) if (t.factor === c.factor) t.gain = gain
    const check = probe(1 + gain * 0.05) / L0 / 1.05 - 1
    calibration.push({ factor: c.factor, from: c.from, to: c.to, restMm: Math.round(L0 * 1e4) / 10, gain, checkErrorPct: Math.round(check * 1e4) / 100 })
  }

  // ── 皮肤位移场：按原始表面上的最近点传到发布的皮肤顶点 / skin fields: to the shipped skin vertices by closest point on the source surface
  const pos: number[] = [], idx: number[] = []
  for (const line of readFileSync(join(pkg, 'skin.obj'), 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const t = line.split(/\s+/)
      pos.push(Number(t[1]), Number(t[2]), Number(t[3]))
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1)
      for (let k = 1; k + 1 < t.length; k++) idx.push(t[0]!, t[k]!, t[k + 1]!)
    }
  }
  const srcN = pos.length / 3
  const fatBuf = readFileSync(join(pkg, 'shape-fat.f32')), limBuf = readFileSync(join(pkg, 'shape-limit.f32'))
  if (fatBuf.byteLength !== srcN * 12 || limBuf.byteLength !== srcN * 4) throw new Error(`shape: ${pkgRel}: shape-fat.f32 / shape-limit.f32 do not match the ${srcN} vertices of skin.obj`)
  const srcFat = new Float32Array(fatBuf.buffer.slice(fatBuf.byteOffset, fatBuf.byteOffset + fatBuf.byteLength))
  const srcLim = new Float32Array(limBuf.buffer.slice(limBuf.byteOffset, limBuf.byteOffset + limBuf.byteLength))
  const source = byIndex ? null : new Surface({ positions: Float32Array.from(pos), indices: Uint32Array.from(idx) })
  const nSkin = skinMesh.positions.length / 3
  const fat = new Float32Array(nSkin * 3), limit = new Float32Array(nSkin)
  let far = 0
  if (byIndex && body.skinSource!.length !== nSkin) throw new Error(`shape: skin-source.u32 has ${body.skinSource!.length} entries but the skin has ${nSkin} vertices`)
  for (let i = 0; i < nSkin; i++) {
    if (byIndex) {
      const v = body.skinSource![i]!
      if (v >= srcN) throw new Error(`shape: skin-source.u32 refers to vertex ${v}, but ${pkgRel} has ${srcN}`)
      fat[i * 3] = srcFat[v * 3]!
      fat[i * 3 + 1] = srcFat[v * 3 + 1]!
      fat[i * 3 + 2] = srcFat[v * 3 + 2]!
      limit[i] = srcLim[v]!
      continue
    }
    const c = source!.closestFace([skinMesh.positions[i * 3]!, skinMesh.positions[i * 3 + 1]!, skinMesh.positions[i * 3 + 2]!])!
    far = Math.max(far, c.distance)
    let lim = 0
    for (let k = 0; k < 3; k++) {
      const v = c.verts[k]!, w = c.bary[k]!
      fat[i * 3] = fat[i * 3]! + w * srcFat[v * 3]!
      fat[i * 3 + 1] = fat[i * 3 + 1]! + w * srcFat[v * 3 + 1]!
      fat[i * 3 + 2] = fat[i * 3 + 2]! + w * srcFat[v * 3 + 2]!
      lim += w * srcLim[v]!
    }
    limit[i] = lim
  }
  log(byIndex ? `skin fields taken by index for ${nSkin} shipped vertices from ${pkgRel}` : `skin fields transferred to ${nSkin} shipped vertices (farthest ${(far * 1000).toFixed(2)} mm from the source surface)`)

  // ── 跟随皮肤的部件 / parts that follow the skin ─────────────────────────────────────────────
  const skinSurf = new Surface(skinMesh)
  const envelope = new Surface(mergeMeshes(body.data.parts.filter((p) => (p.tissue === 'muscle' || p.tissue === 'bone' || p.tissue === 'tendon' || p.tissue === 'cartilage') && body.meshes.has(p.id)).map((p) => body.meshes.get(p.id)!)))
  const appendage = new RegExp(cur.follow.appendages, 'i')
  const followData: { part: string; skinIndex: Uint32Array; follow: Uint8Array }[] = []
  const D = cur.follow.superficialDepthM
  for (const p of body.data.parts) {
    if (p.id === skinPart.id || !body.meshes.has(p.id)) continue
    const isApp = appendage.test(p.name), isFat = cur.follow.fatTissues.includes(p.tissue), isSup = cur.follow.superficialTissues.includes(p.tissue)
    if (!isApp && !isFat && !isSup) continue
    const m = body.meshes.get(p.id)!
    const n = m.positions.length / 3
    // 整个部件离皮肤都远：跳过 / the whole part is far from the skin: skip
    if (!isApp && !isFat && skinSurf.boxDistance((p.bbox[0] + p.bbox[3]) / 2, (p.bbox[1] + p.bbox[4]) / 2, (p.bbox[2] + p.bbox[5]) / 2) > 0.6) continue
    const si = new Uint32Array(n), fo = new Uint8Array(n)
    let any = false
    for (let i = 0; i < n; i++) {
      const q: V3 = [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]
      if (!isApp && !isFat && skinSurf.distance(q[0], q[1], q[2], D) > D) continue
      const c = skinSurf.closestFace(q)
      if (!c) continue
      let f = 0
      if (isApp) f = 1
      else if (isFat) {
        // 脂肪：离皮肤越近跟得越多，贴着肌肉、骨的一面不动：follow = dDeep / (dDeep + dSkin)
        // fat: the nearer the skin the more it follows, the face lying on muscle and bone stays: follow = dDeep / (dDeep + dSkin)
        const dd = envelope.distance(q[0], q[1], q[2], 0.06)
        const deep = Number.isFinite(dd) ? dd : 0.06
        f = deep + c.distance > 1e-6 ? deep / (deep + c.distance) : 1
      } else f = Math.max(0, 1 - c.distance / D)
      if (f <= 0) continue
      const k = c.bary[0] >= c.bary[1] && c.bary[0] >= c.bary[2] ? 0 : c.bary[1] >= c.bary[2] ? 1 : 2
      si[i] = c.verts[k]!
      fo[i] = Math.round(f * 255)
      if (fo[i]! > 0) any = true
    }
    if (any) followData.push({ part: p.id, skinIndex: si, follow: fo })
  }
  log(`followers: ${followData.length} parts`)

  // ── 写 shape.bin / write shape.bin ───────────────────────────────────────────────────────
  const chunks: Uint8Array[] = []
  let off = 0
  const put = (a: Uint8Array): number => {
    const at = off
    chunks.push(a)
    off += a.byteLength
    const pad = (4 - (off % 4)) % 4
    if (pad) chunks.push(new Uint8Array(pad)), (off += pad)
    return at
  }
  const fatOffset = put(new Uint8Array(fat.buffer)), limitOffset = put(new Uint8Array(limit.buffer))
  const followers: ShapeFollower[] = followData.map((f) => ({ part: f.part, vertexCount: f.follow.length, skinIndexOffset: put(new Uint8Array(f.skinIndex.buffer)), followOffset: put(f.follow) }))
  const bin = new Uint8Array(off)
  let o = 0
  for (const c of chunks) bin.set(c, o), (o += c.byteLength)

  const shape: ShapeData = {
    schema: 1,
    body: bodyId,
    controls,
    factors,
    joints: joints.filter((j) => j.along.length || j.across.length),
    skin: { part: skinPart.id, vertexCount: nSkin, fatOffset, limitOffset, bmiToUnits: table.map(([b, m]) => [b, Math.round((m - bmiUnitsOf(table, bmi0)) * 1e4) / 1e4] as [number, number]) },
    followers,
    rules: [
      { zh: '骨、肌肉、内脏、深部血管神经：只随所绑定关节的节段缩放（身高、腿长比例、体型分布），不随 BMI 改变。', en: 'Bones, muscles, viscera, deep vessels and nerves: follow the segment scales of the joints they are bound to (stature, relative leg length, mass distribution) and do not change with BMI.' },
      { zh: '皮肤：先按 BMI 加上胖瘦位移（m(bmi)·fat，逐顶点限幅），再随关节缩放和姿势。', en: 'Skin: first the fatness displacement for the BMI (m(bmi)·fat, capped per vertex), then the joint scales and the pose.' },
      { zh: '皮下脂肪：每个顶点跟随最近皮肤顶点位移的一部分，份额 = 到深层（肌、骨）的距离 /（到深层的距离 + 到皮肤的距离）：贴皮肤的一面全跟，贴肌肉的一面不动。', en: 'Subcutaneous fat: every vertex follows a share of the displacement of its nearest skin vertex, share = distance to the deep layer (muscle, bone) / (that distance + distance to the skin): the face under the skin follows fully, the face on the muscle stays.' },
      { zh: `浅层血管、神经、筋膜：距皮肤 ${D * 1000} mm 以内的顶点按 1 − 深度/${D * 1000} mm 的份额跟随皮肤；毛发、眉、耳廓、指甲完全跟随皮肤。`, en: `Superficial vessels, nerves and fasciae: vertices within ${D * 1000} mm of the skin follow it by a share of 1 − depth/${D * 1000} mm; hair, eyebrows, external ears and nails follow the skin fully.` },
    ],
    cautions: [],
    sources: [
      { name: 'soma body-shape model (tools/bodyshape; ANSUR II and NHANES regressions, see its REPORT)', url: '', license: 'see tools/bodyshape/REPORT.md' },
      { name: 'Momentum Human Rig (MHR) v1.0.1 — identity shape components behind the fatness field', url: 'https://github.com/facebookresearch/MHR', license: 'Apache-2.0' },
    ],
  }

  // ── 验证：各控制量极值处的测量 / validation: measurements at the control extremes ───────────
  const parts = body.data.parts.filter((p) => body.meshes.has(p.id))
  const evaluate = (c: ShapeControls): ((p: Part) => Float32Array) => {
    const shaper = new Shaper(shape, bin, c, false)
    const poser = new Poser(rig, rigBin, {}, shaper.scales)
    const cache = new Map<string, Float32Array>()
    return (p) => {
      let v = cache.get(p.id)
      if (!v) cache.set(p.id, (v = poser.part(p.id, shaper.shapedRest(p.id, body.meshes.get(p.id)!.positions), 'dqs', false)))
      return v
    }
  }
  const measure = (label: string, c: ShapeControls): ShapeMeasure => {
    const at = evaluate(c)
    const sp = at(skinPart)
    const s = new Surface({ positions: sp, indices: skinMesh.indices })
    let lo = Infinity, hi = -Infinity
    for (let i = 1; i < sp.length; i += 3) (lo = Math.min(lo, sp[i]!)), (hi = Math.max(hi, sp[i]!))
    const stat = (tissues: string[], keepDepth: boolean) => {
      let n = 0, out = 0, over = 0, worst = 0, worstPart = ''
      const depth: number[] = []
      for (const p of parts) {
        if (!tissues.includes(p.tissue)) continue
        const v = at(p)
        for (let i = (p.id.charCodeAt(p.id.length - 1) & 7) * 3; i < v.length; i += 24) {
          n++
          const inside = s.contains(v[i]!, v[i + 1]!, v[i + 2]!)
          const d = s.distance(v[i]!, v[i + 1]!, v[i + 2]!, 0.2)
          if (keepDepth) depth.push(inside ? d : -d)
          if (inside) continue
          out++
          if (d > 0.002) over++
          if (Number.isFinite(d) && d > worst) (worst = d), (worstPart = p.name)
        }
      }
      depth.sort((a, b) => a - b)
      const q = (f: number): number => (depth.length ? Math.round(depth[Math.floor(f * (depth.length - 1))]! * 1e4) / 10 : 0)
      const pc = (a: number): number => (n ? Math.round((1000 * a) / n) / 10 : 0)
      return { sampled: n, outsidePct: pc(out), over2mmPct: pc(over), worstMm: Math.round(worst * 1e4) / 10, worstPart, depthP5Mm: q(0.05), depthP50Mm: q(0.5) }
    }
    const deep = stat(DEEP, true), f = stat(['fat'], false)
    return { label, controls: c, skinHeightM: Math.round((hi - lo) * 1e4) / 1e4, deep, fat: { sampled: f.sampled, outsidePct: f.outsidePct, over2mmPct: f.over2mmPct, worstMm: f.worstMm } }
  }
  const def = Object.fromEntries(controls.map((c) => [c.id, c.default])) as Record<ShapeControl['id'], number>
  const dS = Number(cur.extremes.statureDelta[bodyId])
  const settings: [string, ShapeControls][] = [
    ['default', {}],
    ['stature −2 SD', { stature: def.stature - dS }], ['stature +2 SD', { stature: def.stature + dS }],
    ...cur.extremes.bmi.map((b): [string, ShapeControls] => [`BMI ${b}`, { bmi: b }]),
    ...cur.extremes.legLength.map((v): [string, ShapeControls] => [`leg length ${v}`, { legLength: v }]),
    ...cur.extremes.centralBuild.map((v): [string, ShapeControls] => [`central build ${v}`, { centralBuild: v }]),
  ]
  const measures = settings.map(([l, c]) => {
    const m = measure(l, c)
    log(`${l}: height ${m.skinHeightM} m; deep outside ${m.deep.outsidePct} % (> 2 mm ${m.deep.over2mmPct} %, worst ${m.deep.worstMm} mm ${m.deep.worstPart}); fat outside ${m.fat.outsidePct} %`)
    return m
  })
  // BMI 的可用下限：深部结构穿出皮肤超过 2 mm 的比例不比默认多出规定的量
  // lower valid bound of BMI: the share of deep parts more than 2 mm outside the skin may not exceed the default by more than the stated amount
  const base = measures[0]!.deep.over2mmPct
  const tol = cur.validity.maxOver2mmPctAboveDefault
  const bmiC = controls.find((c) => c.id === 'bmi')!
  const scan: { bmi: number; over2mmPct: number; worstMm: number }[] = []
  let validMin = bmiC.default
  for (let b = Math.floor(bmiC.default * 2) / 2; b >= bmiC.min - 1e-9; b -= 0.5) {
    const m = measure(`scan ${b}`, { bmi: b })
    scan.push({ bmi: b, over2mmPct: m.deep.over2mmPct, worstMm: m.deep.worstMm })
    if (m.deep.over2mmPct > base + tol) break
    validMin = b
  }
  const tableMin = table[0]![0], tableMax = table[table.length - 1]![0]
  bmiC.valid = {
    min: Math.max(validMin, tableMin),
    max: Math.min(bmiC.max, tableMax),
    why: {
      zh: `下限：BMI 再低，皮肤就会收到肌肉和骨以内——肌肉不随 BMI 变细，深部结构穿出皮肤超过 2 mm 的采样点比例会比默认（${base}%）多出 ${tol} 个百分点以上；也不低于胖瘦场表格的最小值 ${tableMin}。上限：胖瘦场表格的最大值 ${tableMax}。`,
      en: `Lower bound: below it the skin would shrink inside muscle and bone — muscles do not thin with BMI, and the share of sampled deep-part vertices more than 2 mm outside the skin would exceed the default (${base} %) by more than ${tol} percentage points; nor below ${tableMin}, the lowest BMI of the fat-field table. Upper bound: ${tableMax}, the highest BMI of the table.`,
    },
  }
  for (const c of controls) {
    if (c.id === 'bmi') continue
    c.valid.why = { zh: '模型给出的范围；在所测的极值处深部结构穿出皮肤的比例与默认相同（缩放对皮肤和深部结构一视同仁）。', en: 'The range given by the model; at the extremes measured, deep parts come through the skin no more than at the default (the scales treat skin and deep parts alike).' }
  }
  shape.cautions = [
    { zh: '体型的四个控制量来自人体测量回归（ANSUR II、NHANES，美国数据），不是个体预测；默认值就是这副身体原样。', en: 'The four shape controls come from anthropometric regressions (ANSUR II, NHANES; US data), not from a prediction for an individual; the defaults are this body as built.' },
    { zh: 'BMI 只改变皮肤和皮下脂肪：肌肉、骨和内脏不变。BMI 升高时内脏脂肪、乳房和腹腔内容物的变化没有建模；BMI 降低到可用下限以下会让肌肉穿出皮肤，所以被限制。', en: 'BMI changes skin and subcutaneous fat only: muscles, bones and viscera stay as they are. Visceral fat, the breasts and the abdominal contents are not modelled as BMI rises; below the valid lower bound muscles would come through the skin, hence the limit.' },
    { zh: '身高和比例通过各关节节段的缩放实现：骨沿长轴拉长、按围度因子略微变粗；骨盆只在横向变宽（骶骨被放大而髋骨只是平移），躯干长度全部由腰椎和胸椎承担，肋骨整体等比缩放。这些是为了便宜而作的近似。', en: 'Stature and proportions are realised by per-joint segment scales: bones lengthen along their axis and thicken slightly by the girth factor; the pelvis widens transversely only (the sacrum is scaled while the hip bones merely shift), trunk length is carried entirely by the lumbar and thoracic vertebrae, and ribs scale uniformly. These are approximations chosen for cheapness.' },
    { zh: '体型分布（腰腹型–四肢型）目前只通过各节段横截面的缩放表现，没有专门的皮肤位移场，效果很弱。', en: 'Mass distribution (waist-heavy versus limb-heavy) is expressed only through the cross-section scales of the segments, without a displacement field of its own; its effect is weak.' },
  ]

  writeFileSync(join(dir, 'shape.json'), JSON.stringify(shape))
  writeFileSync(join(dir, 'shape.bin'), bin)

  // ── 肢段长度：缩放后量到的与模型给出的 / segment lengths: measured after scaling against the model
  const lengthChecks: { control: string; factor: string; expected: number; measured: number; errorPct: number }[] = []
  for (const [label, c] of settings.slice(1)) {
    if (c.bmi !== undefined) continue
    const f = factorValues(shape, c, false)
    const scales = new Shaper(shape, bin, c, false).scales
    for (const cal of calibration) {
      const measured = distance(scales, cal.from, cal.to) / distance({}, cal.from, cal.to)
      lengthChecks.push({ control: label, factor: cal.factor, expected: Math.round(f[cal.factor]! * 1e4) / 1e4, measured: Math.round(measured * 1e4) / 1e4, errorPct: Math.round((measured / f[cal.factor]! - 1) * 1e4) / 100 })
    }
  }

  // ── 渲染 / renders ───────────────────────────────────────────────────────────────────────
  const files: string[] = []
  if (renders) {
    const outDir = join(import.meta.dirname, 'out', bodyId)
    mkdirSync(outDir, { recursive: true })
    const view = (at: (p: Part) => Float32Array, pred: (p: Part) => boolean, yaw: number) =>
      render(parts.filter(pred).map((p): RenderItem => ({ positions: at(p), indices: body.meshes.get(p.id)!.indices, color: COLORS[p.tissue] ?? [200, 200, 200] })), { yaw, center: [0, 0.86, 0.1], halfHeight: 1.05, width: 420, height: 760 })
    const isSkin = (p: Part): boolean => p.id === skinPart.id
    const isDeep = (p: Part): boolean => p.tissue === 'bone' || p.tissue === 'muscle' || p.tissue === 'tendon' || (p.tissue === 'cartilage' && p.system === 'skeletal')
    const isFat = (p: Part): boolean => p.tissue === 'fat' || p.tissue === 'bone'
    const group = (name: string, list: [string, ShapeControls][]): void => {
      const ats = list.map(([, c]) => evaluate(c))
      const tiles = [...ats.map((a) => view(a, isSkin, 0)), ...ats.map((a) => view(a, isSkin, 90)), ...ats.map((a) => view(a, isDeep, 0)), ...ats.map((a) => view(a, isFat, 0))]
      const file = join(outDir, `shape-${name}.png`)
      sheet(tiles, list.length).save(file)
      files.push(file.slice(ROOT.length + 1))
    }
    group('stature', [settings[1]!, settings[0]!, settings[2]!])
    group('bmi', [[`BMI ${bmiC.valid.min}`, { bmi: bmiC.valid.min }], settings[0]!, ['BMI 30', { bmi: 30 }], [`BMI ${bmiC.valid.max}`, { bmi: bmiC.valid.max }]])
    group('legLength', [[`leg length ${cur.extremes.legLength[0]}`, { legLength: cur.extremes.legLength[0]! }], settings[0]!, [`leg length ${cur.extremes.legLength[1]}`, { legLength: cur.extremes.legLength[1]! }]])
    group('centralBuild', [[`central build ${cur.extremes.centralBuild[0]}`, { centralBuild: cur.extremes.centralBuild[0]! }], settings[0]!, [`central build ${cur.extremes.centralBuild[1]}`, { centralBuild: cur.extremes.centralBuild[1]! }]])
  }

  const report = {
    schema: 1, body: bodyId, inputs, binBytes: bin.byteLength, notes,
    skin: { part: skinPart.id, vertices: nSkin, farthestFromSourceMm: Math.round(far * 1e5) / 100 },
    followers: { parts: followers.length, vertices: followData.reduce((s, f) => s + f.follow.reduce((a, b) => a + (b > 0 ? 1 : 0), 0), 0) },
    calibration, lengthChecks, measures, bmiScan: scan, validBmi: bmiC.valid, renders: files,
  }
  writeFileSync(join(dir, 'shape.report.json'), JSON.stringify(report, null, 1))
  log(`shape.json: ${shape.joints.length} scaled joints, ${followers.length} followers; shape.bin ${(bin.byteLength / 1e6).toFixed(2)} MB; valid BMI ${bmiC.valid.min}…${bmiC.valid.max}`)
}

/** 表格在某 BMI 处的值（线性插值）。 Value of the table at a BMI (linear interpolation). */
function bmiUnitsOf(table: [number, number][], bmi: number): number {
  return bmiUnits({ skin: { bmiToUnits: table } } as unknown as ShapeData, bmi)
}

/** shape.report.json 所记录的输入是否与磁盘上的当前文件一致。 Whether the inputs recorded in shape.report.json still match the files on disk. */
export function shapeStale(bodyDir: string): string[] {
  const p = join(bodyDir, 'shape.report.json')
  if (!existsSync(p)) return ['shape.report.json is missing']
  const rec = (JSON.parse(readFileSync(p, 'utf8')) as { inputs: Record<string, string> }).inputs
  const out: string[] = []
  for (const [name, hash] of Object.entries(rec)) {
    const file = inputFile(name)
    const path = file.startsWith('data/') ? join(ROOT, file) : join(bodyDir, file)
    if (!existsSync(path)) out.push(`${name}: missing`)
    else if (hashInput(name, path) !== hash) out.push(`${name}: changed`)
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const bodyId = (args.find((a) => !a.startsWith('--')) ?? 'male') as 'male' | 'female'
  const t0 = performance.now()
  await buildShape(bodyId, !args.includes('--no-renders'), (m) => console.log(`[shape ${bodyId} ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`))
}

