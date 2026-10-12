// 一副人体的 AnatomyData 加上可选的知识层，在内存里建的各种索引。纯数据：没有 three.js，没有 DOM；单元测试在 tests/graph*.test.ts。
// In-memory indexes over one body's AnatomyData plus the optional knowledge layer.
// Pure data: no three.js, no DOM — unit-tested in tests/graph*.test.ts.

import type {
  AnatomyData,
  Concept,
  NameEntry,
  Part,
  Provenance,
  Relation,
  RelationKind,
  ReviewStatus,
  SourceInfo,
  SystemId,
  Vec3,
} from './types.ts'

export type TreeKind = 'isa' | 'partOf'
export const TREE_KINDS: readonly TreeKind[] = ['isa', 'partOf']

export type Bounds = [number, number, number, number, number, number]

export interface DisplayName {
  /** 主界面（中文）用的最佳名称：有中文用中文，否则用英文。 */
  /** Best name for the primary (Chinese) UI: zh when known, else English. */
  primary: string
  en: string
  zh?: string
  la?: string
  /** 知识层名称的审校状态；没有条目时为 undefined。 */
  /** Review status of the knowledge-layer name; undefined when there is no entry. */
  status?: ReviewStatus
  /**
   * 知识层的名称属于比该部件更宽的概念时设置（见 AnatomyGraph.partName）：部件保留自己的名称，这里给出那个更宽的概念。
   * Set when the knowledge-layer name belongs to a broader concept than the part (see
   * `AnatomyGraph.partName`): the part then keeps its own name and this is shown beneath it.
   */
  broader?: { zh?: string; en: string }
}

export interface SearchResult {
  kind: 'part' | 'concept'
  /** 部件 id，或概念（FMA）id。 */
  /** Part id, or concept (FMA) id. */
  id: string
  /** 概念所在的树（只有概念类结果才有）。 */
  /** Tree the concept was found in (concept results only). */
  tree?: TreeKind
  fma: string
  name: DisplayName
  /** 选这个结果会选中多少个部件。 */
  /** Number of parts selecting this result would select. */
  partCount: number
  score: number
}

interface TreeIndex {
  byId: Map<string, Concept>
  children: Map<string, Concept[]>
  roots: Concept[]
  /** 部件 id → 直接列出它的最深概念的 id */
  /** part id -> id of the deepest concept that lists it directly */
  conceptOfPart: Map<string, string>
  descendants: Map<string, readonly string[]>
  covered: number
}

interface SearchEntry {
  kind: 'part' | 'concept'
  id: string
  tree?: TreeKind
  fma: string
  en: string
  /** 归一化后的检索串：英文、中文、拉丁文、FMA 编号、部件 id */
  /** normalised haystacks: en, zh, la, fma id, part id */
  fields: string[]
  partCount: number
}

/** 同一来源类别的部件，再按几何所来自的数据集细分。 */
/** Parts of one provenance kind, broken down by the dataset their geometry came from. */
export interface ProvenanceGroup {
  provenance: Provenance
  count: number
  /** ordinal 是该来源在本类别里的序号（用来选颜色深浅）。 */
  /** `ordinal` numbers the sources within this provenance (used to pick a colour shade). */
  sources: { info: SourceInfo; count: number; ordinal: number }[]
}

export const PROVENANCE_ORDER: readonly Provenance[] = ['scanned', 'warped', 'curated']

const UNKNOWN_SOURCE: SourceInfo = { name: '未声明来源', url: '', license: '', attribution: '' }

/** 是否为真正的 FMA 编号（如 FMA59763）；管线也会自己造概念 id。 */
/** True for a real FMA identifier ("FMA59763"); pipelines also mint synthetic concept ids. */
export function isFmaId(id: string): boolean {
  return /^FMA\d+$/.test(id)
}

const EMPTY: readonly string[] = Object.freeze([])

export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim()
}

export class AnatomyGraph {
  readonly data: AnatomyData
  readonly parts: readonly Part[]
  readonly names: Readonly<Record<string, NameEntry>>
  readonly relations: readonly Relation[]
  readonly hasKnowledge: boolean

  private readonly partIndex = new Map<string, number>()
  private readonly bySystem = new Map<SystemId, Part[]>()
  private readonly byFma = new Map<string, Part[]>()
  private readonly trees: Record<TreeKind, TreeIndex>
  private readonly relBySubject = new Map<string, Relation[]>()
  private searchEntries: SearchEntry[] | null = null
  private _bodyBounds: Bounds | null = null
  private _provenance: ProvenanceGroup[] | null = null

