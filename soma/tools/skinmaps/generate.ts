// 从整理好的定义文件生成两张皮肤分区图（皮节、皮神经分布区）及其检验报告。
// Builds the two skin maps (dermatomes, cutaneous nerve territories) from the curated
// definitions, together with their verification report.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyId, SkinMap, SkinMaps } from '../../src/anatomy/types.ts'
import { Builder, type BuiltMap, type MapDef } from './build.ts'
import { meshHash, readBody, readGlbParts, type Body } from './io.ts'
import { Landmarks, type LandmarkFile } from './landmarks.ts'
import { buildSkin, type Skin } from './mesh.ts'
import { buildTables, cutaneousConcept, dermatomeConcept } from './tables.ts'
import { areas, checks, composition, keyPoints, pieces, speckle, unassigned, type CheckDef } from './verify.ts'

export const ROOT = join(import.meta.dirname, '../..')
export const CURATED = join(ROOT, 'data/curated/skinmaps')

interface SourceDef { id: string; name: string; url: string; license: string; consulted: boolean }
export type DermatomeDef = MapDef & { sources: SourceDef[]; checks: CheckDef[] }
export type CutaneousDef = MapDef & { sources: SourceDef[] }

export interface Context {
  body: Body
  skinPart: string
  skin: Skin
  skinHash: string
  lm: Landmarks
  dermatomeDef: DermatomeDef
  cutaneousDef: CutaneousDef
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

/** 读入一个人体的皮肤、骨骼、神经和定义文件 / Loads one body's skin, bones, nerves and the definitions. */
export async function loadContext(bodyId: BodyId): Promise<Context> {
  const dir = join(ROOT, 'public/anatomy', bodyId)
  const body = readBody(dir)
  const part = body.data.parts.find((p) => p.name === 'Skin' && p.system === 'integumentary')
  if (!part) throw new Error('no part named "Skin"')
  const integ = await readGlbParts(join(dir, 'integumentary.glb'))
  const raw = integ.get(part.id)
  if (!raw) throw new Error(`skin part ${part.id} missing from integumentary.glb`)
  const bones = await readGlbParts(join(dir, 'skeletal.glb'))
  for (const [k, v] of integ) bones.set(k, v)
  // 正中矢状面取中线骨骼的平均 X / The median plane is the mean X of the midline bones.
  const mid = body.data.parts.filter((p) => p.system === 'skeletal' && /vertebra$|^Sacrum$|^Manubrium$/.test(p.name))
  const midX = mid.reduce((s, p) => s + p.centroid[0], 0) / (mid.length || 1)
  const skin = buildSkin(raw, midX)
  const lm = new Landmarks(body, bones, skin, readJson<LandmarkFile>(join(CURATED, 'landmarks.json')))
  return { body, skinPart: part.id, skin, skinHash: meshHash(raw), lm, dermatomeDef: readJson(join(CURATED, 'dermatomes.json')), cutaneousDef: readJson(join(CURATED, 'cutaneous.json')) }
}

const CAVEAT = {
  zh: '这是为教学而构建的示意图：皮节因人而异，各家发表的图谱互有出入，相邻区域实际上相互重叠；本图未经临床医师审校，不能用于诊断。',
  en: 'This is a constructed teaching map: dermatomes vary between people, published maps disagree, and neighbouring areas really overlap; it has not been reviewed by a clinician and must not be used for diagnosis.',
}

const METHOD = {
  dermatome: {
    zh: `以 ISNCSCI 关键感觉点为锚点，由本模型骨骼计算体表标志并设定种子曲线，按皮肤表面测地距离分区，肢体轴线作为屏障；T2–T11 皮节带沿本模型肋间神经的体表投影，面部按三叉神经三支划分。关键点之间的排列参照 ISNCSCI 评定表图示和 Lee 等（2008），其留白区由最近的皮节填充。${CAVEAT.zh}`,
    en: `Anchored on the ISNCSCI key sensory points: landmarks are computed from this model's bones, seed curves are laid through them, and the skin is divided by geodesic distance along its surface with the axial lines of the limbs as barriers; the T2–T11 bands follow the skin projection of this model's intercostal nerves and the face is divided among the three trigeminal divisions. Between key points the arrangement follows the ISNCSCI worksheet figure and Lee et al. (2008), whose blank areas are filled by the nearest dermatome. ${CAVEAT.en}`,
  },
  cutaneousNerve: {
    zh: `模型中有皮神经的，将其走行于皮下的中心线投影到皮肤，按测地距离把皮肤分给最近的神经；模型中没有的神经（如颈丛皮支、肋间臂神经、肋下神经、各后支、阴部神经皮支）按教科书描述用体表标志规则补全，并对照 Gray《人体解剖学》（1918）的分布描述校正。神经模型为图谱式建模并配准到本体，位置有数毫米误差。皮神经分布区同样因人而异且相互重叠；本图未经临床医师审校，不能用于诊断。`,
    en: `Where the model has the cutaneous nerve, the subcutaneous part of its centreline is projected to the skin and each piece of skin goes to the nearest nerve by geodesic distance; nerves missing from the model (cervical plexus branches, intercostobrachial, subcostal, posterior rami, cutaneous branches of the pudendal nerve and others) are filled in by landmark rules from textbook descriptions, and the result was checked against the distributions described in Gray's Anatomy (1918). The nerve models are atlas geometry registered to this body, good to a few millimetres. Nerve territories also vary between people and overlap; this map has not been reviewed by a clinician and must not be used for diagnosis.`,
  },
}

export interface Generated {
  ctx: Context
  dermatome: BuiltMap
  cutaneous: BuiltMap
  skinMaps: SkinMaps
  bin: Uint8Array
  tables: ReturnType<typeof buildTables>
  report: ReturnType<typeof makeReport>
}

export function makeReport(ctx: Context, dermLabels: Uint8Array, cutLabels: Uint8Array) {
  const { skin, lm, dermatomeDef: dd, cutaneousDef: cd } = ctx
  const kp = keyPoints(lm, dermLabels, dd)
  const ck = checks(lm, dermLabels, dd, dd.checks)
  const round = (v: number) => +v.toFixed(4)
  const y = (name: string, side: 'L' | 'R') => round(lm.point(name, side)[1])
  return {
    skinPart: ctx.skinPart,
    skinHash: ctx.skinHash,
    vertexCount: skin.n,
    outerVertices: skin.outer.reduce((s, v) => s + v, 0),
    dermatome: {
      unassigned: unassigned(skin, dermLabels),
      areas: areas(skin, dermLabels, dd.regions),
      keyPoints: kp,
      keyPointsFailed: kp.filter((k) => !k.ok),
      checks: ck,
      pieces: pieces(skin, dermLabels, dd.regions),
      speckle: speckle(skin, dermLabels),
      // ISNCSCI 括注的体表平面与本模型肋间神经定位之差（米）/ ISNCSCI's parenthetical surface levels against this model's nerve-based levels (m).
      trunkLevels: (['L', 'R'] as const).map((side) => ({
        side,
        nippleByRibs: y('nippleLevelRibs', side), T4: y('K_T4', side),
        xiphisternum: y('xiphisternumAtMcl', side), T6: y('K_T6', side),
        umbilicus: y('umbilicusAtMcl', side), T10: y('K_T10', side),
        literalXiphisternumIn: dd.regions[dermLabels[lm.vertex('xiphisternumAtMcl', side)]!]?.key,
        literalUmbilicusIn: dd.regions[dermLabels[lm.vertex('umbilicusAtMcl', side)]!]?.key,
      })),
    },
    cutaneous: {
      unassigned: unassigned(skin, cutLabels),
      areas: areas(skin, cutLabels, cd.regions),
      pieces: pieces(skin, cutLabels, cd.regions),
      speckle: speckle(skin, cutLabels),
      composition: composition(skin, { def: dd, labels: dermLabels }, { def: cd, labels: cutLabels }),
    },
  }
}

export async function generate(bodyId: BodyId): Promise<Generated> {
  const ctx = await loadContext(bodyId)
  const builder = new Builder(ctx.body, ctx.skin, ctx.lm)
  const dermatome = builder.build(ctx.dermatomeDef)
  const cutaneous = builder.build(ctx.cutaneousDef)
  const n = ctx.skin.n
  const bin = new Uint8Array(n * 2)
  bin.set(dermatome.labels, 0)
  bin.set(cutaneous.labels, n)
  const modelSources = ctx.body.data.sources.filter((s) => /BodyParts3D 4|Z-Anatomy|Open3DModel/.test(s.name)).map((s) => ({ name: s.name, url: s.url, license: s.license }))
  const cite = (list: SourceDef[]) => list.filter((s) => s.consulted).map((s) => ({ name: s.name, url: s.url, license: s.license }))
  const maps: SkinMap[] = [
    {
      id: 'dermatome',
      name: { zh: '皮节', en: 'Dermatomes' },
      regions: ctx.dermatomeDef.regions.map((r) => {
        const concept = dermatomeConcept(ctx.body, r.key)
        return { name: r.name, ...(concept ? { concept } : {}), color: r.color }
      }),
      offset: 0,
      method: METHOD.dermatome,
      sources: [...cite(ctx.dermatomeDef.sources), ...modelSources],
      status: 'unreviewed',
    },
    {
      id: 'cutaneousNerve',
      name: { zh: '皮神经分布区', en: 'Cutaneous nerve territories' },
      regions: ctx.cutaneousDef.regions.map((r) => {
        const concept = cutaneousConcept(ctx.body, r)
        return { name: r.name, ...(concept ? { concept } : {}), color: r.color }
      }),
      offset: n,
      method: METHOD.cutaneousNerve,
      sources: [...cite(ctx.cutaneousDef.sources), ...modelSources],
      status: 'unreviewed',
    },
  ]
  const skinMaps: SkinMaps = { part: ctx.skinPart, vertexCount: n, maps }
  return {
    ctx, dermatome, cutaneous, skinMaps, bin,
    tables: buildTables(ctx.body, ctx.dermatomeDef.regions, ctx.cutaneousDef.regions),
    report: makeReport(ctx, dermatome.labels, cutaneous.labels),
  }
}
