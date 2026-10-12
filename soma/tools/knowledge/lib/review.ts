// 审核流程：把名称和关系归并成“审核项”，按风险排序，并应用审核者的签核文件。
// 本工具从不把任何条目标成 reviewed；只有 review-signoffs.json 里有签核的审核项才会变成 reviewed。
//
// Review workflow: group names and relations into review items, order them by risk, and apply the
// reviewer's sign-off file. This tooling never marks anything reviewed by itself; an item becomes
// `reviewed` only when review-signoffs.json carries a sign-off for it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NameEntry } from '../../../src/anatomy/types.ts'
import { compareIds } from './bp3d.ts'
import { baseConceptOf, type Agreement, type NameCheck, type RelationCheck } from './crosscheck.ts'
import { sideOfConcept, stripSide, type Model } from './model.ts'
import { CURATED_DIR } from './paths.ts'
import { INVERSE_NOTE, REATTACHED_NOTE, type BuiltRelation } from './relations.ts'

export const SIGNOFF_FILE = 'review-signoffs.json'

export interface SignOff {
  /** 审核者的身份（角色，不写个人信息）/ the reviewer's role (no personal data), e.g. "anatomy lecturer" */
  reviewedBy: string
  /** ISO 日期 / ISO date, e.g. "2026-11-03" */
  date: string
  /** accept：原样通过；correct：按 corrected 改正后通过；reject：不成立（关系被删除，名称保持未审核）
   *  accept: correct as it stands; correct: right once `corrected` is applied; reject: wrong
   *  (a relation is dropped, a name stays unreviewed) */
  verdict: 'accept' | 'correct' | 'reject'
  corrected?: { zh?: string; objectLabelZh?: string; objectLabelEn?: string }
  note?: string
}

export interface SignOffFile {
  note: { zh: string; en: string }
  example: Record<string, SignOff>
  items: Record<string, SignOff>
}

const EMPTY_SIGNOFFS: SignOffFile = {
  note: {
    zh: '审核签核文件，由审核者手工编辑。键是 review-queue.json 里的审核项 id；构建脚本（bun tools/knowledge/run.ts）只把这里签核过的条目标为 reviewed。verdict：accept＝原样通过；correct＝按 corrected 改正后通过（名称用 zh，关系用 objectLabelZh / objectLabelEn）；reject＝不成立（关系从输出中删除，名称保持未审核并留待修改）。reviewedBy 写角色，不写姓名或联系方式。',
    en: 'Reviewer sign-offs, edited by hand. Keys are item ids from review-queue.json; the build (bun tools/knowledge/run.ts) marks as reviewed only what is signed off here. verdict: accept = correct as it stands; correct = right once `corrected` is applied (zh for names; objectLabelZh / objectLabelEn for relations); reject = wrong (a relation is removed from the output, a name stays unreviewed for rework). reviewedBy is a role, never a name or contact detail.',
  },
  example: {
    'name:FMA9611': { reviewedBy: 'anatomy lecturer', date: '2026-01-01', verdict: 'accept' },
    'name:FMA00000': { reviewedBy: 'anatomy lecturer', date: '2026-01-01', verdict: 'correct', corrected: { zh: '改正后的名称' }, note: 'why' },
    'rel:innervatedBy|Q201363#P3189|musculocutaneous nerve': { reviewedBy: 'anatomy lecturer', date: '2026-01-01', verdict: 'accept' },
  },
  items: {},
}

