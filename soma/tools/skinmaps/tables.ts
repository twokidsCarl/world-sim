// 供后续疼痛模型使用的对照表：皮节 → 脊神经根/神经节部件；皮神经分布区 → 神经部件 → 上级神经链 → 节段。
// Lookup tables for the later pain model: dermatome → spinal root / ganglion parts; cutaneous
// territory → nerve parts → parent chain → spinal segments.

import type { RegionDef } from './build.ts'
import type { Body } from './io.ts'
import type { SideLR } from './landmarks.ts'

type Sided<T> = { L: T; R: T }
const SIDE_WORD = { L: 'left', R: 'right' } as const
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']

/** 某一节段在某一侧的根、神经节、前支等部件 / Root, ganglion and ramus parts of one segment on one side. */
export function segmentParts(body: Body, segment: string, side: SideLR): { id: string; name: string }[] {
  const s = SIDE_WORD[side]
  const out: { id: string; name: string }[] = []
  const add = (test: (name: string) => boolean) => {
    for (const p of body.data.parts) {
      const n = p.name.toLowerCase()
      if (n.startsWith(s + ' ') && test(n) && !out.some((o) => o.id === p.id)) out.push({ id: p.id, name: p.name })
    }
  }
  if (segment === 'V') add((n) => /trigeminal (nerve|ganglion)/.test(n))
  else if (segment === 'Co') add((n) => n.includes('coccygeal nerve'))
  else {
    const re = new RegExp(`\\b${segment.toLowerCase()}\\b`)
    add((n) => re.test(n) && /(ganglion|root|ramus)/.test(n) && !/contribution/.test(n))
    const m = /^T(\d+)$/.exec(segment)
    if (m && +m[1]! <= 11) add((n) => n === `${s} ${ORDINAL[+m[1]! - 1]} intercostal nerve`)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 部件 FMA 概念在 isa 树中的不分侧上级概念 / The unsided parent concept (isa tree) of a sided part's concept. */
export function unsidedConcept(body: Body, partName: string): string | undefined {
  const isa = new Map(body.data.trees.isa.map((c) => [c.id, c]))
  const find = (side: SideLR) => body.data.parts.find((p) => p.name.toLowerCase() === partName.replaceAll('{side}', SIDE_WORD[side]).toLowerCase())
  const l = find('L'), r = find('R')
  if (!l || !r) return undefined
  const pl = isa.get(l.fma)?.parent, pr = isa.get(r.fma)?.parent
  return pl && pl === pr && isa.has(pl) ? pl : undefined
}

const DERMATOME_CONCEPT_PARTS = (segment: string): string[] => {
  if (segment === 'V1') return ['{side} ophthalmic nerve']
  if (segment === 'V2') return ['{side} maxillary nerve']
  if (segment === 'V3') return ['{side} posterior division of mandibular nerve']
  return [`{side} ${segment} spinal ganglion`, `{side} posterior root of ${segment} spinal nerve`, `{side} ${segment} root in cauda equina`, `{side} ${segment} root of sacral plexus`, `{side} ${segment} root of lumbar plexus`]
}

/** 皮节分区对应的概念：优先脊神经节，其次后根 / Concept for a dermatome region: its spinal ganglion, else its posterior root. */
export function dermatomeConcept(body: Body, key: string): string | undefined {
  const seg = key === 'S4-5' ? 'S4' : key
  for (const name of DERMATOME_CONCEPT_PARTS(seg)) {
    const c = unsidedConcept(body, name)
    if (c) return c
  }
  return undefined
}

export function cutaneousConcept(body: Body, r: RegionDef): string | undefined {
  const from = (r.conceptFrom as string | undefined) ?? (r.nerves as string[] | undefined)?.[0]
  return from ? unsidedConcept(body, from) : undefined
}

function minDistanceMm(body: Body, a: string[], b: string[]): number | null {
  const pts = (ids: string[]) => body.nerves.filter((n) => ids.includes(n.part)).flatMap((n) => n.branches.map((br) => br.points))
  const A = pts(a), B = pts(b)
  if (!A.length || !B.length) return null
  let best = Infinity
  for (const pa of A) for (const pb of B)
    for (let i = 0; i < pa.length; i += 3)
      for (let j = 0; j < pb.length; j += 3) {
        const d = Math.hypot(pa[i]! - pb[j]!, pa[i + 1]! - pb[j + 1]!, pa[i + 2]! - pb[j + 2]!)
        if (d < best) best = d
      }
  return +(best * 1000).toFixed(1)
}

export function buildTables(body: Body, dermatomes: RegionDef[], cutaneous: RegionDef[]) {
  const ids = (pattern: string, side: SideLR): string[] => {
    const name = pattern.replaceAll('{side}', SIDE_WORD[side]).toLowerCase()
    return body.data.parts.filter((p) => p.name.toLowerCase() === name).map((p) => p.id)
  }
  const sided = <T>(f: (side: SideLR) => T): Sided<T> => ({ L: f('L'), R: f('R') })
  const dermatomeRows = dermatomes.map((r) => {
    const segments = r.key === 'S4-5' ? ['S4', 'S5'] : r.key.startsWith('V') ? ['V'] : [r.key]
    return {
      dermatome: r.key,
      segments,
      concept: dermatomeConcept(body, r.key) ?? null,
      // 三叉神经各支：列出该支自身的部件 / Trigeminal divisions: the division's own parts are listed.
      parts: sided((side) => (r.key.startsWith('V') ? [...DERMATOME_CONCEPT_PARTS(r.key).flatMap((n) => ids(n, side)).map((id) => ({ id, name: body.byId.get(id)!.name })), ...segmentParts(body, 'V', side)] : segments.flatMap((s) => segmentParts(body, s, side)))),
    }
  })
  const cutaneousRows = cutaneous.map((r) => {
    const nerves = (r.nerves as string[] | undefined) ?? []
    const via = (r.via as string[] | undefined) ?? []
    const segments = (r.segments as string[]) ?? []
    const nerveParts = sided((side) => nerves.flatMap((n) => ids(n, side)))
    let prev = nerveParts
    const chain = via.map((name) => {
      const parts = sided((side) => ids(name, side))
      // 与上一环节中心线的最小距离：小则说明模型中两者确实相连 / Gap to the previous link's centreline: small means they do join in the model.
      const gapMm = sided((side) => minDistanceMm(body, prev[side], parts[side]))
      if (parts.L.length || parts.R.length) prev = parts
      return { name: name.replace('{side} ', ''), parts, gapMm }
    })
    return {
      territory: r.key,
      basis: r.basis,
      concept: cutaneousConcept(body, r) ?? null,
      nerveParts,
      chain,
      segments,
      segmentsSource: r.segmentsSource,
      rootParts: sided((side) => segments.flatMap((s) => segmentParts(body, s, side).map((p) => p.id))),
    }
  })
  return { dermatomes: dermatomeRows, cutaneous: cutaneousRows }
}
