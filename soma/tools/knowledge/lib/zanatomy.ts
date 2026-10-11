// Bone-level muscle attachments from the Z-Anatomy atlas (CC BY-SA 4.0): which bone an
// origin / insertion patch of the atlas lies on, by a nearest-surface test in the atlas's frame
// (data/raw/z-anatomy/out/import/attachments.json, built by tools/zanatomy).
//
// Artist-modelled and unvalidated. Wikidata / Wikipedia statements stay primary; a patch adds a
// relation only
//   (a) when the muscle has no relation of that kind at all, or
//   (b) when no existing relation of that kind points at that bone or at a part of it
//       (so the bone-level target, which is a selectable part, is not a duplicate).
// Patches whose labelling or bone contradicts standard anatomy are listed in
// lexicon/zanatomy-rejects.ts and never emitted.
import { existsSync, readFileSync } from 'node:fs'
import type { NameEntry } from '../../../src/anatomy/types.ts'
import { ZANATOMY_GROUPS, ZANATOMY_REJECTS } from '../lexicon/zanatomy-rejects.ts'
import { loadTree, type Tree } from './bp3d.ts'
import { sideOfConcept, stripSide, type Model } from './model.ts'
import { ZANATOMY_ATTACHMENTS } from './paths.ts'
import type { BuiltRelation } from './relations.ts'

export const ZANATOMY_SOURCE = 'Z-Anatomy (attachment patch on bone, by geometry)'
export const ZANATOMY_URL = 'https://github.com/Z-Anatomy'
export const ZANATOMY_LICENSE = 'CC BY-SA 4.0'
/** A bone must carry at least this fraction of a patch to be named (patches may span bones). */
export const MIN_BONE_SHARE = 0.25

interface Patch {
  id: string
  muscle: string
  side: 'L' | 'R' | 'M'
  kind: 'origin' | 'insertion'
  muscleFma: string | null
  muscleFmaUnsided: string | null
  bones: { name: string; side: string; fma: string | null; share: number }[]
  onBone: boolean
}

const PART_RE = /^(?:.+ )?(?:head|part|belly) of (.+)$/
const cleanName = (s: string) => s.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim()
const bareMuscle = (s: string) => cleanName(s).replace(/ muscle\b/g, '').replace(/\s+/g, ' ').trim()

export interface ZanatomyReport {
  available: boolean
  patches: number
  minBoneShare: number
  addedNoExistingRelation: number
  addedBoneNotYetTargeted: number
  addedOwnPatch: number
  addedViaWholeMuscle: number
  skipped: Record<string, number>
  rejectedPatches: { muscle: string; kind: string; bones: string; patches: number; reason: string }[]
}

