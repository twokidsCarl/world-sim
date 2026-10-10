// Parsers for the BodyParts3D tab-separated tables and the ontology structures built from them.

import type { Concept } from '../../src/anatomy/types.ts'

/** Parse a tab-separated table with a header row. Tolerates CRLF, a BOM and blank lines. */
export function parseTsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = (lines.shift() ?? '').split('\t').map((s) => s.trim())
  const rows: string[][] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    rows.push(line.split('\t').map((s) => s.trim()))
  }
  return { header, rows }
}

export interface Ontology {
  root: string
  name: Map<string, string>
  parent: Map<string, string | null>
  children: Map<string, string[]>
  /** concept id -> full (transitive) set of element ids */
  elements: Map<string, Set<string>>
  /** element id -> concept ids that contain it, most specific (smallest element set) first */
  conceptsOf: Map<string, string[]>
}

/**
 * Build an ontology from an inclusion-relation table (parent id, parent name, child id, child name)
 * and an element-parts table (concept id, name, element id).
 */
export function buildOntology(relationsTsv: string, elementPartsTsv: string): Ontology {
  const name = new Map<string, string>()
  const parent = new Map<string, string | null>()
  const children = new Map<string, string[]>()
  for (const r of parseTsv(relationsTsv).rows) {
    const [pid, pname, cid, cname] = r
    if (!pid || !cid) continue
    name.set(pid, pname ?? pid)
    name.set(cid, cname ?? cid)
    if (parent.has(cid) && parent.get(cid) !== pid) {
      throw new Error(`concept ${cid} has more than one parent (${parent.get(cid)}, ${pid})`)
    }
    parent.set(cid, pid)
    let list = children.get(pid)
    if (!list) children.set(pid, (list = []))
    if (!list.includes(cid)) list.push(cid)
  }
  const roots = [...name.keys()].filter((id) => !parent.has(id))
  const elements = new Map<string, Set<string>>()
  for (const r of parseTsv(elementPartsTsv).rows) {
    const [cid, cname, el] = r
    if (!cid || !el) continue
    if (!name.has(cid)) name.set(cid, cname ?? cid)
    let set = elements.get(cid)
    if (!set) elements.set(cid, (set = new Set()))
    set.add(el)
  }
  // Concepts that carry elements but never appear in the relation table become extra roots.
  for (const cid of elements.keys()) if (!parent.has(cid) && !roots.includes(cid)) roots.push(cid)
  if (roots.length === 0) throw new Error('ontology has no root')
  for (const r of roots) parent.set(r, null)
  // Pick the root with the most elements as "the" root; the rest stay as parentless concepts.
  roots.sort((a, b) => (elements.get(b)?.size ?? 0) - (elements.get(a)?.size ?? 0))

  const conceptsOf = new Map<string, string[]>()
  for (const [cid, set] of elements) {
    for (const el of set) {
      let list = conceptsOf.get(el)
      if (!list) conceptsOf.set(el, (list = []))
      list.push(cid)
    }
  }
  const depth = (id: string): number => {
    let d = 0
    for (let p = parent.get(id); p; p = parent.get(p)) d++
    return d
  }
  for (const list of conceptsOf.values()) {
    list.sort(
      (a, b) => (elements.get(a)?.size ?? 0) - (elements.get(b)?.size ?? 0) || depth(b) - depth(a) || (a < b ? -1 : 1),
    )
  }
  return { root: roots[0]!, name, parent, children, elements, conceptsOf }
}

/** Elements attached directly to a concept: its full set minus everything its children cover. */
export function directParts(onto: Ontology, conceptId: string): string[] {
  const own = onto.elements.get(conceptId)
  if (!own) return []
  const covered = new Set<string>()
  for (const c of onto.children.get(conceptId) ?? []) {
    for (const el of onto.elements.get(c) ?? []) covered.add(el)
  }
  return [...own].filter((el) => !covered.has(el)).sort()
}

/**
 * Emit the tree as contract Concepts, parents before children, keeping only concepts that have at
 * least one of `keep` beneath them. Part lists are restricted to `keep`.
 */
export function emitConcepts(onto: Ontology, keep: Set<string>): Concept[] {
  const out: Concept[] = []
  const alive = (id: string): boolean => {
    for (const el of onto.elements.get(id) ?? []) if (keep.has(el)) return true
    return false
  }
  const roots = [...onto.parent.entries()].filter(([, p]) => p === null).map(([id]) => id)
  roots.sort((a, b) => (a === onto.root ? -1 : b === onto.root ? 1 : a < b ? -1 : 1))
  const queue = roots.filter(alive)
  const seen = new Set<string>(queue)
  while (queue.length) {
    const id = queue.shift()!
    out.push({
      id,
      name: onto.name.get(id) ?? id,
      parent: onto.parent.get(id) ?? null,
      parts: directParts(onto, id).filter((el) => keep.has(el)),
    })
    const kids = [...(onto.children.get(id) ?? [])].sort((a, b) =>
      (onto.name.get(a) ?? a).localeCompare(onto.name.get(b) ?? b, 'en'),
    )
    for (const c of kids) {
      if (seen.has(c) || !alive(c)) continue
      seen.add(c)
      queue.push(c)
    }
  }
  return out
}
