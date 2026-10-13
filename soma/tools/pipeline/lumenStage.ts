// 腔这一步，打包成两副人体的构建都能调用的一个函数（现在还没有接进去）。
// 输入：构建手里的部件（id、名称、FMA、系统、组织、包围盒、网格）。输出：新的腔部件（tissue 为 space，provenance 为 curated，
// composition 把“由外表面和文献壁厚推出”“以真实部件为界”“构造”分开）、退役的 id、报告的一节、要提醒用户的话，
// 以及按 GLB 顶点次序排好的充盈位移场。纯函数在 lumen.ts，装配在 lumenBuild.ts，口和咽在 lumenHead.ts。
// 不写任何文件；FMA 号都在管线所用的 FMA 表里查过，查不到的部件不给（报告里说明）。
//
// The lumen stage, packaged as one function both builds can call (not wired in yet).
// Input: the parts a build holds (id, name, FMA, system, tissue, bounds, mesh). Output: the new lumen
// parts (tissue `space`, provenance `curated`, with a `composition` that separates "derived from the
// outer surface and a literature wall thickness", "bounded by real parts" and "construction"), the
// retired ids, a report section, the cautions for the user and the filling displacement field in GLB
// vertex order. Pure functions are in lumen.ts, the assembly in lumenBuild.ts, mouth and pharynx in
// lumenHead.ts. Nothing is written; every FMA id is looked up in the FMA table the pipeline uses, and a
// part whose id is not there is not offered (the report says so).

import type { Part, PartPiece, SystemId } from '../../src/anatomy/types.ts'
import type { Mesh } from './geometry.ts'
import { glbVertexOrder } from './glb.ts'
import { loadFmaNames } from './zanatomy.ts'
import { buildLumen, UTEROVAGINAL_ID, UTEROVAGINAL_PIECES, type LumenInput, type RestFilling } from './lumenBuild.ts'

/** 充盈位移场的文件名和格式 / file name and layout of the filling displacement field */
export const FILLING_FILE = 'lumen-filling.bin'
export const FILLING_INDEX_FILE = 'lumen-filling.json'

export interface LumenStagePart {
  id: string
  name: string
  fma: string
  /** FMA 表里这个号的名称 / the label of that id in the FMA table */
  fmaLabel: string
  system: SystemId
  tissue: 'space'
  provenance: 'curated'
  /** 部件的来源名：本项目推出的写 `soma (derived)`，标本自己的腔面写原来源 / the part's source name: `soma (derived)` for what this project derived, the original source for the specimen's own lumen surface */
  source: string
  mesh: Mesh
  /** 各片的顶点数之和等于网格的顶点数 / the vertex counts sum to the vertex count of the mesh */
  composition: PartPiece[]
  /** 它的壁是哪些部件 / the parts that are its wall */
  walls: string[]
  /** 位置(f) = 存下来的位置 + (f − rest)·displacement；按 `mesh` 的顶点次序 / position(f) = stored + (f − rest)·displacement; in the vertex order of `mesh` */
  filling: { rest: number; displacement: Float32Array; restState: RestFilling }
}

export interface LumenStageResult {
  parts: LumenStagePart[]
  /** 退役的 id → 取代它的 id / retired id → the ids that replace it */
  retired: Map<string, string[]>
  /** 没有给出的腔及原因 / lumina not offered, with the reason */
  notOffered: { id: string; reason: string }[]
  report: Record<string, unknown>
  cautions: { zh: string; en: string }[]
}

/** 把一组部件 id 里已退役的腔 id 换成取代它的 id（同 lipSplit.ts 的 expandRetiredLipIds） / replaces retired lumen ids in a list by the ids that took their place (as expandRetiredLipIds in lipSplit.ts) */
export function expandRetiredLumenIds(ids: readonly string[], retired: ReadonlyMap<string, readonly string[]>): string[] {
  return ids.flatMap((id) => retired.get(id) ?? [id])
}

/**
 * 这一步。`body` 决定部件 id 的前缀和有哪些器官；`input` 是构建此刻的部件和网格；`opts.fmaLabel` 可换掉 FMA 表（测试用）。
 * The stage. `body` decides the id prefix and which organs exist; `input` is what the build holds at this point.
 */