export function buildZanatomyAttachments(
  m: Model, names: Record<string, NameEntry>, existing: BuiltRelation[],
): { relations: BuiltRelation[]; report: ZanatomyReport } {
  const report: ZanatomyReport = {
    available: existsSync(ZANATOMY_ATTACHMENTS), patches: 0, minBoneShare: MIN_BONE_SHARE,
    addedNoExistingRelation: 0, addedBoneNotYetTargeted: 0, addedOwnPatch: 0, addedViaWholeMuscle: 0,
    skipped: {}, rejectedPatches: [],
  }
  if (!report.available) return { relations: [], report }
  const patches = (JSON.parse(readFileSync(ZANATOMY_ATTACHMENTS, 'utf8')) as { attachments: Patch[] }).attachments
  report.patches = patches.length
  const skip = (why: string) => (report.skipped[why] = (report.skipped[why] ?? 0) + 1)

  // part-of hierarchy (BodyParts3D list + dataset trees) to recognise "a part of that bone"
  const partOf: Tree = loadTree('partof')
  for (const [child, parent] of m.dataset.partOfEdges) {
    const ps = partOf.parents.get(child) ?? partOf.parents.set(child, []).get(child)!
    if (!ps.includes(parent)) ps.push(parent)
  }
  const wholes = (id: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length) {
      const n = stack.pop()!
      for (const p of [...(partOf.parents.get(n) ?? []), ...(m.isa.parents.get(n) ?? [])]) if (!seen.has(p)) { seen.add(p); stack.push(p) }
    }
    return seen
  }

  // sided muscle concepts of the dataset by "side|bare name", and named parts by "side|whole"
  const bySidedName = new Map<string, string[]>()
  const partsOfWhole = new Map<string, string[]>()
  for (const c of m.concepts.values()) {
    if (!m.muscleLike.has(c.fma)) continue
    const side = sideOfConcept(c.fma, c.en)
    if (!side) continue
    const bare = stripSide(c.en).replace(/ muscle$/, '')
    ;(bySidedName.get(`${side}|${bare}`) ?? bySidedName.set(`${side}|${bare}`, []).get(`${side}|${bare}`)!).push(c.fma)
    const whole = PART_RE.exec(bare)?.[1]
    if (whole) (partsOfWhole.get(`${side}|${whole}`) ?? partsOfWhole.set(`${side}|${whole}`, []).get(`${side}|${whole}`)!).push(c.fma)
  }

  const have = new Map<string, BuiltRelation[]>()
  for (const r of existing) {
    if (r.kind !== 'origin' && r.kind !== 'insertion') continue
    const k = `${r.subject}|${r.kind}`
    ;(have.get(k) ?? have.set(k, []).get(k)!).push(r)
  }

  const rejected = new Map<string, { muscle: string; kind: string; bones: Set<string>; patches: number; reason: string }>()
  const out: BuiltRelation[] = []
  const emitted = new Set<string>()

  for (const p of patches) {
    const muscle = cleanName(p.muscle)
    const bones = p.bones.filter((b) => b.share >= MIN_BONE_SHARE)
    const rej = ZANATOMY_REJECTS.find((r) => r.muscle === muscle && r.kind === p.kind && (!r.bone || bones.some((b) => b.name.toLowerCase().includes(r.bone!))))
    if (rej) {
      const k = `${muscle}|${p.kind}|${rej.bone ?? ''}`
      const e = rejected.get(k) ?? rejected.set(k, { muscle: p.muscle, kind: p.kind, bones: new Set(), patches: 0, reason: rej.reason }).get(k)!
      e.patches++
      for (const b of bones) e.bones.add(b.name)
      continue
    }
    if (!p.muscleFma) { skip('patch without a muscle id'); continue }
    if (!p.onBone || !bones.length) { skip('patch not on bone (fascia, tendon, skin)'); continue }
    if (p.side !== 'L' && p.side !== 'R') { skip('unsided patch'); continue }
    const side = p.side === 'L' ? 'left' : 'right'

    // subjects: the muscle itself, else (qualified) its named parts / group members
    const bare = bareMuscle(p.muscle)
    const unsidedNames = new Set<string>([bare])
    for (const id of [p.muscleFmaUnsided, p.muscleFma]) {
      const en = id && (m.concepts.get(id)?.en ?? m.itemsByFma.get(id)?.[0]?.en)
      if (en) unsidedNames.add(stripSide(en).replace(/ muscle$/, ''))
    }
    const own = new Set<string>()
    if (m.concepts.has(p.muscleFma) && m.muscleLike.has(p.muscleFma)) own.add(p.muscleFma)
    const minted = p.muscleFmaUnsided && `${p.muscleFmaUnsided}_${p.side}`
    if (minted && m.concepts.has(minted)) own.add(minted)
    for (const n of unsidedNames) for (const f of bySidedName.get(`${side}|${n}`) ?? []) own.add(f)
    const viaWhole = new Map<string, string>() // subject -> whole name
    if (!own.size) {
      for (const n of unsidedNames) {
        for (const f of partsOfWhole.get(`${side}|${n}`) ?? []) viaWhole.set(f, n)
        for (const member of ZANATOMY_GROUPS[n] ?? []) {
          for (const f of bySidedName.get(`${side}|${member}`) ?? []) viaWhole.set(f, n)
          for (const f of partsOfWhole.get(`${side}|${member}`) ?? []) viaWhole.set(f, n)
        }
      }
    }
    if (!own.size && !viaWhole.size) { skip('muscle not in the dataset'); continue }

    for (const b of bones) {
      const bone = b.fma && m.concepts.has(b.fma) ? b.fma : undefined
      if (!bone) { skip('bone not a concept of the dataset'); continue }
      if (sideOfConcept(bone, m.concepts.get(bone)!.en) && sideOfConcept(bone, m.concepts.get(bone)!.en) !== side) { skip('bone on the other side'); continue }
      const boneWholes = wholes(bone)
      for (const [subject, whole] of [...[...own].map((s) => [s, undefined] as const), ...viaWhole]) {
        const key = `${subject}|${p.kind}|${bone}`
        if (emitted.has(key)) continue
        const prior = have.get(`${subject}|${p.kind}`) ?? []
        // already pointing at this bone, at a part of it, or at something this bone is part of
        if (prior.some((r) => r.object && (r.object === bone || wholes(r.object).has(bone) || boneWholes.has(r.object)))) { skip('existing relation already resolves to this bone'); continue }
        // a part with its own statement does not also take the whole muscle's patch
        if (whole && prior.some((r) => r.via !== 'whole')) { skip('part has its own statement'); continue }
        emitted.add(key)
        const zh = names[bone]?.zh
        out.push({
          subject,
          kind: p.kind,
          object: bone,
          objectLabel: { en: m.concepts.get(bone)!.en, ...(zh ? { zh } : {}) },
          source: {
            name: whole ? `${ZANATOMY_SOURCE}; patch of the whole muscle "${whole}", may not apply to this part` : ZANATOMY_SOURCE,
            url: ZANATOMY_URL,
            license: ZANATOMY_LICENSE,
          },
          status: 'unreviewed',
          via: whole ? 'whole' : 'zanatomy',
        })
        if (prior.length) report.addedBoneNotYetTargeted++
        else report.addedNoExistingRelation++
        if (whole) report.addedViaWholeMuscle++
        else report.addedOwnPatch++
      }
    }
  }
  report.rejectedPatches = [...rejected.values()].map((e) => ({ muscle: e.muscle, kind: e.kind, bones: [...e.bones].sort().join(', '), patches: e.patches, reason: e.reason }))
  return { relations: out, report }
}
