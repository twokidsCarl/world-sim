// Loaders for the BodyParts3D concept lists and trees (read-only inputs).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import { ANATOMY_DIR, BODIES, BP3D_DIR, CACHE_DIR } from './paths.ts'

/** Orders concept ids: FMA ids numerically, then synthetic ids (e.g. "ZAC_...") alphabetically. */
export function compareIds(a: string, b: string): number {
  const na = /^FMA(\d+)$/.exec(a)
  const nb = /^FMA(\d+)$/.exec(b)
  if (na && nb) return Number(na[1]) - Number(nb[1])
  if (na) return -1
  if (nb) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

export interface Bp3dConcept {
  /** Concept id. Usually an FMA id; datasets may also carry synthetic ids where FMA has no class. */
  fma: string
  en: string
  /** Japanese name (kanji), when the source really has one (it echoes the English otherwise). */
  ja?: string
  inIsa: boolean
  inPartOf: boolean
  /** True when the concept is absent from the BodyParts3D 4.0 lists and known only from an anatomy.json. */
  datasetOnly?: boolean
}

function tsv(name: string): string[][] {
  return readFileSync(resolve(BP3D_DIR, name), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split('\t'))
}

const hasCjk = (s: string) => /[぀-ヿ一-鿿]/.test(s)

export function loadConcepts(): Map<string, Bp3dConcept> {
  const out = new Map<string, Bp3dConcept>()
  for (const [file, key] of [
    ['isa_parts_list.txt', 'inIsa'],
    ['partof_parts_list.txt', 'inPartOf'],
  ] as const) {
    for (const [fma, , en, kanji] of tsv(file)) {
      if (!fma || !en) continue
      const c = out.get(fma) ?? { fma, en, inIsa: false, inPartOf: false }
      c[key] = true
      if (!c.ja && kanji && kanji !== en && hasCjk(kanji)) c.ja = kanji
      out.set(fma, c)
    }
  }
  return out
}

export interface Tree {
  parents: Map<string, string[]>
  children: Map<string, string[]>
}

export function loadTree(kind: 'isa' | 'partof'): Tree {
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const [p, , c] of tsv(`${kind}_inclusion_relation_list.txt`)) {
    if (!p || !c) continue
    ;(parents.get(c) ?? parents.set(c, []).get(c)!).push(p)
    ;(children.get(p) ?? children.set(p, []).get(p)!).push(c)
  }
  return { parents, children }
}

export function descendants(tree: Tree, root: string): Set<string> {
  const seen = new Set<string>()
  const stack = [...(tree.children.get(root) ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    stack.push(...(tree.children.get(n) ?? []))
  }
  return seen
}

export function ancestors(tree: Tree, node: string): Set<string> {
  const seen = new Set<string>()
  const stack = [...(tree.parents.get(node) ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    stack.push(...(tree.parents.get(n) ?? []))
  }
  return seen
}

/**
 * The concept each element mesh (FJxxxx.obj) represents by itself.
 * Authoritative source is the "# Concept ID" header of each OBJ; a few files have it blank, and
 * for those we fall back to the deepest concept that the element list maps to exactly that file.
 */
export function loadElementConcepts(): { concepts: Set<string>; fromHeader: number; fromFallback: number; unresolved: number } {
  const cacheFile = resolve(CACHE_DIR, 'bp3d-element-headers.json')
  let headers: Record<string, string>
  if (existsSync(cacheFile)) {
    headers = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } else {
    headers = {}
    const grab = (text: string) => {
      let file: string | undefined
      for (const line of text.split('\n')) {
        const m = /^# (File ID|Concept ID) : ?(\S*)/.exec(line)
        if (!m) continue
        if (m[1] === 'File ID') file = m[2]
        else if (file && !(file in headers && headers[file])) headers[file] = m[2] ?? ''
      }
    }
    const zip = resolve(BP3D_DIR, 'isa_BP3D_4.0_obj_99.zip')
    if (existsSync(zip)) {
      const out = execFileSync('sh', ['-c', `unzip -p "${zip}" | LC_ALL=C grep -a -E '^# (File ID|Concept ID) :'`], {
        maxBuffer: 64 * 1024 * 1024,
      })
      grab(out.toString('utf8'))
    }
    const dir = resolve(BP3D_DIR, 'partof_BP3D_4.0_obj_99')
    if (existsSync(dir)) {
      const buf = Buffer.alloc(2048)
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.obj')) continue
        const fd = openSync(resolve(dir, f), 'r')
        const n = readSync(fd, buf, 0, buf.length, 0)
        closeSync(fd)
        grab(buf.subarray(0, n).toString('utf8'))
      }
    }
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(headers))
  }

  const fileConcepts = new Map<string, Set<string>>()
  const conceptFiles = new Map<string, Set<string>>()
  for (const kind of ['isa', 'partof'] as const) {
    for (const [fma, , file] of tsv(`${kind}_element_parts.txt`)) {
      if (!fma || !file) continue
      ;(fileConcepts.get(file) ?? fileConcepts.set(file, new Set()).get(file)!).add(fma)
      ;(conceptFiles.get(fma) ?? conceptFiles.set(fma, new Set()).get(fma)!).add(file)
    }
  }
  const isa = loadTree('isa')
  const concepts = new Set<string>()
  let fromHeader = 0
  let fromFallback = 0
  let unresolved = 0
  for (const [file, cs] of fileConcepts) {
    const h = headers[file]
    if (h && /^FMA\d+$/.test(h)) {
      concepts.add(h)
      fromHeader++
      continue
    }
    const own = [...cs].filter((c) => conceptFiles.get(c)!.size === 1)
    // deepest: no is-a child of it is also in `own`
    const leaf = own.filter((c) => !(isa.children.get(c) ?? []).some((k) => own.includes(k)))
    if (leaf.length >= 1) {
      concepts.add(leaf.sort()[0]!)
      fromFallback++
    } else unresolved++
  }
  return { concepts, fromHeader, fromFallback, unresolved }
}

