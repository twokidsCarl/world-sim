// System / tissue classification of BodyParts3D elements.
//
// Signals, strongest first:
//   isa     the names of every IS-A concept containing the element (its ancestor chain)
//   partOf  the names of every PART-OF concept containing the element (only ~56% of elements)
//   name    the element's own English name — last resort only
// Rules are evaluated top to bottom and the first match wins, so specific exceptions sit above
// the broad category they carve out of. A rule may combine signals (all given ones must match).

import type { SystemId, TissueId } from '../../src/anatomy/types.ts'

export interface ClassifyInput {
  name: string
  /** IS-A ancestor concept names, most specific first. */
  isa: string[]
  /** PART-OF ancestor concept names; empty when the element is not in that tree. */
  partOf: string[]
}

export type Signal = 'isa' | 'partOf' | 'name' | 'none'

export interface Classification {
  system: SystemId
  tissue: TissueId
  /** Label of the rule that fired ("unmatched" for the fallback). */
  rule: string
  /** Weakest signal the rule relied on. */
  signal: Signal
}

type Matcher = string | RegExp | (string | RegExp)[]

export interface Rule {
  label: string
  isa?: Matcher
  partOf?: Matcher
  name?: RegExp
  system: SystemId
  tissue: TissueId
}

const matches = (m: Matcher, values: string[]): boolean => {
  if (Array.isArray(m)) return m.some((one) => matches(one, values))
  if (typeof m === 'string') return values.includes(m)
  return values.some((v) => m.test(v))
}

