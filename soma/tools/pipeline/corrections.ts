// Corrections for labelling errors in the BodyParts3D source, found by the pipeline's
// "named side disagrees with the centroid" check and verified against the geometry.
// Keep this list short and evidence-based; everything here is echoed in the run report.

/**
 * Element pairs whose labels (name, concept id, tree membership) are swapped in the source:
 * "Left X" lies wholly on the body's right (x < 0) and its "Right X" twin wholly on the left.
 * These are the only pairs where BOTH twins contradict their name, which separates them from
 * organ-relative names ("right coronary artery", "left hepatic duct") where only one does.
 *   FJ1469  / FJ1469M  flexor pollicis brevis (x ≈ ∓0.28 m; FJ1469 coincides with FJ1514
 *                      "Superficial head of right flexor pollicis brevis")
 *   FJ1735  / FJ1736   brachium of superior colliculus
 *   FJ2754  / FJ2742   middle pharyngeal constrictor (the superior and inferior constrictors
 *                      on either side of it are labelled correctly)
 *   FJ3493  / FJ3589   ascending lumbar vein
 */
export const SWAPPED_LABELS: [string, string][] = [
  ['FJ1469', 'FJ1469M'],
  ['FJ1735', 'FJ1736'],
  ['FJ2754', 'FJ2742'],
  ['FJ3493', 'FJ3589'],
]

/**
 * Elements filed under the wrong concept with no twin to swap with: given the right name and
 * concept (and moved in the trees).
 * FJ2190 is labelled "Right fibular vein" (FMA44885) but lies in the left lower limb
 * (x ≈ +0.08 m); FMA has "left fibular vein" (FMA44886).
 */
export const RELABELLED: Record<string, { name: string; fma: string }> = {
  FJ2190: { name: 'Left fibular vein', fma: 'FMA44886' },
}

/** Side forced from geometry where the name is wrong and nothing above applies. Currently none. */
export const SIDE_OVERRIDES: Record<string, 'L' | 'R' | 'M'> = {}