/** 读取签核文件；不存在时创建一个空的。Reads the sign-off file, creating an empty one when missing. */
export function loadSignOffs(): SignOffFile {
  const file = resolve(CURATED_DIR, SIGNOFF_FILE)
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(EMPTY_SIGNOFFS, null, 1)}\n`)
    return structuredClone(EMPTY_SIGNOFFS)
  }
  const data = JSON.parse(readFileSync(file, 'utf8')) as SignOffFile
  return { ...EMPTY_SIGNOFFS, ...data, items: data.items ?? {} }
}

// ---- 分组 / grouping ---------------------------------------------------------------------------

/** 名称审核项：不分侧概念连同它的 左/右 派生名。A name item: the unsided concept with its 左/右 derivatives. */
export function nameGroupOf(m: Model, names: Record<string, NameEntry>, id: string): string {
  const c = m.concepts.get(id)
  const base = baseConceptOf(m, id)
  if (c && base && names[base]?.zh) {
    const side = sideOfConcept(id, c.en)
    const mark = side === 'left' ? '左' : side === 'right' ? '右' : ''
    if (mark && names[id]?.zh === mark + names[base]!.zh) return `name:${base}`
  }
  return `name:${id}`
}

const sourceKey = (r: BuiltRelation, m: Model): string => {
  const u = r.source.url
  if (u.includes('wikidata.org/wiki/')) return u.slice(u.indexOf('/wiki/') + 6)
  const wp = /title=([^&]+)&oldid=(\d+)/.exec(u)
  if (wp) return `wp:${decodeURIComponent(wp[1]!)}@${wp[2]}`
  return `za:${stripSide(m.concepts.get(r.subject)?.en ?? r.subject)}`
}

/**
 * 关系审核项：同一条来源陈述经 is-a / 侧别 传播得到的所有关系算一项；由整块肌（或整个器官）传给局部的另算一项，
 * 因为它需要单独判断。镜像出的 innervates 归入它所依据的 innervatedBy 项。
 *
 * A relation item: every relation that one source statement yields through is-a / laterality
 * propagation is one item; what passes from a whole muscle (or organ) to a part is a separate item,
 * because it needs its own judgement. A mirrored `innervates` belongs to the item of the
 * `innervatedBy` statement it rests on.
 */
export function relationGroupOf(m: Model, r: BuiltRelation): string {
  const name = r.source.name
  const cls = name.includes('names a branch of this nerve') ? '|branch' : /whole (muscle|organ)/.test(name) ? '|whole' : ''
  const mirrored = r.kind === 'innervates' && (name.includes(INVERSE_NOTE) || name.includes(REATTACHED_NOTE))
  if (mirrored && !cls.includes('branch')) {
    const nerve = stripSide(m.concepts.get(r.subject)?.en ?? r.subject)
    return `rel:innervatedBy|${sourceKey(r, m)}|${nerve}${cls}`
  }
  const src = sourceKey(r, m)
  // Z-Anatomy 的 url 相同，来源键已含肌名 / Z-Anatomy shares one URL; its source key already carries the muscle
  return `rel:${r.kind}|${src}|${stripSide(r.objectLabel.en)}${cls}`
}

// ---- 风险 / risk -------------------------------------------------------------------------------

export interface QueueItem {
  id: string
  type: 'name' | 'relation'
  risk: number
  reasons: string[]
  crossCheck: Agreement
  status: 'unreviewed' | 'reviewed'
  value: Record<string, unknown>
  evidence: Record<string, unknown>
  members: { count: number; ids: string[] }
}

const NAME_BASE_RISK: Record<string, [number, string]> = {
  'machine-translation': [4, 'machine-generated name (project lexicon), no published source'],
  'machine-translation:override': [4, 'hand-written replacement of a Wikidata label judged wrong'],
  'lexicon:mainland-over-wikidata': [3, 'lexicon term used instead of a differently worded Wikidata label'],
  'wikidata:hant-converted': [2, 'Wikidata label converted from Traditional characters (regional wording possible)'],
  'wikidata:generic-twin': [2, 'label taken from the species-neutral Wikidata item'],
  'derived:laterality': [2, 'side word added to a Wikidata label'],
  'wikidata:via-uberon-id': [1, 'Wikidata label found through the UBERON id'],
  wikidata: [1, 'Wikidata label (single source)'],
}
/** 按数据作者的划分给出的描述性名称，没有标准术语 / descriptive names with no standard term */
const DESCRIPTIVE = new Set(['uterine and vaginal lumen', 'raphe of urethral sphincter', 'urethral sphincter proper'])

export interface ReviewInputs {
  m: Model
  names: Record<string, NameEntry>
  nameChecks: Map<string, NameCheck>
  relations: BuiltRelation[]
  relationChecks: RelationCheck[]
  signoffs: SignOffFile
}

export interface ReviewResult {
  queue: QueueItem[]
  /** 被签核为 reject 而删除的关系下标 / indices of relations dropped by a "reject" sign-off */
  rejectedRelations: Set<number>
  stats: Record<string, unknown>
}

const merge = (a: Agreement, b: Agreement): Agreement => (a === 'agree' || b === 'agree' ? 'agree' : a === 'disagree' || b === 'disagree' ? 'disagree' : 'none')

export function buildReview({ m, names, nameChecks, relations, relationChecks, signoffs }: ReviewInputs): ReviewResult {
  const partIds = new Set([...m.dataset.partFmas.values()].flatMap((s) => [...s]))
  const items = new Map<string, QueueItem>()

  // ---- 名称 / names
  const nameGroups = new Map<string, string[]>()
  for (const id of Object.keys(names)) {
    const g = nameGroupOf(m, names, id)
    ;(nameGroups.get(g) ?? nameGroups.set(g, []).get(g)!).push(id)
  }
  const zhOwners = new Map<string, Set<string>>()
  for (const [g, members] of nameGroups) {
    const canon = g.slice(5)
    const zh = names[canon]?.zh
    if (zh) (zhOwners.get(zh) ?? zhOwners.set(zh, new Set()).get(zh)!).add(g)
    void members
  }
  for (const [g, members] of nameGroups) {
    const canon = g.slice(5)
    const entry = names[canon]!
    const c = m.concepts.get(canon)
    const check = members.map((id) => nameChecks.get(id)?.result ?? 'none').reduce(merge, 'none' as Agreement)
    // 证据取与汇总结果一致的成员 / take the evidence from a member whose result matches the group's
    const evMember = members.find((id) => nameChecks.get(id)?.result === check && id === canon) ?? members.find((id) => nameChecks.get(id)?.result === check) ?? canon
    const ev = nameChecks.get(evMember) ?? { result: 'none' as Agreement }
    const [base, why] = NAME_BASE_RISK[entry.zhSource ?? ''] ?? [4, 'no recorded source']
    let risk = base
    const reasons = [why]
    if (check === 'disagree') { risk += 3; reasons.push('a second open source gives a different name') }
    else if (check === 'agree') { risk -= 3; reasons.push('a second open source gives the same name') }
    else reasons.push('no second open source')
    if (members.some((id) => partIds.has(id))) { risk += 2; reasons.push('shown on a selectable part') }
    if (ev.enwiki) { risk += 2; reasons.push('commonly taught structure (has an English Wikipedia article)') }
    const twins = entry.zh ? [...(zhOwners.get(entry.zh) ?? [])].filter((x) => x !== g) : []
    if (twins.length) { risk += 2; reasons.push(`same Chinese name as ${twins.length} other concept(s): ${twins.slice(0, 3).map((x) => m.concepts.get(x.slice(5))?.en ?? x).join('; ')}`) }
    if (c && DESCRIPTIVE.has(stripSide(c.en))) { risk += 2; reasons.push('descriptive name: no standard term known') }
    if (!/^FMA\d+/.test(canon)) { risk += 1; reasons.push('concept without an FMA class (synthetic id)') }
    items.set(g, {
      id: g, type: 'name', risk: Math.max(0, risk), reasons, crossCheck: check, status: 'unreviewed',
      value: { en: c?.en, zh: entry.zh, zhSource: entry.zhSource },
      evidence: { ...(ev.wikidata ? { wikidata: ev.wikidata } : {}), ...(ev.zhwiki ? { zhwiki: ev.zhwiki } : {}), ...(ev.lexicon ? { lexicon: ev.lexicon } : {}), ...(ev.enwiki ? { enwiki: ev.enwiki } : {}), ...(entry.la ? { la: entry.la } : {}), ...(entry.ja ? { ja: entry.ja } : {}), ...(entry.wikidata ? { wikidataItem: entry.wikidata } : {}) },
      members: { count: members.length, ids: members.sort(compareIds).slice(0, 8) },
    })
  }

  // ---- 关系 / relations
  const relGroups = new Map<string, number[]>()
  relations.forEach((r, i) => {
    const g = relationGroupOf(m, r)
    ;(relGroups.get(g) ?? relGroups.set(g, []).get(g)!).push(i)
  })
  for (const [g, idx] of relGroups) {
    const rs = idx.map((i) => relations[i]!)
    // 代表：优先直接陈述 / representative: prefer the direct statement
    const rep = rs.find((r) => r.via === 'direct' && r.kind !== 'innervates') ?? rs.find((r) => r.kind !== 'innervates') ?? rs[0]!
    const check = idx.map((i) => relationChecks[i]?.result ?? 'none').reduce(merge, 'none' as Agreement)
    const evIdx = idx.find((i) => relationChecks[i]?.result === check && check !== 'none')
    const name = rep.source.name
    let risk = 2
    const reasons: string[] = []
    if (name.startsWith('Z-Anatomy')) { risk += 1; reasons.push('bone found by geometry in an artist-modelled atlas') }
    else if (name.startsWith('Wikipedia')) { risk += rep.object ? 0 : 1; reasons.push(rep.object ? 'Wikipedia infobox' : 'Wikipedia infobox text; target not resolved to a structure') }
    else reasons.push('Wikidata statement')
    if (g.endsWith('|whole')) {
      const attach = rep.kind === 'origin' || rep.kind === 'insertion'
      risk += attach ? 4 : 3
      reasons.push(attach ? 'whole-muscle attachment applied to a named part: may not hold for this part' : 'statement about the whole applied to a named part')
    }
    if (g.endsWith('|branch')) { risk += 2; reasons.push('source names a branch; attached to the parent nerve') }
    if (check === 'disagree') { risk += 3; reasons.push('a second open source does not mention this target') }
    else if (check === 'agree') { risk -= 2; reasons.push('a second open source agrees') }
    else { risk += 1; reasons.push('single source') }
    if (['origin', 'insertion', 'innervatedBy', 'innervates'].includes(rep.kind)) { risk += 1; reasons.push('exam-relevant kind') }
    if (rs.some((r) => partIds.has(r.subject))) { risk += 1; reasons.push('shown on a selectable part') }
    if (!rep.object) { risk += 1; reasons.push('target has no concept id') }
    if (name.includes('object matched to the dataset concept of the same name')) { risk += 1; reasons.push('target matched by name') }
    const ev = evIdx !== undefined ? relationChecks[evIdx]! : undefined
    const subjects = [...new Set(rs.map((r) => r.subject))].sort(compareIds)
    items.set(g, {
      id: g, type: 'relation', risk: Math.max(0, risk), reasons, crossCheck: check, status: 'unreviewed',
      value: {
        kind: rep.kind,
        subject: { id: rep.subject, en: m.concepts.get(rep.subject)?.en, zh: names[rep.subject]?.zh },
        object: { ...(rep.object ? { id: rep.object } : {}), ...rep.objectLabel },
      },
      evidence: { source: rep.source.name, url: rep.source.url, license: rep.source.license, ...(ev?.against ? { secondSource: ev.against, secondSourceSays: ev.theirValue } : {}) },
      members: { count: idx.length, ids: subjects.slice(0, 8) },
    })
  }

  // ---- 签核 / sign-offs
  const rejectedRelations = new Set<number>()
  const unknown: string[] = []
  let applied = 0
  for (const [id, so] of Object.entries(signoffs.items)) {
    const item = items.get(id)
    if (!item || !so.reviewedBy || !so.date || !['accept', 'correct', 'reject'].includes(so.verdict)) {
      unknown.push(id)
      continue
    }
    applied++
    if (item.type === 'name') {
      if (so.verdict === 'reject') continue
      const canon = id.slice(5)
      for (const member of nameGroups.get(id)!) {
        const e = names[member]!
        if (so.verdict === 'correct' && so.corrected?.zh) {
          const c = m.concepts.get(member)
          const side = member === canon || !c ? undefined : sideOfConcept(member, c.en)
          e.zh = (side === 'left' ? '左' : side === 'right' ? '右' : '') + so.corrected.zh
          e.zhSource = 'reviewer'
        }
        e.status = 'reviewed'
      }
      item.status = 'reviewed'
    } else {
      for (const i of relGroups.get(id)!) {
        const r = relations[i]!
        if (so.verdict === 'reject') { rejectedRelations.add(i); continue }
        if (so.verdict === 'correct') {
          if (so.corrected?.objectLabelZh && r.kind !== 'innervates') r.objectLabel = { ...r.objectLabel, zh: so.corrected.objectLabelZh }
          if (so.corrected?.objectLabelEn && r.kind !== 'innervates') r.objectLabel = { ...r.objectLabel, en: so.corrected.objectLabelEn }
        }
        r.status = 'reviewed'
      }
      item.status = so.verdict === 'reject' ? 'unreviewed' : 'reviewed'
    }
  }

  const queue = [...items.values()].sort((a, b) => b.risk - a.risk || (a.type === b.type ? 0 : a.type === 'name' ? -1 : 1) || (a.id < b.id ? -1 : 1))
  const count = (pred: (q: QueueItem) => boolean) => queue.filter(pred).length
  const stats = {
    nameItems: count((q) => q.type === 'name'),
    relationItems: count((q) => q.type === 'relation'),
    signOffs: { inFile: Object.keys(signoffs.items).length, applied, unknownOrInvalidIds: unknown },
    reviewed: { nameItems: count((q) => q.type === 'name' && q.status === 'reviewed'), relationItems: count((q) => q.type === 'relation' && q.status === 'reviewed') },
    riskHistogram: Object.fromEntries([...new Set(queue.map((q) => q.risk))].sort((a, b) => b - a).map((r) => [r, { names: count((q) => q.risk === r && q.type === 'name'), relations: count((q) => q.risk === r && q.type === 'relation') }])),
  }
  return { queue, rejectedRelations, stats }
}