  constructor(data: AnatomyData, names?: Record<string, NameEntry> | null, relations?: Relation[] | null) {
    this.data = data
    this.parts = data.parts
    this.names = names ?? {}
    this.relations = relations ?? []
    this.hasKnowledge = !!names || !!relations

    data.parts.forEach((p, i) => {
      this.partIndex.set(p.id, i)
      push(this.bySystem, p.system, p)
      push(this.byFma, p.fma, p)
    })
    this.trees = {
      isa: this.buildTree(data.trees.isa),
      partOf: this.buildTree(data.trees.partOf),
    }
    for (const r of this.relations) push(this.relBySubject, r.subject, r)
  }

  // ------------------------------------------------------------ 部件
  // ------------------------------------------------------------ parts

  part(id: string): Part | undefined {
    const i = this.partIndex.get(id)
    return i === undefined ? undefined : this.parts[i]
  }

  /** 部件在 parts 里的位置（稳定，用于类型化数组里的状态）；没有则为 -1。 */
  /** Position of the part in `parts` (stable; used for typed-array state), or -1. */
  indexOf(id: string): number {
    return this.partIndex.get(id) ?? -1
  }

  partsBySystem(system: SystemId): readonly Part[] {
    return this.bySystem.get(system) ?? []
  }

  partsByFma(fma: string): readonly Part[] {
    return this.byFma.get(fma) ?? []
  }

  /** 部件几何所来自的数据集（Part.source，缺省为第一个来源）。 */
  /** The dataset a part's geometry came from (`Part.source`, defaulting to the first source). */
  sourceOf(p: Part): SourceInfo {
    const sources = this.data.sources
    return (p.source !== undefined ? sources.find((s) => s.name === p.source) : sources[0]) ?? sources[0] ?? UNKNOWN_SOURCE
  }

  /** 部件的来源在同类别来源中的序号。 */
  /** Ordinal of the part's source among the sources sharing its provenance. */
  sourceOrdinal(p: Part): number {
    const g = this.provenanceGroups().find((x) => x.provenance === p.provenance)
    const name = this.sourceOf(p).name
    return g?.sources.find((x) => x.info.name === name)?.ordinal ?? 0
  }

  /** 按来源类别和数据集统计的部件数，顺序固定（扫描、配准、人工）。 */
  /** Part counts by provenance and source, in a fixed order (scanned, warped, curated). */
  provenanceGroups(): readonly ProvenanceGroup[] {
    if (this._provenance) return this._provenance
    const groups = new Map<Provenance, Map<string, { info: SourceInfo; count: number }>>()
    for (const p of this.parts) {
      let g = groups.get(p.provenance)
      if (!g) groups.set(p.provenance, (g = new Map()))
      const info = this.sourceOf(p)
      const e = g.get(info.name)
      if (e) e.count++
      else g.set(info.name, { info, count: 1 })
    }
    const order = this.data.sources.map((x) => x.name)
    const rank = (n: string) => (order.indexOf(n) < 0 ? order.length : order.indexOf(n))
    const out: ProvenanceGroup[] = []
    for (const prov of [...PROVENANCE_ORDER, ...[...groups.keys()].filter((k) => !PROVENANCE_ORDER.includes(k))]) {
      const g = groups.get(prov)
      if (!g) continue
      const sources = [...g.values()]
        .sort((a, b) => rank(a.info.name) - rank(b.info.name))
        .map((x, ordinal) => ({ ...x, ordinal }))
      out.push({ provenance: prov, count: sources.reduce((a, x) => a + x.count, 0), sources })
    }
    return (this._provenance = out)
  }

  /** 在这副人体中确实存在的相邻部件（悬空的 id 被丢弃）。 */
  /** Adjacent parts that actually exist in this body (dangling ids are dropped). */
  adjacentParts(id: string): Part[] {
    const p = this.part(id)
    if (!p) return []
    const out: Part[] = []
    for (const a of p.adjacent) {
      const q = this.part(a)
      if (q) out.push(q)
    }
    return out
  }

  /** 给定部件的合并包围盒；一个都不存在时为 null。 */
  /** Union bounds of the given parts, or null when none of them exist. */
  bounds(ids: Iterable<string>): Bounds | null {
    const b: Bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    let any = false
    for (const id of ids) {
      const p = this.part(id)
      if (!p) continue
      any = true
      for (let k = 0; k < 3; k++) {
        if (p.bbox[k]! < b[k]!) b[k] = p.bbox[k]!
        if (p.bbox[k + 3]! > b[k + 3]!) b[k + 3] = p.bbox[k + 3]!
      }
    }
    return any ? b : null
  }

