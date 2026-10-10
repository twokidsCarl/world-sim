// relations.json: Wikidata relation statements attached to BodyParts3D concepts.
//
// A statement reaches a BodyParts3D concept C in one of four ways (recorded in source.name):
//   direct      the statement is on C's own Wikidata item (or its species-neutral twin)
//   is-a        it is on an ancestor of C in the BodyParts3D is-a tree
//   laterality  C is "left/right X" (the side may be embedded) and the statement is on the FMA
//               concept named X, or on the unlateralised class Wikidata gives C's item (P279),
//               which the BodyParts3D tree does not link C to
//   whole       C is a named head/part/belly of muscle M ("long head of biceps brachii") and the
//               statement is on M. Origin and insertion are then whole-muscle statements and may
//               not hold for every head.
import type { NameEntry, Relation, RelationKind } from '../../../src/anatomy/types.ts'
import { ancestors, descendants } from './bp3d.ts'
import { sideOf, stripSide, type Model } from './model.ts'
import { RELATION_PROPS } from './wikidata.ts'

export type Via = 'direct' | 'is-a' | 'laterality' | 'whole' | 'wikipedia'

export interface BuiltRelation extends Relation {
  /** Not serialised: how the statement reached the subject. */
  via: Via
}

export interface RelationsResult {
  relations: BuiltRelation[]
  dropped: { nonMuscleSubject: number; noObjectLabel: number; selfReference: number }
  droppedExamples: string[]
}

const MUSCLE_ONLY: RelationKind[] = ['origin', 'insertion', 'antagonist']
const VIA_RANK: Record<Via, number> = { direct: 0, 'is-a': 1, laterality: 2, whole: 3, wikipedia: 4 }
/** is-a ancestors with more BodyParts3D descendants than this do not propagate. */
export const MAX_ISA_FANOUT = 100
const PART_OF_WHOLE = /^(?:.+ )?(?:head|part|belly) of (.+)$/

interface Stmt {
  subjectQid: string
  prop: string
  kind: RelationKind
  objectQid: string
}