export async function lumenStage(body: 'male' | 'female', input: LumenInput, opts: { fmaLabel?: (id: string) => string | undefined } = {}): Promise<LumenStageResult> {
  const res = await buildLumen(body, '', input)
  // FMA 表：缺省读管线的那一份；测试可以另给 / the FMA table: the pipeline's own by default; a test may supply another
  const table = opts.fmaLabel ? null : loadFmaNames()
  const fmaLabel = opts.fmaLabel ?? ((id: string) => table?.label.get(id))
  const parts: LumenStagePart[] = []
  const notOffered: { id: string; reason: string }[] = []
  for (const q of res.parts) {
    const label = fmaLabel(q.fma)
    if (!label) {
      notOffered.push({ id: q.id, reason: `FMA id ${q.fma} is not in the FMA table the pipeline uses` })
      continue
    }
    const nv = q.mesh.positions.length / 3
    const pieces = q.composition.reduce((s, c) => s + c.vertices, 0)
    if (pieces !== nv) throw new Error(`lumenStage: composition of ${q.id} covers ${pieces} of ${nv} vertices`)
    parts.push({
      id: q.id, name: q.name, fma: q.fma, fmaLabel: label, system: q.system, tissue: 'space', provenance: 'curated',
      source: q.composition.find((c) => c.provenance !== 'construction')?.source ?? 'soma (derived)',
      mesh: q.mesh, composition: q.composition, walls: q.walls, filling: { rest: q.filling.rest, displacement: q.filling.displacement, restState: q.restState },
    })
  }
  for (const o of (res.report.organs as { lumen?: string; result?: string; reason?: string }[] | undefined) ?? []) if (o.lumen && o.result !== 'lumen modelled') notOffered.push({ id: o.lumen, reason: o.reason ?? o.result ?? 'not modelled' })
  const retired = new Map<string, string[]>()
  if (UTEROVAGINAL_PIECES.every((id) => parts.some((p) => p.id === id))) retired.set(UTEROVAGINAL_ID, [...UTEROVAGINAL_PIECES])
  return { parts, retired, notOffered, report: { ...res.report, notOffered, retired: Object.fromEntries(retired) }, cautions: lumenCautions(body, res.report, parts) }
}

/**
 * 充盈位移场，按 GLB 顶点次序：每个部件一段 float32 xyz，次序与 writeSystemGlb 写出该部件的顶点次序相同（glbVertexOrder）。
 * 调用方写出 GLB 后应读回核对顶点数（见测试）。
 * The filling displacement field in GLB vertex order: one run of float32 xyz per part, in the order in
 * which writeSystemGlb writes that part's vertices (glbVertexOrder). A caller should read the GLB back
 * and check the vertex counts (see the tests).
 */
export async function fillingSidecar(parts: Pick<LumenStagePart, 'id' | 'mesh' | 'filling'>[]): Promise<{ bin: Uint8Array; index: { rule: string; file: string; parts: { part: string; rest: number; offset: number; vertices: number }[] } }> {
  const chunks: Float32Array[] = []
  const rows: { part: string; rest: number; offset: number; vertices: number }[] = []
  let offset = 0
  for (const p of parts) {
    const order = await glbVertexOrder(p.mesh.indices)
    const out = new Float32Array(order.vertices * 3)
    for (let v = 0; v < order.remap.length; v++) {
      const g = order.remap[v]!
      if (g === 0xffffffff) continue
      for (let q = 0; q < 3; q++) out[3 * g + q] = p.filling.displacement[3 * v + q]!
    }
    rows.push({ part: p.id, rest: p.filling.rest, offset, vertices: order.vertices })
    chunks.push(out)
    offset += out.byteLength
  }
  const bin = new Uint8Array(offset)
  let at = 0
  for (const ch of chunks) (bin.set(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength), at), (at += ch.byteLength))
  return { bin, index: { rule: 'position(f) = GLB position + (f − rest) · displacement; f = 0 collapsed to the tabled calibre, f = 1 as full as the unmoving wall allows; float32 xyz (metres) per vertex in the vertex order of the part as decoded from its GLB', file: FILLING_FILE, parts: rows } }
}