  get bodyBounds(): Bounds {
    if (!this._bodyBounds) {
      this._bodyBounds = this.bounds(this.parts.map((p) => p.id)) ?? [-0.5, 0, -0.5, 0.5, 1.8, 0.5]
    }
    return this._bodyBounds
  }

  // ------------------------------------------------------------ 树
  // ------------------------------------------------------------ trees

  concept(tree: TreeKind, id: string): Concept | undefined {
    return this.trees[tree].byId.get(id)
  }

  roots(tree: TreeKind): readonly Concept[] {
    return this.trees[tree].roots
  }

  children(tree: TreeKind, id: string): readonly Concept[] {
    return this.trees[tree].children.get(id) ?? []
  }

  conceptCount(tree: TreeKind): number {
    return this.trees[tree].byId.size
  }

  /** 这棵树覆盖到的不同部件数（partOf 本来就只覆盖一部分）。 */
  /** Number of distinct parts the tree reaches (partOf is partial by design). */
  coverage(tree: TreeKind): number {
    return this.trees[tree].covered
  }

  /** 概念的祖先，最近的父节点在前，根在最后；不含概念自己。 */
  /** Ancestors of a concept, nearest parent first, root last. Excludes the concept itself. */
  ancestors(tree: TreeKind, id: string): Concept[] {
    const t = this.trees[tree]
    const out: Concept[] = []
    const seen = new Set<string>([id])
    let cur = t.byId.get(id)
    while (cur && cur.parent !== null) {
      if (seen.has(cur.parent)) break // defensive: cyclic data
      seen.add(cur.parent)
      const p = t.byId.get(cur.parent)
      if (!p) break
      out.push(p)
      cur = p
    }
    return out
  }

  /** 根 → 概念（含两端）；概念不在树里时为空。 */
  /** Root → concept, inclusive. Empty when the concept is not in the tree. */
  path(tree: TreeKind, id: string): Concept[] {
    const c = this.trees[tree].byId.get(id)
    if (!c) return []
    return [...this.ancestors(tree, id).reverse(), c]
  }

  /** 直接列出该部件的概念（树覆盖到这个部件时）。 */
  /** The concept that lists this part directly, if the tree covers the part. */
  conceptOfPart(tree: TreeKind, partId: string): Concept | undefined {
    const t = this.trees[tree]
    const cid = t.conceptOfPart.get(partId)
    return cid === undefined ? undefined : t.byId.get(cid)
  }

  /** 根 → 持有该部件的概念；树没有覆盖该部件时为空。 */
  /** Root → the concept holding the part. Empty when the tree does not cover the part. */
  partChain(tree: TreeKind, partId: string): Concept[] {
    const c = this.conceptOfPart(tree, partId)
    return c ? this.path(tree, c.id) : []
  }

  /** 概念之下的全部部件 id：它自己的加上所有后代的。有缓存。 */
  /** All part ids under a concept: its own plus every descendant's. Memoised. */
  descendantParts(tree: TreeKind, id: string): readonly string[] {
    const t = this.trees[tree]
    const hit = t.descendants.get(id)
    if (hit) return hit
    const root = t.byId.get(id)
    if (!root) return EMPTY
    const out: string[] = []
    const seenParts = new Set<string>()
    const seen = new Set<string>()
    const stack: Concept[] = [root]
    while (stack.length) {
      const c = stack.pop()!
      if (seen.has(c.id)) continue
      seen.add(c.id)
      for (const p of c.parts) {
        if (this.partIndex.has(p) && !seenParts.has(p)) {
          seenParts.add(p)
          out.push(p)
        }
      }
      const kids = t.children.get(c.id)
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
    }
    t.descendants.set(id, out)
    return out
  }

  /** 概念之下不同部件的个数（一个部件可能被几个概念列出）。 */
  /** Number of distinct parts under a concept (a part may be listed by several concepts). */
  partCount(tree: TreeKind, id: string): number {
    return this.descendantParts(tree, id).length
  }