// prettier-ignore
export const RULES: Rule[] = [
  // ── Immaterial entities (spaces, lines) — placed with the organ they belong to ──────────────
  { label: 'heart cavity', isa: 'cavity of cardiac chamber', system: 'cardiovascular', tissue: 'space' },
  { label: 'lacrimal lake', isa: 'lacrimal lake', system: 'nervous', tissue: 'space' },
  { label: 'CSF space', isa: ['anatomical conduit space', 'subdivision of subarachnoid space'], system: 'nervous', tissue: 'space' },
  // raphes are modelled as "anatomical lines" but are fibrous seams muscles attach to
  { label: 'raphe', isa: 'anatomical line', system: 'muscular', tissue: 'tendon' },

  // ── Vessels (before the heart: coronary vessels are part-of the heart) ──────────────────────
  { label: 'artery', isa: ['segment of arterial tree organ', 'arterial tree organ', 'set of arteries', 'arterial anastomosis', 'zone of artery'], system: 'cardiovascular', tissue: 'artery' },
  { label: 'vein', isa: ['segment of venous tree organ', 'venous tree organ', 'set of veins', 'venous anastomosis', 'zone of vein'], system: 'cardiovascular', tissue: 'vein' },

  // ── Heart ───────────────────────────────────────────────────────────────────────────────────
  { label: 'heart valve', isa: ['cusp of cardiac valve', 'leaf of cardiac valve'], system: 'cardiovascular', tissue: 'heart' },
  { label: 'heart wall', isa: ['region of wall of heart', 'region of papillary muscle', /^region of .*papillary muscle/], system: 'cardiovascular', tissue: 'heart' },
  { label: 'heart (part-of)', partOf: 'heart', system: 'cardiovascular', tissue: 'heart' },

  // ── Endocrine glands that sit in other IS-A branches ───────────────────────────────────────
  { label: 'pineal', isa: 'pineal body', system: 'endocrine', tissue: 'gland' },
  { label: 'pituitary', isa: 'pituitary gland', system: 'endocrine', tissue: 'gland' },
  { label: 'adrenal', isa: 'adrenal gland', system: 'endocrine', tissue: 'gland' },
  { label: 'thyroid', isa: ['thyroid gland', 'parathyroid gland'], system: 'endocrine', tissue: 'gland' },

  // ── Nervous system ──────────────────────────────────────────────────────────────────────────
  { label: 'dura mater', isa: 'region of dura mater', system: 'nervous', tissue: 'fascia' },
  { label: 'ventricular system', isa: ['region of ventricular system of neuraxis', 'region of wall of ventricular system of neuraxis'], system: 'nervous', tissue: 'brain' },
  // the optic chiasm and tracts are filed as "nerve trunk" but are CNS white matter
  { label: 'optic chiasm/tract', isa: ['optic chiasm', 'optic tract'], system: 'nervous', tissue: 'brain' },
  { label: 'nerve', isa: ['segment of neural tree organ', 'neural tree organ', 'subdivision of nervous system', 'ganglion'], system: 'nervous', tissue: 'nerve' },
  { label: 'neuraxis', isa: ['segment of neuraxis', 'cell part cluster of neuraxis', 'organ component of neuraxis', /\bneuraxis$/], system: 'nervous', tissue: 'brain' },
  { label: 'nervous (part-of)', partOf: 'nervous system', system: 'nervous', tissue: 'brain' },

  // ── Muscular system ─────────────────────────────────────────────────────────────────────────
  // FMA files the Achilles tendon under "skeletal ligament"
  { label: 'calcaneal tendon', isa: 'calcaneal tendon', system: 'muscular', tissue: 'tendon' },
  { label: 'tendon', isa: ['tendon', 'common tendinous ring', 'decussation'], system: 'muscular', tissue: 'tendon' },
  { label: 'muscle', isa: ['muscle organ', 'head of muscle organ', 'zone of muscle organ', 'musculature', /^(ascending|descending|transverse) part of trapezius$/], system: 'muscular', tissue: 'muscle' },
  { label: 'fascia', isa: ['zone of investing fascia', 'retinaculum', /\bfascia\b/], system: 'muscular', tissue: 'fascia' },
  { label: 'check ligament', isa: /^check ligament of/, system: 'muscular', tissue: 'ligament' },

  // ── Eye and lacrimal apparatus (sense organ, grouped with the nervous system) ───────────────
  { label: 'lacrimal gland', isa: 'lacrimal gland', system: 'nervous', tissue: 'gland' },
  { label: 'eye', isa: [/eyeball$/, 'lens', 'suspensory ligament of lens', 'vitreous body', 'segment of lacrimal duct', 'region of retina', 'region of ciliary body'], system: 'nervous', tissue: 'organ' },
  { label: 'eyelid', isa: 'tarsal plate of eyelid', system: 'integumentary', tissue: 'fascia' },

  // ── Digestive system pieces that would otherwise match skeletal / generic rules ─────────────
  { label: 'tooth', isa: 'tooth', system: 'digestive', tissue: 'tooth' },

  // ── Larynx and nose: cartilage / ligaments of the airway, not of joints ─────────────────────
  { label: 'airway cartilage', isa: ['laryngeal cartilage', 'nasal cartilage'], system: 'respiratory', tissue: 'cartilage' },
  { label: 'epiglottis', isa: 'epiglottis', system: 'respiratory', tissue: 'cartilage' },
  { label: 'laryngeal ligament', isa: ['conus elasticus', 'thyrohyoid membrane', 'vocal ligament', /^(median |lateral )?(cricothyroid|thyrohyoid|hyo-epiglottic|thyro-epiglottic) ligament$/], system: 'respiratory', tissue: 'ligament' },

  // ── Skeletal system ─────────────────────────────────────────────────────────────────────────
  { label: 'bone', isa: ['bone organ', 'zone of bone organ'], system: 'skeletal', tissue: 'bone' },
  { label: 'cartilage', isa: ['cartilage organ', 'cartilage organ component'], system: 'skeletal', tissue: 'cartilage' },
  { label: 'ligament', isa: ['ligament organ', 'ligament organ component', 'interosseous membrane'], system: 'skeletal', tissue: 'ligament' },
  { label: 'skeletal (part-of)', partOf: 'sternum', system: 'skeletal', tissue: 'bone' },
  // release 3.0 parts the 4.0 IS-A tree does not know: its "muscular system" branch. Above the
  // regional part-of rules because the 3.0 tree also files face muscles under mouth / nose.
  { label: 'muscular (3.0 tree)', partOf: 'muscular system', system: 'muscular', tissue: 'muscle' },

  // ── Respiratory ─────────────────────────────────────────────────────────────────────────────
  { label: 'airway', isa: ['segment of tracheobronchial tree', 'tracheobronchial tree', 'trachea', 'lung'], system: 'respiratory', tissue: 'organ' },
  { label: 'respiratory (part-of)', partOf: 'respiratory system', system: 'respiratory', tissue: 'organ' },

  // ── Digestive ───────────────────────────────────────────────────────────────────────────────
  { label: 'digestive gland', isa: ['salivary gland', 'pancreas', 'parenchyma of pancreas'], system: 'digestive', tissue: 'gland' },
  { label: 'peritoneum', isa: 'region of peritoneum', system: 'digestive', tissue: 'fascia' },
  { label: 'gut', isa: ['zone of small intestine', 'segment of large intestine', 'segment of biliary tree', 'bile duct', 'hepatovenous subsector', 'gingiva', 'tongue', 'lip', 'taenia coli'], system: 'digestive', tissue: 'organ' },
  { label: 'digestive (part-of)', partOf: 'alimentary system', system: 'digestive', tissue: 'organ' },

  // ── Urinary, reproductive, lymphatic, integumentary ─────────────────────────────────────────
  { label: 'urinary (part-of)', partOf: 'urinary system', system: 'urinary', tissue: 'organ' },
  { label: 'genital gland', isa: ['prostate', 'testis', 'seminal vesicle'], system: 'reproductive', tissue: 'gland' },
  { label: 'genital', isa: ['deferent duct', 'epididymis', 'cavernous organ', 'zone of cavernous organ'], system: 'reproductive', tissue: 'organ' },
  { label: 'genital (part-of)', partOf: 'genital system', system: 'reproductive', tissue: 'organ' },
  { label: 'lymphoid organ', isa: ['spleen', 'lobe of thymus', 'thymus', 'lymph node', 'tonsil'], system: 'lymphatic', tissue: 'organ' },
  { label: 'hair', isa: ['hair', 'set of hairs', 'skin appendage'], system: 'integumentary', tissue: 'skin' },
  { label: 'skin', isa: ['skin', 'external ear'], system: 'integumentary', tissue: 'skin' },
  { label: 'integument (part-of)', partOf: ['integumentary system', 'integument'], system: 'integumentary', tissue: 'skin' },

  // ── System names of the release 3.0 "conventional" tree (parts imported from 3.0 whose concept
  //    is unknown to the 4.0 IS-A tree only have these to go by) ────────────────────────────────
  { label: 'articular (3.0 tree)', partOf: 'articular system', system: 'skeletal', tissue: 'ligament' },
  { label: 'skeletal (3.0 tree)', partOf: 'skeletal system', system: 'skeletal', tissue: 'bone' },
  { label: 'lymphoid (3.0 tree)', partOf: 'lymphoid system', system: 'lymphatic', tissue: 'organ' },
  { label: 'endocrine (3.0 tree)', partOf: 'endocrine system', system: 'endocrine', tissue: 'gland' },
  { label: 'sense organ (3.0 tree)', partOf: 'sense organ system', system: 'nervous', tissue: 'organ' },

  // ── Last resort: the element's own name ─────────────────────────────────────────────────────
  { label: 'name: artery', name: /\b(artery|arteries|arterial|aorta)\b/i, system: 'cardiovascular', tissue: 'artery' },
  { label: 'name: vein', name: /\b(veins?|venous|vena)\b/i, system: 'cardiovascular', tissue: 'vein' },
  { label: 'name: nerve', name: /\b(nerves?|ganglion)\b/i, system: 'nervous', tissue: 'nerve' },
  { label: 'name: muscle', name: /\bmuscles?\b/i, system: 'muscular', tissue: 'muscle' },
  { label: 'name: bone', name: /\bbones?\b/i, system: 'skeletal', tissue: 'bone' },
]