/** 要提醒用户的话（每条中文不超过 260 字），数字都取自本次的报告 / the cautions for the user (each zh under 260 characters); every figure is from this run's report */
export function lumenCautions(body: 'male' | 'female', report: Record<string, unknown>, parts: LumenStagePart[]): { zh: string; en: string }[] {
  const canal = report.canal as { totalCentrelineMm: number; constructedShare: number; groups: { group: string; volumeCm3?: { beforeOverlapAndBendRules: number; full: number }; surfaceAreaCm2?: { boundedByRealParts: number; construction: number } }[] }
  const overlaps = report.sourceWallOverlaps as { consecutive: { pairs: number; medianDepthMm: number }; nonConsecutive: { pairs: number; maxDepthMm: number } }
  const g = (k: string) => canal.groups.find((x) => x.group === k)
  const si = ['jejunum', 'ileum'].map(g)
  const before = si.reduce((s, x) => s + (x?.volumeCm3?.beforeOverlapAndBendRules ?? 0), 0), after = si.reduce((s, x) => s + (x?.volumeCm3?.full ?? 0), 0)
  const head = ['oral', 'pharynx'].map(g)
  const real = Math.round(head.reduce((s, x) => s + (x?.surfaceAreaCm2?.boundedByRealParts ?? 0), 0)), made = Math.round(head.reduce((s, x) => s + (x?.surfaceAreaCm2?.construction ?? 0), 0))
  const pct = Math.round(canal.constructedShare * 100)
  const out: { zh: string; en: string }[] = [
    {
      zh: `空腔器官的“腔”不是扫描出来的：是把器官外表面向内缩一个壁厚得到的，壁厚取自文献或是假设值（见壁厚表）。器官之间的衔接、穿过器官两端封盖的部分是构造的，中心线上约 ${pct}% 在任何壁之外。壁本身没有改动。`,
      en: `The lumina of the hollow organs are not scanned: each is the organ's outer surface moved inward by a wall thickness taken from the literature or assumed (see the wall table). The joins between organs and the stretches through an organ's end caps are constructed; about ${pct}% of the centreline lies outside any wall. The walls themselves are unchanged.`,
    },
    {
      zh: `小肠在数据里是 54 片互相重叠的短段（相邻两片重叠深度的中位数 ${overlaps.consecutive.medianDepthMm} mm，另有 ${overlaps.nonConsecutive.pairs} 对不相邻的片也重叠）。腔在重叠处各让一半，在急弯内侧收窄，所以空肠和回肠的腔比单纯内缩小约 ${Math.round((100 * (before - after)) / Math.max(1, before))}%，口径沿途忽粗忽细，不代表真实的肠腔。`,
      en: `The small intestine is 54 short pieces that overlap each other in the data (median overlap of neighbours ${overlaps.consecutive.medianDepthMm} mm; ${overlaps.nonConsecutive.pairs} pairs that are not neighbours overlap too). Lumina give way to each other there and narrow on the inside of sharp bends, so the jejunal and ileal lumina are about ${Math.round((100 * (before - after)) / Math.max(1, before))}% smaller than a plain inward offset and vary in calibre along the way; this is not the true bowel lumen.`,
    },
    {
      zh: `口腔和咽的腔以这副人体里的舌、腭骨、牙、咽缩肌、椎前肌、会厌和喉软骨为界（约 ${real} cm²）；没有部件可依的方向是构造的（约 ${made} cm²），包括通鼻腔和喉口的地方。这里没有软腭和黏膜的部件；喉口只标了位置，没有气道的腔。`,
      en: `The cavities of mouth and pharynx are bounded by this body's tongue, palatal bones, teeth, constrictors, prevertebral muscles, epiglottis and laryngeal cartilages (about ${real} cm²); directions with no part to meet are constructed (about ${made} cm²), among them the openings to the nose and the larynx. There is no soft-palate or mucosa part; the laryngeal inlet is only marked, with no airway lumen.`,
    },
    {
      zh: '充盈度从 0 到 1：0 是表里的塌陷口径，1 是不动的壁所能容下的最大。壁不随充盈变形，所以塌陷的腔外面是按扫描大小画的壁。食管和胃静止时塌陷有出处；其余器官的静止状态、各段的塌陷口径和括约肌的收窄都是假设。',
      en: 'Filling runs from 0 to 1: 0 is the tabled collapsed calibre, 1 the most the unmoving wall can hold. Walls do not deform with filling, so a collapsed lumen sits inside a wall drawn at its scanned size. That oesophagus and stomach are collapsed at rest is sourced; the resting state of the other organs, the collapsed calibres and the narrowing at sphincters are assumptions.',
    },
  ]
  if (body === 'male') out.push({
    zh: '男性没有另建尿道的腔：名为“Urethra”的部件本身只有 1.6–2.1 mm 粗，是腔的位置而不是壁。它在前列腺和尿道海绵体之间有约 6 mm 不在任何部件里，其后约 12 mm 落在阴茎海绵体的部件里。',
    en: 'No urethral lumen is built for the male: the part named "Urethra" is itself only 1.6–2.1 mm thick and marks the lumen, not the wall. Between prostate and corpus spongiosum about 6 mm of it lies in no part, and the next 12 mm or so lie inside the corpus cavernosum part.',
  })
  else out.push({
    zh: `女性的直肠腔、宫腔、宫颈管和阴道腔是标本自己的腔面（后三者由原来合在一起的一个部件按中心线分成），没有充盈位移。尿道没有腔部件：黏膜下层上段约 18 mm 有一个孔，下段是实心的。${parts.some((p) => /ureter/.test(p.id)) ? '' : '她的输尿管太细且经过形变，推不出不出壁的腔，所以没有。'}`,
    en: `The female's rectal lumen, uterine cavity, cervical canal and vaginal lumen are the specimen's own lumen surfaces (the last three split along the centreline from one combined part) and carry no filling displacement. There is no urethral lumen part: the upper 18 mm or so of the submucous layer has a bore, the lower stretch is solid. ${parts.some((p) => /ureter/.test(p.id)) ? '' : 'Her ureters are too thin and warped for a lumen that stays inside the wall, so none is given.'}`,
  })
  return out
}

export type { LumenInput }
export type LumenStageInputPart = Part