  /**
   * 某个 FMA 编号在这副人体中对应的部件：自己带这个编号的部件；否则是 isa 树里该概念之下的全部；再否则是 partOf 树里的。
   * Parts in this body for an FMA id: parts carrying that id themselves, else everything
   * under the concept in the isa tree, else in the partOf tree.
   */
  resolveFma(fma: string): readonly string[] {
    const direct = this.byFma.get(fma)
    if (direct?.length) return direct.map((p) => p.id)
    for (const tree of TREE_KINDS) {
      const d = this.descendantParts(tree, fma)
      if (d.length) return d
    }
    return EMPTY
  }

  // ------------------------------------------------------------ 知识层
  // ------------------------------------------------------------ knowledge

  nameOf(fma: string, en: string): DisplayName {
    const n = this.names[fma]
    const zh = n?.zh || undefined
    return { primary: zh ?? en, en, zh, la: n?.la || undefined, status: n?.status }
  }

  /**
   * Name of a part.
   *  - Names are keyed by concept. When the part's concept is a broader class than the part
   *    itself (its English name is the part's name minus some qualifying words, and it has
   *    sub-concepts — e.g. a supernumerary lumbar vertebra filed under "lumbar vertebra"),
   *    the part keeps its own English name and the concept's name is returned as `broader`,
   *    so a per-part name is never silently replaced by a class name.
   *  - Left/right parts that share one unsided concept id get a zh name without 左/右; the
   *    side is then prefixed from `Part.side`.
   */
  partName(p: Part): DisplayName {
    const n = this.nameOf(p.fma, p.name)
    if (!n.zh) return n
    const concept = this.trees.isa.byId.get(p.fma) ?? this.trees.partOf.byId.get(p.fma)
    if (concept && this.isBroaderConcept(p, concept)) {
      return { primary: p.name, en: p.name, status: n.status, broader: { zh: n.zh, en: concept.name } }
    }
    if (p.side === 'M' || /^[左右]/.test(n.zh)) return n
    const sided = /\b(left|right)\b/i.test(p.name) || (this.byFma.get(p.fma)?.length ?? 0) > 1
    if (!sided) return n
    const zh = (p.side === 'L' ? '左' : '右') + n.zh
    return { ...n, zh, primary: zh }
  }

  /** 概念比自己更宽的部件（见 partName）。 */
  /** Parts whose concept is a broader class (see `partName`). */
  broaderNamedParts(): Part[] {
    return this.parts.filter((p) => !!this.partName(p).broader)
  }

  private isBroaderConcept(p: Part, concept: Concept): boolean {
    const hasSubConcepts = (this.trees.isa.children.get(concept.id)?.length ?? 0) > 0
    if (!hasSubConcepts) return false
    const pt = nameTokens(p.name)
    const ct = nameTokens(concept.name)
    if (pt.size <= ct.size) return false
    for (const t of ct) if (!pt.has(t)) return false
    return true
  }

  /**
   * 皮肤本身的部件 id：皮肤类部件中三角形最多的那个（毛发、眉毛、指甲等附属部件也是"皮肤"组织）。
   * The part id of the skin proper: the skin-tissue part with the most triangles (hair, eyebrows,
   * nails and other appendages are skin tissue too).
   */
  mainSkinId(): string | null {
    let best: Part | null = null
    for (const p of this.parts) if (p.tissue === 'skin' && (!best || p.triangles > best.triangles)) best = p
    return best?.id ?? null
  }

  private unfittedIds: ReadonlySet<string> | null = null

  /**
   * 还没有贴合新皮肤的附属部件（头发、眉毛、阴毛）：皮肤不透明时它们会从皮肤里翘出来，所以那时隐藏。
   * 管线重新拟合之后，把这里改成空集即可。
   * Appendage meshes not yet fitted to the new skins (hair of head, eyebrows, pubic hair): they
   * poke out of an opaque skin, so they are hidden then. Once the pipeline refits them this
   * becomes the empty set.
   */
  unfittedAppendages(): ReadonlySet<string> {
    this.unfittedIds ??= new Set(this.parts.filter((p) => p.system === 'integumentary' && p.tissue === 'skin' && /\bhair\b|eyebrow/i.test(p.name)).map((p) => p.id))
    return this.unfittedIds
  }

  /** 这副人体里用户不该轻信的地方，最重要的在前。 */
  /** What a user should not trust in this body, most important first. */
  get cautions(): readonly { zh: string; en: string }[] {
    return Array.isArray(this.data.cautions) ? this.data.cautions : []
  }

  conceptName(c: Concept): DisplayName {
    return this.nameOf(c.id, c.name)
  }

  relationsFor(fma: string): readonly Relation[] {
    return this.relBySubject.get(fma) ?? []
  }

