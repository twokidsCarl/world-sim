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

/**
 * BodyParts3D 3.0 中两个文件的几何互相放错的概念对：文件名（概念 id）与名称表一致，但文件里的网格是对方的。
 * 修正方式是在读入时互换两者的网格；概念 id、名称、部件 id（R3_ + 概念 id）都不动，
 * 所以按 FMA 编号或部件 id 关联的下游数据（名称、起止点、神经支配）不用改，改的只是每个 id 下的形状。
 *
 * 眼轮匝肌的眶部与睑部（左右各一对）。解剖上睑部在眼睑内、覆于睑板之上，是内环；眶部环绕眶缘，是外环。
 * 3.0 的文件正相反（在 3.0 原始坐标里按眼球中心量冠状面内的半径，毫米）：
 *   FMA46782.obj "orbital part of right orbicularis oculi"    宽×高 32.6 × 23.4，面积 11.8 cm²，平均半径 12.0（5.0–16.7）
 *   FMA46785.obj "palpebral part of right orbicularis oculi"  宽×高 42.8 × 48.1，面积 34.7 cm²，平均半径 19.0（10.8–27.0）
 *   FMA46783.obj "orbital part of left …"                     32.7 × 23.4，11.8 cm²，平均半径 12.2（5.1–17.3）
 *   FMA46786.obj "palpebral part of left …"                   42.9 × 48.1，34.6 cm²，平均半径 19.0（10.5–27.5）
 * 移入 4.0 人体后，与 4.0 自带的睑板（FJ1324、FJ1328、FJ1375、FJ1379）比较：睑板表面有 92–95 % 位于
 * 名为“眶部”的那个环 3 mm 以内（中位距离 1.2–1.4 mm），而只有 25–28 % 位于名为“睑部”的环 3 mm 以内
 * （中位 4.3–4.4 mm）。名称表（parts_list_e.txt）、层级表（conventional_part_of.txt 把睑部归在上、下睑之下）
 * 本身没有错，本项目的导入也只是照文件名取名，没有互换——错在源数据把网格放进了对方的文件。
 *
 * Concept pairs of BodyParts3D 3.0 whose two files hold each other's geometry: the file name (the
 * concept id) agrees with the name table, but the mesh inside is the other one's. The correction
 * swaps the two meshes on loading; concept ids, names and part ids (R3_ + concept id) stay as they
 * are, so downstream data keyed on FMA ids or part ids (names, attachments, innervation) needs no
 * change — only the shape under each id changes.
 *
 * Orbital and palpebral parts of orbicularis oculi (one pair per side). Anatomically the palpebral
 * part lies in the eyelids over the tarsal plates and is the inner ring; the orbital part surrounds
 * the orbital margin and is the outer ring. The 3.0 files have it the other way round (radius in
 * the coronal plane about the centre of the eyeball, in the raw 3.0 frame, mm):
 *   FMA46782.obj "orbital part of right orbicularis oculi"    width × height 32.6 × 23.4, area 11.8 cm², mean radius 12.0 (5.0–16.7)
 *   FMA46785.obj "palpebral part of right orbicularis oculi"  width × height 42.8 × 48.1, area 34.7 cm², mean radius 19.0 (10.8–27.0)
 *   FMA46783.obj "orbital part of left …"                     32.7 × 23.4, 11.8 cm², mean radius 12.2 (5.1–17.3)
 *   FMA46786.obj "palpebral part of left …"                   42.9 × 48.1, 34.6 cm², mean radius 19.0 (10.5–27.5)
 * Once warped into the 4.0 body, against the tarsal plates that 4.0 has itself (FJ1324, FJ1328,
 * FJ1375, FJ1379): 92–95 % of the tarsal-plate surface lies within 3 mm of the ring named
 * "orbital part" (median distance 1.2–1.4 mm) and only 25–28 % within 3 mm of the ring named
 * "palpebral part" (median 4.3–4.4 mm). The name table (parts_list_e.txt) and the hierarchy
 * (conventional_part_of.txt files the palpebral part under the upper and lower eyelids) are right,
 * and our import only names a mesh after its file, without swapping anything: the error is in the
 * source, which put each mesh into the other's file.
 */
export const RELEASE3_SWAPPED_GEOMETRY: [string, string][] = [
  ['FMA46782', 'FMA46785'],
  ['FMA46783', 'FMA46786'],
]