export function classify(input: ClassifyInput, rules: Rule[] = RULES): Classification {
  for (const r of rules) {
    if (r.isa !== undefined && !matches(r.isa, input.isa)) continue
    if (r.partOf !== undefined && !matches(r.partOf, input.partOf)) continue
    if (r.name !== undefined && !r.name.test(input.name)) continue
    const signal: Signal = r.name ? 'name' : r.partOf ? 'partOf' : r.isa ? 'isa' : 'none'
    return { system: r.system, tissue: r.tissue, rule: r.label, signal }
  }
  return { system: 'other', tissue: 'other', rule: 'unmatched', signal: 'none' }
}

/** Side from the name when it says so, otherwise from geometry (see `sideOf`). */
export function sideFromName(name: string): 'L' | 'R' | null {
  const l = /\bleft\b/i.test(name)
  const r = /\bright\b/i.test(name)
  if (l && !r) return 'L'
  if (r && !l) return 'R'
  // Both named ("Right anterior branch of ... left coronary artery"): let geometry decide.
  return null
}

/** Half-width of the band around x = 0 treated as the midline, metres. */
export const MIDLINE_TOLERANCE = 0.005

/**
 * Side of a part. The name wins; otherwise a part whose bounds straddle the midline band, or
 * whose centroid lies inside it, is midline; otherwise the sign of the centroid x (left is +X).
 */
export function sideOf(
  name: string,
  centroid: readonly number[],
  bbox: readonly number[],
  tol = MIDLINE_TOLERANCE,
): 'L' | 'R' | 'M' {
  const named = sideFromName(name)
  if (named) return named
  const cx = centroid[0]!
  if (Math.abs(cx) <= tol) return 'M'
  if (bbox[0]! < -tol && bbox[3]! > tol) return 'M'
  return cx > 0 ? 'L' : 'R'
}