  /** 某个主体的关系，按种类分组，保持首次出现的顺序。 */
  /** Relations for a subject grouped by kind, in first-seen order. */
  relationsByKind(fma: string): [RelationKind, Relation[]][] {
    const m = new Map<RelationKind, Relation[]>()
    for (const r of this.relationsFor(fma)) push(m, r.kind, r)
    return [...m]
  }

  // ------------------------------------------------------------ 搜索
  // ------------------------------------------------------------ search

  /**
   * 按中文 / 英文 / 拉丁文名称、FMA 编号（带不带 FMA 前缀都行）或部件 id 搜索部件和概念。
   * Search parts and concepts by Chinese / English / Latin name or FMA id (with or without
   * the "FMA" prefix) or part id. Every whitespace-separated token must match somewhere.
   */
  search(query: string, limit = 50): SearchResult[] {
    const q = normalizeText(query)
    if (!q) return []
    const tokens = q.split(/\s+/).filter(Boolean)
    const entries = (this.searchEntries ??= this.buildSearch())
    const scored: { e: SearchEntry; score: number }[] = []
    for (const e of entries) {
      let total = scoreField(e.fields, q)
      if (total === 0 && tokens.length > 1) {
        total = 0
        for (const t of tokens) {
          const s = scoreField(e.fields, t)
          if (s === 0) {
            total = 0
            break
          }
          total += s / tokens.length / 2
        }
      }
      if (total > 0) {
        // 分组排在其成员稍前，这样搜 femur 会先给出包含两侧的那一项
        // groups rank slightly above their members so "femur" offers both sides first
        if (e.kind === 'concept' && e.partCount > 1) total += 2
        scored.push({ e, score: total })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.e.en.length - b.e.en.length || (a.e.en < b.e.en ? -1 : 1))
    return scored.slice(0, limit).map(({ e, score }) => ({
      kind: e.kind,
      id: e.id,
      tree: e.tree,
      fma: e.fma,
      name: e.kind === 'part' ? this.partName(this.part(e.id)!) : this.nameOf(e.fma, e.en),
      partCount: e.partCount,
      score,
    }))
  }

  // ------------------------------------------------------------ 内部
  // ------------------------------------------------------------ internals

  private buildTree(concepts: Concept[]): TreeIndex {
    const byId = new Map<string, Concept>()
    for (const c of concepts) if (!byId.has(c.id)) byId.set(c.id, c)
    const children = new Map<string, Concept[]>()
    const roots: Concept[] = []
    const conceptOfPart = new Map<string, string>()
    for (const c of byId.values()) {
      if (c.parent !== null && c.parent !== c.id && byId.has(c.parent)) push(children, c.parent, c)
      else roots.push(c) // null parent, or a parent missing from this (possibly partial) file
    }
    // 一个部件可能被几个概念列出（BodyParts3D 的 partOf 就是这样）；它自己的概念取最具体的，也就是最深的那个。
    // A part can be listed by several concepts (BodyParts3D's partOf does this); its "own"
    // concept is the most specific one, i.e. the deepest.
    const depthMemo = new Map<string, number>()
    const depth = (c: Concept): number => {
      let d = 0
      const seen = new Set<string>([c.id])
      let cur: Concept | undefined = c
      while (cur && cur.parent !== null && !seen.has(cur.parent)) {
        const known = depthMemo.get(cur.parent)
        if (known !== undefined) {
          d += known + 1
          break
        }
        seen.add(cur.parent)
        cur = byId.get(cur.parent)
        if (cur) d++
      }
      depthMemo.set(c.id, d)
      return d
    }
    const bestDepth = new Map<string, number>()
    for (const c of byId.values()) {
      if (!c.parts.length) continue
      const d = depth(c)
      for (const p of c.parts) {
        if (!this.partIndex.has(p)) continue
        const prev = bestDepth.get(p)
        if (prev === undefined || d > prev) {
          bestDepth.set(p, d)
          conceptOfPart.set(p, c.id)
        }
      }
    }
    const byName = (a: Concept, b: Concept) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    roots.sort(byName)
    for (const list of children.values()) list.sort(byName)

    const t: TreeIndex = { byId, children, roots, conceptOfPart, descendants: new Map(), covered: 0 }
    const covered = new Set<string>()
    for (const c of byId.values()) {
      for (const p of c.parts) if (this.partIndex.has(p)) covered.add(p)
    }
    t.covered = covered.size
    return t
  }

  private buildSearch(): SearchEntry[] {
    const out: SearchEntry[] = []
    const fields = (en: string, fma: string, extra?: string, zh?: string): string[] => {
      const n = this.names[fma]
      const f = [normalizeText(en)]
      if (zh ?? n?.zh) f.push(normalizeText((zh ?? n?.zh)!))
      if (n?.la) f.push(normalizeText(n.la))
      f.push(fma.toLowerCase())
      if (extra) f.push(extra.toLowerCase())
      return f
    }
    for (const p of this.parts) {
      out.push({ kind: 'part', id: p.id, fma: p.fma, en: p.name, fields: fields(p.name, p.fma, p.id, this.partName(p).zh ?? this.partName(p).broader?.zh), partCount: 1 })
    }
    const seen = new Set<string>()
    for (const tree of TREE_KINDS) {
      for (const c of this.trees[tree].byId.values()) {
        if (seen.has(c.id)) continue
        const count = this.partCount(tree, c.id)
        // 只是某一个部件自己的概念的那种概念，已经作为那个部件列出了。
        // A concept that is just one part's own concept is already listed as that part.
        if (count <= 1 && (this.byFma.get(c.id)?.length ?? 0) >= 1) continue
        // 哪棵树给这个概念的部件更多就用哪棵。
        // Prefer whichever tree gives the concept more parts.
        const other: TreeKind = tree === 'isa' ? 'partOf' : 'isa'
        const otherCount = this.partCount(other, c.id)
        const use = otherCount > count ? other : tree
        seen.add(c.id)
        out.push({
          kind: 'concept',
          id: c.id,
          tree: use,
          fma: c.id,
          en: c.name,
          fields: fields(c.name, c.id),
          partCount: Math.max(count, otherCount),
        })
      }
    }
    return out
  }
}

const NAME_STOPWORDS = new Set(['of', 'the', 'set', 'left', 'right', 'a', 'and'])

/** 英文解剖名称里的实词：小写、变单数，去掉左右侧和虚词。 */
/** Content words of an English anatomical name: lower-cased, singularised, side and filler words dropped. */
export function nameTokens(name: string): Set<string> {
  const out = new Set<string>()
  for (const t of name.toLowerCase().replace(/\([ivx]+\)/g, ' ').split(/[^a-z0-9]+/)) {
    if (t && !NAME_STOPWORDS.has(t)) out.add(t.replace(/s$/, ''))
  }
  return out
}

/**
 * 把一组部件从一副人体带到另一副：另一副有相同概念 id 和侧别的就用它，否则用相同的部件 id（带或不带前缀）。
 * Carry a set of parts from one body to another: same concept id and side where the other
 * body has one, else the same part id with or without the warped-copy prefix ("W_").
 */
export function mapPartsBetween(from: AnatomyGraph, to: AnatomyGraph, ids: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const p = from.part(id)
    if (!p) continue
    const same = to.partsByFma(p.fma)
    const sided = same.filter((q) => q.side === p.side)
    const hits = sided.length ? sided : same
    if (hits.length) {
      for (const q of hits) out.add(q.id)
      continue
    }
    for (const alt of [id, `W_${id}`, id.replace(/^W_/, '')]) {
      if (to.part(alt)) {
        out.add(alt)
        break
      }
    }
  }
  return [...out]
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k)
  if (l) l.push(v)
  else m.set(k, [v])
}

function scoreField(fields: string[], q: string): number {
  let best = 0
  const digits = /^\d+$/.test(q)
  for (const f of fields) {
    let s = 0
    // a leading 左/右 is a side marker, not part of the name: "乳头" should find "左乳头"
    // ahead of "乳头体"
    const unsided = /^[左右]/.test(f) && !/^[左右]/.test(q) ? f.slice(1) : null
    if (f === q) s = 100
    else if (unsided === q) s = 95
    else if (f.startsWith(q)) s = 80
    else if (unsided?.startsWith(q)) s = 78
    else {
      const i = f.indexOf(q)
      if (i > 0) s = /[\s\-_(/,]/.test(f[i - 1]!) ? 60 : 40
    }
    // 纯数字按 FMA 编号查：59763 应当精确命中 fma59763
    // a bare number is an FMA id lookup: "59763" should hit "fma59763" exactly
    if (digits && f === `fma${q}`) s = 100
    if (s > best) best = s
  }
  return best
}

/** 包围盒的中心。 */
/** Centre of a bounds box. */
export function boundsCenter(b: Bounds): Vec3 {
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]
}