/**
 * What the generated datasets (public/anatomy/<body>/anatomy.json) actually contain: the FMA id
 * of every part, and every concept of the two trees. The geometry pipeline imports structures
 * from sources other than BodyParts3D 4.0, so this, not the 4.0 lists alone, defines the scope.
 */
export interface Dataset {
  bodies: string[]
  /** FMA id -> English name (tree name preferred: it is lower-case like the 4.0 lists). */
  names: Map<string, string>
  /** FMA ids that are a part's own concept, per body. */
  partFmas: Map<string, Set<string>>
  /** child -> parent edges of trees.isa */
  isaEdges: [string, string][]
  /** Ids named for one side but used by parts of both sides; their side word was dropped. */
  sharedSidedIds: { id: string; name: string }[]
}

export function loadDataset(): Dataset {
  const out: Dataset = { bodies: [], names: new Map(), partFmas: new Map(), isaEdges: [], sharedSidedIds: [] }
  const sides = new Map<string, Set<string>>()
  for (const body of BODIES) {
    const file = resolve(ANATOMY_DIR, body, 'anatomy.json')
    if (!existsSync(file)) continue
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      parts: { fma: string; name: string; side?: string }[]
      trees: Record<'isa' | 'partOf', { id: string; name: string; parent: string | null }[]>
    }
    out.bodies.push(body)
    const fmas = new Set<string>()
    for (const c of [...(data.trees.isa ?? []), ...(data.trees.partOf ?? [])]) {
      if (c.id && c.name && !out.names.has(c.id)) out.names.set(c.id, c.name)
    }
    for (const c of data.trees.isa ?? []) if (c.parent && c.id) out.isaEdges.push([c.id, c.parent])
    for (const p of data.parts) {
      if (!p.fma) continue
      fmas.add(p.fma)
      if (!out.names.has(p.fma)) out.names.set(p.fma, p.name.toLowerCase())
      if (p.side) (sides.get(p.fma) ?? sides.set(p.fma, new Set()).get(p.fma)!).add(p.side)
    }
    out.partFmas.set(body, fmas)
  }
  // One id used by both a left and a right part cannot be named "left ...": drop the side word
  // (the UI adds the side from Part.side) and remember the id for the report.
  for (const [id, s] of sides) {
    const name = out.names.get(id)
    if (!name || !s.has('L') || !s.has('R')) continue
    const hits = name.match(/\b(left|right)\b/gi) ?? []
    if (hits.length !== 1) continue
    out.sharedSidedIds.push({ id, name })
    out.names.set(id, name.replace(/\b(left|right)\b/i, '').replace(/\s+/g, ' ').trim())
  }
  return out
}
