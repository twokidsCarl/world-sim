// BodyParts3D 源数据中标注错误的修正；这些错误由管线的“名称所指侧别与质心不符”检查发现，
// 并已对照几何核实。此列表应保持简短且有据可依；这里的每一项都会在运行报告中列出。
// Corrections for labelling errors in the BodyParts3D source, found by the pipeline's
// "named side disagrees with the centroid" check and verified against the geometry.
// Keep this list short and evidence-based; everything here is echoed in the run report.

/**
 * 源数据中标签（名称、概念 id、树中归属）互换的元素对：
 * “Left X”整体位于身体右侧（x < 0），而它的“Right X”孪生件整体位于左侧。
 * 只有这些元素对是两个孪生件都与名称矛盾，这使它们区别于以器官为参照的名称
 * （"right coronary artery"、"left hepatic duct"），后者只有一侧矛盾。
 *   FJ1469  / FJ1469M  拇短屈肌 flexor pollicis brevis（x ≈ ∓0.28 m；FJ1469 与 FJ1514
 *                      "Superficial head of right flexor pollicis brevis" 重合）
 *   FJ1735  / FJ1736   上丘臂 brachium of superior colliculus
 *   FJ2754  / FJ2742   咽中缩肌 middle pharyngeal constrictor（其两侧的咽上、咽下缩肌标注正确）
 *   FJ3493  / FJ3589   腰升静脉 ascending lumbar vein
 *
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
 * 归入了错误概念、且没有孪生件可互换的元素：赋予正确的名称与概念（并在树中移动）。
 * FJ2190 标注为 "Right fibular vein"（FMA44885），但位于左下肢（x ≈ +0.08 m）；
 * FMA 中有 "left fibular vein"（FMA44886）。
 *
 * Elements filed under the wrong concept with no twin to swap with: given the right name and
 * concept (and moved in the trees).
 * FJ2190 is labelled "Right fibular vein" (FMA44885) but lies in the left lower limb
 * (x ≈ +0.08 m); FMA has "left fibular vein" (FMA44886).
 */
export const RELABELLED: Record<string, { name: string; fma: string }> = {
  FJ2190: { name: 'Left fibular vein', fma: 'FMA44886' },
}

/**
 * 名称有误且以上各项都不适用时，按几何强制指定的侧别。目前没有。
 * Side forced from geometry where the name is wrong and nothing above applies. Currently none.
 */
export const SIDE_OVERRIDES: Record<string, 'L' | 'R' | 'M'> = {}