export function buildRelations(m: Model, names: Record<string, NameEntry>): RelationsResult {
  // statements grouped by the FMA id(s) of their subject (own id, or via the generic twin)
  const byFma = new Map<string, Stmt[]>()
  for (const s of m.statements) {
    const def = RELATION_PROPS[s.prop]
    if (!def) continue
    const subjQ = m.fmaByItem.has(s.subject) ? s.subject : m.twinFor.get(s.subject)
    if (!subjQ) continue
    for (const fma of m.fmaByItem.get(subjQ) ?? []) {
      ;(byFma.get(fma) ?? byFma.set(fma, []).get(fma)!).push({ subjectQid: s.subject, prop: s.prop, kind: def.kind, objectQid: s.object })
    }
  }

  const nameOfFma = (fma: string) => m.concepts.get(fma)?.en ?? (m.itemsByFma.get(fma)?.[0]?.en ?? fma)

  /** FMA concepts that carry muscle-specific statements: treated as muscles even if absent from BodyParts3D. */
  const wikidataMuscles = new Set<string>()
  for (const [fma, list] of byFma) if (list.some((s) => s.kind === 'origin' || s.kind === 'insertion')) wikidataMuscles.add(fma)
  for (const [fma, items] of m.itemsByFma) if (items.some((i) => /( muscle$|^musculus )/i.test(i.en ?? ''))) wikidataMuscles.add(fma)

  // BodyParts3D concepts indexed by "side|unlateralised name" for object lateralisation
  const sided = new Map<string, string>()
  for (const c of m.concepts.values()) {
    const side = sideOf(c.en)
    if (side) sided.set(`${side}|${stripSide(c.en)}`, c.fma)
  }

  const fanout = new Map<string, number>()
  const descendantCount = (fma: string) => {
    let n = fanout.get(fma)
    if (n === undefined) fanout.set(fma, (n = descendants(m.isa, fma).size))
    return n
  }

  const out: BuiltRelation[] = []
  const dropped = { nonMuscleSubject: 0, noObjectLabel: 0, selfReference: 0 }
  const droppedExamples: string[] = []

  for (const c of [...m.concepts.values()].sort((a, b) => Number(a.fma.slice(3)) - Number(b.fma.slice(3)))) {
    const side = sideOf(c.en)
    const bare = stripSide(c.en)
    const sources: { via: Via; fma: string }[] = [{ via: 'direct', fma: c.fma }]
    const seen = new Set([c.fma])
    const add = (via: Via, fma: string) => {
      if (!seen.has(fma) && byFma.has(fma)) sources.push({ via, fma })
      seen.add(fma)
    }
    for (const a of ancestors(m.isa, c.fma)) {
      // Statements on very broad classes ("artery connects with heart") are not worth repeating
      // on every descendant; they stay on the class itself.
      if (descendantCount(a) > MAX_ISA_FANOUT) seen.add(a)
      else add('is-a', a)
    }
    const bySubclass = new Set<string>()
    if (side) {
      for (const f of m.fmaByName.get(bare) ?? []) add('laterality', f)
      for (const f of m.unsidedOf(c.fma)) {
        if (!seen.has(f)) bySubclass.add(f)
        add('laterality', f)
      }
    }
    let isPartOfMuscle = false
    const whole = PART_OF_WHOLE.exec(bare)?.[1]
    if (whole) {
      for (const f of m.fmaByName.get(whole) ?? []) {
        if (!(m.muscleLike.has(f) || wikidataMuscles.has(f))) continue
        isPartOfMuscle = true
        add('whole', f)
      }
    }
    const muscle = m.muscleLike.has(c.fma) || isPartOfMuscle

    const picked = new Map<string, BuiltRelation>()
    for (const src of sources) {
      for (const s of byFma.get(src.fma) ?? []) {
        if (MUSCLE_ONLY.includes(s.kind) && !muscle) {
          dropped.nonMuscleSubject++
          if (droppedExamples.length < 12 && src.via === 'direct') droppedExamples.push(`${c.en} —${s.kind}→ ${m.enOf(s.objectQid) ?? s.objectQid}`)
          continue
        }
        // resolve the object to an FMA id
        const objItem = m.fmaByItem.has(s.objectQid) ? s.objectQid : m.twinFor.get(s.objectQid)
        const objFmas = objItem ? m.fmaByItem.get(objItem)! : []
        let en = m.enOf(s.objectQid)
        // an item with several FMA ids: prefer the concept its label names, then one in BodyParts3D
        let object =
          objFmas.find((f) => m.concepts.get(f)?.en.toLowerCase() === en?.toLowerCase()) ??
          objFmas.find((f) => m.concepts.has(f)) ??
          objFmas[0]
        let lateralised = false
        if (side) {
          // same-side variant of the object, when BodyParts3D has one
          const candidates = [object && m.concepts.get(object)?.en, en, object && nameOfFma(object)].filter(Boolean) as string[]
          for (const n of candidates) {
            if (sideOf(n)) break
            const hit = sided.get(`${side}|${n.toLowerCase()}`)
            if (hit) {
              object = hit
              en = m.concepts.get(hit)!.en
              lateralised = true
              break
            }
          }
        }
        if (!en) {
          dropped.noObjectLabel++
          continue
        }
        if (object === c.fma) {
          dropped.selfReference++
          continue
        }
        const zh = object && m.concepts.has(object) ? names[object]?.zh : m.zhOf(s.objectQid)?.text
        const from = `${src.fma} "${nameOfFma(src.fma)}"`
        const how =
          src.via === 'direct' ? 'Wikidata'
          : src.via === 'is-a' ? `Wikidata (propagated via BodyParts3D is-a from ${from})`
          : src.via === 'laterality' ? `Wikidata (propagated by laterality ${bySubclass.has(src.fma) ? 'via Wikidata subclass-of' : 'name match'} from ${from})`
          : s.kind === 'origin' || s.kind === 'insertion'
            ? `Wikidata (propagated from whole muscle ${from} to its named part; whole-muscle ${s.kind}, may not apply to this part)`
            : `Wikidata (propagated from whole muscle ${from} to its named part)`
        const rel: BuiltRelation = {
          subject: c.fma,
          kind: s.kind,
          ...(object ? { object } : {}),
          objectLabel: { en, ...(zh ? { zh } : {}) },
          source: {
            name: lateralised ? `${how}; object lateralised to the subject's side` : how,
            url: `https://www.wikidata.org/wiki/${s.subjectQid}#${s.prop}`,
            license: 'CC0 1.0',
          },
          status: 'unreviewed',
          via: src.via,
        }
        const key = `${s.kind}|${object ?? s.objectQid}`
        const prev = picked.get(key)
        if (!prev || VIA_RANK[rel.via] < VIA_RANK[prev.via]) picked.set(key, rel)
      }
    }
    // A part with its own origin/insertion statements does not also inherit the whole muscle's.
    for (const kind of ['origin', 'insertion'] as const) {
      const all = [...picked.entries()].filter(([, r]) => r.kind === kind)
      if (all.some(([, r]) => r.via !== 'whole')) for (const [k, r] of all) if (r.via === 'whole') picked.delete(k)
    }
    out.push(...[...picked.values()].sort((a, b) => (a.kind + (a.object ?? a.objectLabel.en) < b.kind + (b.object ?? b.objectLabel.en) ? -1 : 1)))
  }
  return { relations: out, dropped, droppedExamples }
}
