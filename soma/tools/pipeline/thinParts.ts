// 薄结构（筋膜、浅血管、皮神经、关节囊）收回皮肤之内。男女两个人体共用；每个人体一张规则表（THIN_RULES）。
//
// 这些结构原是照着另一层体表做的（Z-Anatomy 的筋膜是照连成一块的足做的；BodyParts3D 的浅静脉贴着他自己的扫描皮肤），
// 换上按内部结构拟合、并移植了分开的足趾的皮肤之后，有一部分落在皮肤之外。按结构本身是什么来处理：
//   · 小腿筋膜（crural fascia）：小腿的深筋膜，向下续于踝部的支持带（Gray 1918 第 480 页），不到足趾；图谱里那张“袜子”
//     一直包到趾尖、横在趾蹼之间。在趾根（跖趾关节平面）剪掉：比任何别的骨都更靠近趾骨的部分去掉。
//   · 趾（指）的静脉、动脉和神经：起于趾（指）、沿趾（指）的侧面走，在趾蹼处才汇合（Gray 1918 第 671、944 页），
//     所以每一条都应在自己的趾（指）之内：用一个平滑的位移场把它推到皮下。
//   · 其余的深筋膜、腱膜、皮神经和浅静脉：按定义都在皮肤和皮下组织的深面，露在皮肤外是配准的误差：同样推到皮下。
// 位移场：每个顶点（神经是中心线上的点）若在参考皮肤下不足 margin（神经再加上自己的半径），就沿“向内”的方向补足；
// 位移在网格（或中心线）上做拉普拉斯平滑后再补足，如此几轮，最后只补足不平滑，所以结果在顶点上是满足的，过渡是平滑的。
// 神经移动的是中心线，管状网格由中心线重建（与 nerveCourse.ts 相同），nerves.json 与网格保持一致。
//
// 参考皮肤是一张固定的闭合曲面（皮肤包的 skin-closed.obj），由调用方读入并把它的身份（文件的 SHA-1 等）写进报告：
// 结果只取决于内部结构和这张曲面，与皮肤包这一次有没有被装入无关。皮肤包拟合时只看肌、骨、软骨、器官，
// 不看这里移动的薄结构，所以没有循环依赖。margin 留出的余量：下次重新拟合时皮肤移动一两毫米，这些部件仍在皮肤内。
//
// Thin structures (fasciae, superficial vessels, cutaneous nerves, joint capsules) brought back inside the
// skin. Shared by both bodies; one rule table per body (THIN_RULES).
//
// These structures were made for another body surface (the Z-Anatomy fasciae for a one-block foot, the
// superficial veins of BodyParts3D for his own scanned skin). Under the skin fitted to the internals, with
// separate toes grafted on, some of them lie outside it. Each is treated by what the structure is:
//   · crural fascia: the deep fascia of the leg, continuous below with the retinacula at the ankle (Gray
//     1918, p. 480); it does not reach the toes, whereas the atlas "sock" runs to the toe tips and lies
//     across the web spaces. It is clipped at the toe bases (the metatarsophalangeal level): what is nearer
//     to a phalanx than to any other bone is removed.
//   · veins, arteries and nerves of the digits: they arise on the digits, run along their sides and join
//     only at the clefts (Gray 1918, pp. 671, 944), so each must lie inside its own toe or finger: a smooth
//     displacement field takes them under the skin.
//   · the other deep fasciae, aponeuroses, cutaneous nerves and superficial veins: by definition deep to
//     the skin and the subcutaneous tissue, so lying outside the skin is a registration error: the same field.
// The field: a vertex (for a nerve, a centreline point) that lies less than `margin` below the reference
// skin (plus its own radius, for a nerve) is moved inwards by what is missing; the displacement is
// Laplacian-smoothed over the mesh (or the centreline) and topped up again, for a few rounds, the last
// passes topping up only, so the result holds at the vertices and blends smoothly. Nerves move by their
// centrelines and the tubes are rebuilt from them (as in nerveCourse.ts), so nerves.json and the meshes agree.
//
// The reference skin is one fixed closed surface (skin-closed.obj of the skin package), read by the caller,
// who records its identity (SHA-1 of the file and more) in the report: the result depends on the internals
// and on that surface only, not on whether the package is installed in this build. A skin package is fitted
// to muscles, bones, cartilages and organs and never looks at the thin structures moved here, so nothing is
// circular. The margin is what is left for the next re-fit: the skin may move by a millimetre or two and
// these parts stay inside.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compact, measure, type Mesh } from './geometry.ts'
import { components } from './meshRepair.ts'
import { nerveTubes } from './nerveCourse.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'
import { parseSkinObj } from './skinPackage.ts'
import { RobustInside, thinStructuresOutsideSkin } from './thinOutside.ts'
import { simplifyPolyline, type Polyline } from './tube.ts'

// ── 规则 / rules ─────────────────────────────────────────────────────────────────────────────────────

export type ThinAction = 'clipAtToeBases' | 'recourse' | 'inward'

export interface ThinRule {
  key: string
  /** 按名称选部件（男女同名；她的部件只是 id 多一个 W_ 前缀） / parts are chosen by name (the same in both bodies; hers only carry a W_ id prefix) */
  name: RegExp
  /** clipAtToeBases：先在趾根剪掉，再收回皮下；recourse / inward：只用位移场（两者算法相同，名称说明理由不同） / clipAtToeBases: clipped at the toe bases, then taken under the skin; recourse / inward: the field only (one algorithm, the two names tell the reasons apart) */
  action: ThinAction
  reason: { zh: string; en: string }
  /** 打开过的出处；没有就是只凭定义 / the source that was opened; absent = by definition only */
  source?: { name: string; url: string }
}

const GRAY_480 = { name: "Gray's Anatomy, 20th ed. (1918), p. 480, as quoted in Wikipedia “Deep fascia of leg”", url: 'https://en.wikipedia.org/wiki/Deep_fascia_of_leg' }
const GRAY_671 = { name: "Gray's Anatomy, 20th ed. (1918), p. 671, as quoted in Wikipedia “Plantar digital veins” and “Dorsal digital veins of the foot”", url: 'https://en.wikipedia.org/wiki/Plantar_digital_veins' }
const GRAY_944 = { name: "Gray's Anatomy, 20th ed. (1918), p. 944, as quoted in Wikipedia “Superficial branch of radial nerve”", url: 'https://en.wikipedia.org/wiki/Superficial_branch_of_radial_nerve' }

const RULE_CRURAL: ThinRule = {
  key: 'cruralFascia', name: /\bcrural fascia$/i, action: 'clipAtToeBases', source: GRAY_480,
  reason: {
    zh: '小腿筋膜是小腿的深筋膜，向上续于阔筋膜，向下续于踝部的支持带（小腿横韧带和分裂韧带），不延伸到足趾；图谱网格却一直包到趾尖，横在趾蹼之间。在趾根（跖趾关节平面）剪掉，余下的收到皮下。',
    en: 'The crural fascia is the deep fascia of the leg, continuous above with the fascia lata and below with the retinacula at the ankle (transverse crural and laciniate ligaments); it does not extend onto the toes, whereas the atlas mesh wraps the foot to the toe tips and lies across the web spaces. Clipped at the toe bases (metatarsophalangeal level); the rest is taken under the skin.',
  },
}
const RULE_DIGITAL_VESSELS: ThinRule = {
  key: 'digitalVessels', name: /\bdigital (veins?|arter(y|ies))\b|\bmetacarpal vein\b|\bprinceps pollicis\b/i, action: 'recourse', source: GRAY_671,
  reason: {
    zh: '趾（指）的静脉起于趾（指）跖（掌）面的静脉丛，在趾蹼处发出头间静脉与背侧的趾静脉相连，再汇成跖静脉；趾背静脉在趾蹼处汇成趾背总静脉。它们沿各自的趾（指）走，所以应在自己的趾（指）之内。',
    en: 'The digital veins arise from plexuses on the plantar (palmar) surfaces of the digits, send intercapitular veins to the dorsal digital veins at the clefts and unite to form the metatarsal veins; the dorsal digital veins join at the clefts into common digital veins. They run along their own digit, so each must lie inside it.',
  },
}
const RULE_DIGITAL_NERVES: ThinRule = {
  key: 'digitalNerves', name: /\bdigital (branch(es)?|nerves?)\b|\bdorsal branch of ulnar nerve$/i, action: 'recourse', source: GRAY_944,
  reason: {
    zh: '桡神经浅支的指背神经分布到拇指两侧、示指桡侧、示指与中指以及中指与环指的相邻侧的皮肤，尺神经手背支分布到其余的手指：都沿手指侧面的皮下走，所以应在自己的手指（足趾）之内。',
    en: 'The dorsal digital nerves of the superficial branch of the radial nerve supply the skin of both sides of the thumb, the radial side of the index and the adjoining sides of index–middle and middle–ring fingers, and the dorsal branch of the ulnar nerve supplies the remaining fingers: all run under the skin along the sides of the digits, so each must lie inside its own finger (or toe).',
  },
}
const RULE_SHEETS: ThinRule = {
  key: 'fasciaSheets', name: /fascia|aponeurosis|iliotibial tract|retinaculum/i, action: 'inward',
  reason: {
    zh: '深筋膜（包被筋膜）、腱膜和髂胫束都在皮肤和皮下组织的深面；略微露出皮肤（多在 2–3 mm 以内）是图谱配准的误差。用平滑的位移场收到皮下。只凭定义，没有另外打开出处。',
    en: 'Deep (investing) fasciae, aponeuroses and the iliotibial tract lie deep to the skin and the subcutaneous tissue; standing slightly proud of the skin (mostly within 2–3 mm) is an error of the atlas registration. Taken under the skin by a smooth field. By definition only; no further source was opened.',
  },
}
const RULE_REST: ThinRule = {
  key: 'subcutaneous', name: /./, action: 'inward',
  reason: {
    zh: '这里管到的其余薄结构（皮神经、浅静脉和浅动脉、指趾的关节囊和韧带、精索内的血管）都在皮肤的深面；露出皮肤是配准误差，或皮肤拟合时没有顾及它们。用平滑的位移场收到皮下。只凭定义，没有另外打开出处。',
    en: 'Every other thin structure handled here (cutaneous nerves, superficial veins and arteries, capsules and ligaments of the digits, the vessels of the spermatic cord) lies deep to the skin; lying outside it is a registration error, or the skin fit not having considered them. Taken under the skin by a smooth field. By definition only; no further source was opened.',
  },
}

/**
 * 每个人体一张规则表，自上而下第一条匹配的生效。女性的表与男性相同（她的阔筋膜 W_ZAE8457450、W_ZA38D8A0B1 和髂胫束 W_FJ1423M
 * 由 fasciaSheets 一条按名称管到），单独列出是为了以后可以各改各的。
 * One rule table per body; the first matching rule from the top applies. The female table equals the male
 * one (her fascia lata W_ZAE8457450, W_ZA38D8A0B1 and iliotibial tract W_FJ1423M fall under `fasciaSheets`
 * by name); it is listed separately so that each can be changed alone later.
 */
export const THIN_RULES: Record<'male' | 'female', ThinRule[]> = {
  male: [RULE_CRURAL, RULE_DIGITAL_VESSELS, RULE_DIGITAL_NERVES, RULE_SHEETS, RULE_REST],
  female: [RULE_CRURAL, RULE_DIGITAL_VESSELS, RULE_DIGITAL_NERVES, RULE_SHEETS, RULE_REST],
}

/** 这一步管的组织（都不在皮肤拟合之列） / the tissues this stage handles (none of them is part of the skin fit) */
export const THIN_TISSUES = new Set<string>(['fascia', 'vein', 'artery', 'nerve', 'ligament'])

export interface ThinOptions {
  /**
   * 目标深度（米）：处理过的部件每个顶点至少在参考皮肤下这么深。2.5 mm = 重新拟合时皮肤可能移动的一两毫米
   * ＋ 发布的皮肤简化误差上限 0.8 mm 的大半。
   * Target depth (m): every vertex of a treated part ends at least this far under the reference skin.
   * 2.5 mm = the millimetre or two the skin may move on a re-fit plus most of the 0.8 mm bound of the
   * shipped skin's simplification error.
   */
  margin: number
  /**
   * 触发条件：部件有顶点在参考皮肤下不足这么深（米）才处理。小于 margin：本来就在皮下、只是浅的部件不去动它。
   * Trigger: a part is treated only when one of its vertices lies less than this deep under the reference
   * skin (m). Smaller than the margin: parts that are under the skin already, only shallow, are left alone.
   */
  trigger: number
  /** 平滑的轮数和每轮的迭代数 / rounds of smoothing and iterations per round */
  rounds: number
  smoothIterations: number
  /** 神经中心线重采样的间距（米） / resampling step of nerve centrelines (m) */
  nerveStep: number
  /** 剪掉之后丢弃的碎片：面积不到最大连通片的这一比例 / fragments dropped after the clip: area under this share of the largest component */
  fragmentShare: number
  /** 位移不超过此值（米）的部件算没有动 / a part displaced by no more than this (m) counts as unchanged */
  unchanged: number
  /**
   * 三角形内部的检查：重心或边中点在皮肤下不足 chordDepth 的三角形，把它顶点的目标深度加深（不超过 maxDepth），最多 chordPasses 遍。
   * The check inside triangles: where a centroid or an edge midpoint lies less than `chordDepth` under the
   * skin, the target depth of that triangle's vertices is increased (to at most `maxDepth`), for at most
   * `chordPasses` passes.
   */
  chordPasses: number
  chordDepth: number
  maxDepth: number
}

export const THIN_DEFAULTS: ThinOptions = { margin: 0.0025, trigger: 0.0005, rounds: 4, smoothIterations: 8, nerveStep: 0.002, fragmentShare: 0.02, unchanged: 2e-5, chordPasses: 3, chordDepth: 0.0005, maxDepth: 0.007 }

// ── 参考皮肤 / the reference skin ────────────────────────────────────────────────────────────────────

export interface ThinReference {
  mesh: Mesh
  /** 写进报告的身份 / the identity recorded in the report */
  identity: { dir: string; file: string; sha1: string; vertices: number; triangles: number; fittedTo: { body: string; key: string } | null }
}

/**
 * 读参考皮肤：先找开口后的包（<authorDir>-open/skin-closed.obj），没有就用作者的闭合包（<authorDir>/skin.obj）。只读。
 * 不看 fittedTo 是否与本次构建一致（那是“装不装入”的事）；fittedTo 原样记进身份里，由调用方决定用不用。
 * Reads the reference skin: the opened package first (<authorDir>-open/skin-closed.obj), else the author's
 * closed package (<authorDir>/skin.obj). Read-only. Whether fittedTo matches this build is not looked at
 * here (that decides installing); fittedTo goes into the identity as it is and the caller decides.
 */
export function loadThinReference(root: string, authorDir: string): ThinReference | null {
  const base = authorDir.replace(/\/+$/, '')
  for (const [dir, file] of [[`${base}-open`, 'skin-closed.obj'], [base, 'skin.obj']] as const) {
    const f = join(root, dir, file)
    const mf = join(root, dir, 'manifest.json')
    if (!existsSync(f) || !existsSync(mf)) continue
    const bytes = readFileSync(f)
    const mesh = parseSkinObj(bytes.toString('utf8'))
    let fittedTo: { body: string; key: string } | null = null
    try {
      const ft = (JSON.parse(readFileSync(mf, 'utf8')) as { fittedTo?: { body?: string; key?: string } }).fittedTo
      if (ft?.body && ft.key) fittedTo = { body: ft.body, key: ft.key }
    } catch {
      fittedTo = null
    }
    return { mesh, identity: { dir, file, sha1: createHash('sha1').update(bytes).digest('hex'), vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, fittedTo } }
  }
  return null
}

// ── 有符号深度场 / the signed depth field ────────────────────────────────────────────────────────────

/** 点到三角形的最近点（Ericson, Real-Time Collision Detection 5.1.5），写入 out / closest point on a triangle (Ericson 5.1.5), written to `out` */
function closestOnTriangle(px: number, py: number, pz: number, v: Float32Array, a: number, b: number, c: number, out: Float64Array): void {
  const ax = v[a]!, ay = v[a + 1]!, az = v[a + 2]!
  const bx = v[b]!, by = v[b + 1]!, bz = v[b + 2]!
  const cx = v[c]!, cy = v[c + 1]!, cz = v[c + 2]!
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az
    return
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz
    return
  }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3)
    out[0] = ax + t * abx; out[1] = ay + t * aby; out[2] = az + t * abz
    return
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz
    return
  }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6)
    out[0] = ax + t * acx; out[1] = ay + t * acy; out[2] = az + t * acz
    return
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6))
    out[0] = bx + t * (cx - bx); out[1] = by + t * (cy - by); out[2] = bz + t * (cz - bz)
    return
  }
  const den = 1 / (va + vb + vc)
  const s = vb * den
  const t = vc * den
  out[0] = ax + abx * s + acx * t; out[1] = ay + aby * s + acy * t; out[2] = az + abz * s + acz * t
}

/**
 * 闭合皮肤的有符号深度（正 = 在皮肤内）和“向内”的方向。三角形装在均匀网格里；内外用三向射线奇偶（RobustInside）。
 * Signed depth under a closed skin (positive = inside) and the inward direction. Triangles are binned in a
 * uniform grid; inside/outside is the three-ray parity vote (RobustInside).
 */
export class SkinField {
  private readonly p: Float32Array
  private readonly idx: Uint32Array
  private readonly o: [number, number, number]
  private readonly n: [number, number, number]
  private readonly start: Uint32Array
  private readonly tris: Uint32Array
  private readonly inside: RobustInside
  /** 三角形法向朝外为 +1，朝内为 −1（由所围体积的符号定） / +1 when triangle normals point outwards, −1 when inwards (from the sign of the enclosed volume) */
  private readonly outward: number
  private readonly q = new Float64Array(3)

  constructor(skin: Mesh, private readonly cell = 0.004) {
    const p = (this.p = skin.positions)
    const idx = (this.idx = skin.indices)
    const st = measure(skin)
    this.outward = st.signedVolume >= 0 ? 1 : -1
    const b = st.bbox
    this.o = [b[0] - cell, b[1] - cell, b[2] - cell]
    this.n = [0, 1, 2].map((k) => Math.floor((b[k + 3]! - b[k]! + 2 * cell) / cell) + 1) as [number, number, number]
    const cells = this.n[0] * this.n[1] * this.n[2]
    const counts = new Uint32Array(cells + 1)
    const span = (t: number): [number, number, number, number, number, number] => {
      const r: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0]
      for (let k = 0; k < 3; k++) {
        const v0 = p[3 * idx[t]! + k]!, v1 = p[3 * idx[t + 1]! + k]!, v2 = p[3 * idx[t + 2]! + k]!
        r[k] = Math.floor((Math.min(v0, v1, v2) - this.o[k]!) / cell)
        r[k + 3] = Math.floor((Math.max(v0, v1, v2) - this.o[k]!) / cell)
      }
      return r
    }
    for (let t = 0; t < idx.length; t += 3) {
      const r = span(t)
      for (let k = r[2]; k <= r[5]; k++) for (let j = r[1]; j <= r[4]; j++) for (let i = r[0]; i <= r[3]; i++) counts[i + this.n[0] * (j + this.n[1] * k) + 1] = counts[i + this.n[0] * (j + this.n[1] * k) + 1]! + 1
    }
    for (let c = 0; c < cells; c++) counts[c + 1] = counts[c + 1]! + counts[c]!
    this.start = counts
    this.tris = new Uint32Array(counts[cells]!)
    const fill = counts.slice(0, cells)
    for (let t = 0; t < idx.length; t += 3) {
      const r = span(t)
      for (let k = r[2]; k <= r[5]; k++) for (let j = r[1]; j <= r[4]; j++) for (let i = r[0]; i <= r[3]; i++) {
        const c = i + this.n[0] * (j + this.n[1] * k)
        this.tris[fill[c]!] = t
        fill[c] = fill[c]! + 1
      }
    }
    this.inside = new RobustInside(skin)
  }

  contains(x: number, y: number, z: number): boolean {
    return this.inside.contains(x, y, z)
  }

  /**
   * 写入 out = [深度, 向内方向 x, y, z]。皮肤面在 reach 之外时：在皮肤内返回 false（足够深，out 不写）；
   * 在皮肤外则把 reach 放大到 farReach 再找（露得很远的点也要能拉回来），仍找不到返回 false。
   * Writes out = [depth, inward direction x, y, z]. With the skin further than `reach`: false for a point
   * inside (deep enough; `out` untouched); for a point outside the search is widened to `farReach` (a point
   * far out must still be brought back), and false only if nothing is found there either.
   */
  sample(x: number, y: number, z: number, reach: number, out: Float64Array, farReach = 0.06): boolean {
    const inside = this.inside.contains(x, y, z)
    let t = this.nearest(x, y, z, reach)
    if (t < 0) {
      if (inside) return false
      t = this.nearest(x, y, z, farReach)
      if (t < 0) return false
    }
    const q = this.q
    const dx = x - q[0]!, dy = y - q[1]!, dz = z - q[2]!
    const d = Math.hypot(dx, dy, dz)
    out[0] = inside ? d : -d
    if (d > 1e-5) {
      const s = (inside ? 1 : -1) / d
      out[1] = dx * s; out[2] = dy * s; out[3] = dz * s
    } else {
      // 就在面上：用三角形法向 / on the surface itself: the triangle normal
      const p = this.p
      const a = 3 * this.idx[t]!, b = 3 * this.idx[t + 1]!, c = 3 * this.idx[t + 2]!
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const l = Math.hypot(nx, ny, nz) || 1
      const s = -this.outward / l
      out[1] = nx * s; out[2] = ny * s; out[3] = nz * s
    }
    return true
  }

  /** 最近的三角形（下标；没有则 −1），最近点留在 this.q / the nearest triangle (index, −1 when none) with the closest point left in this.q */
  private nearest(x: number, y: number, z: number, max: number): number {
    const cell = this.cell
    const ci = Math.floor((x - this.o[0]) / cell), cj = Math.floor((y - this.o[1]) / cell), ck = Math.floor((z - this.o[2]) / cell)
    let best = max
    let bestT = -1
    const tmp = TMP
    const rings = Math.ceil(max / cell) + 1
    for (let r = 0; r <= rings; r++) {
      if ((r - 1) * cell > best) break
      for (let k = ck - r; k <= ck + r; k++) {
        if (k < 0 || k >= this.n[2]) continue
        for (let j = cj - r; j <= cj + r; j++) {
          if (j < 0 || j >= this.n[1]) continue
          const edge = Math.abs(k - ck) === r || Math.abs(j - cj) === r
          for (let i = ci - r; i <= ci + r; i += edge ? 1 : Math.max(1, 2 * r)) {
            if (i < 0 || i >= this.n[0]) continue
            const c = i + this.n[0] * (j + this.n[1] * k)
            for (let s = this.start[c]!; s < this.start[c + 1]!; s++) {
              const t = this.tris[s]!
              closestOnTriangle(x, y, z, this.p, 3 * this.idx[t]!, 3 * this.idx[t + 1]!, 3 * this.idx[t + 2]!, tmp)
              const d = Math.hypot(x - tmp[0]!, y - tmp[1]!, z - tmp[2]!)
              if (d < best) {
                best = d
                bestT = t
                this.q[0] = tmp[0]!; this.q[1] = tmp[1]!; this.q[2] = tmp[2]!
              }
            }
          }
        }
      }
    }
    return bestT
  }
}
const TMP = new Float64Array(3)

// ── 位移场 / the displacement field ──────────────────────────────────────────────────────────────────

/**
 * 在一个图（顶点＋邻接）上解位移：每个点最后至少在皮肤下 want[i] 深。返回位移（平铺 xyz）和最大位移；没有点需要动时返回 null。
 * Solves the displacement over a graph (points + neighbours): every point ends at least want[i] under the
 * skin. Returns the displacement (flat xyz) and its maximum; null when no point needs to move.
 */
export function solveInward(field: SkinField, points: Float32Array, want: Float32Array | number, nbrStart: Uint32Array, nbrs: Uint32Array, opts: ThinOptions, trigger = opts.trigger): { u: Float32Array; max: number; moved: number; unresolved: number } | null {
  const n = points.length / 3
  const w = (i: number) => (typeof want === 'number' ? want : want[i]!)
  const maxWant = typeof want === 'number' ? want : want.reduce((a, b) => Math.max(a, b), 0)
  const reach = maxWant + 0.004
  const s = new Float64Array(4)
  // 第一遍：谁离皮肤近（之后只管这些点和被平滑带动的点） / first pass: which points are near the skin (only these, and those the smoothing drags along, are looked at again)
  const depth0 = new Float32Array(n).fill(Infinity)
  let fire = false
  for (let i = 0; i < n; i++) {
    if (!field.sample(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!, reach, s)) continue
    depth0[i] = s[0]!
    // 触发按“比目标浅 margin − trigger 以上”算，对带半径的点同样适用 / the trigger is "shallower than the target by more than margin − trigger", which also serves points with a radius
    if (s[0]! < w(i) - (opts.margin - trigger)) fire = true
  }
  if (!fire) return null
  const u = new Float32Array(3 * n)
  const tmp = new Float32Array(3 * n)
  let unresolved = 0
  const topUp = (): number => {
    let changed = 0
    unresolved = 0
    for (let i = 0; i < n; i++) {
      const ux = u[3 * i]!, uy = u[3 * i + 1]!, uz = u[3 * i + 2]!
      // 起初就深、位移又小的点不用再量 / a point deep at the start and barely displaced need not be measured again
      if (depth0[i] === Infinity && ux * ux + uy * uy + uz * uz < 0.003 * 0.003) continue
      if (!field.sample(points[3 * i]! + ux, points[3 * i + 1]! + uy, points[3 * i + 2]! + uz, reach, s)) {
        if (!field.contains(points[3 * i]! + ux, points[3 * i + 1]! + uy, points[3 * i + 2]! + uz)) unresolved++
        continue
      }
      const miss = w(i) - s[0]!
      if (miss <= 1e-6) continue
      u[3 * i] = ux + miss * s[1]!
      u[3 * i + 1] = uy + miss * s[2]!
      u[3 * i + 2] = uz + miss * s[3]!
      changed++
    }
    return changed
  }
  for (let round = 0; round < opts.rounds; round++) {
    topUp()
    for (let it = 0; it < opts.smoothIterations; it++) {
      for (let i = 0; i < n; i++) {
        const a = nbrStart[i]!, b = nbrStart[i + 1]!
        if (b === a) {
          tmp[3 * i] = u[3 * i]!; tmp[3 * i + 1] = u[3 * i + 1]!; tmp[3 * i + 2] = u[3 * i + 2]!
          continue
        }
        let x = 0, y = 0, z = 0
        for (let k = a; k < b; k++) {
          const j = nbrs[k]!
          x += u[3 * j]!; y += u[3 * j + 1]!; z += u[3 * j + 2]!
        }
        const inv = 0.5 / (b - a)
        tmp[3 * i] = 0.5 * u[3 * i]! + inv * x
        tmp[3 * i + 1] = 0.5 * u[3 * i + 1]! + inv * y
        tmp[3 * i + 2] = 0.5 * u[3 * i + 2]! + inv * z
      }
      u.set(tmp)
    }
  }
  // 最后只补足不平滑：向内的方向在凹处会变，多补几遍 / the last passes top up without smoothing; the inward direction changes in concavities, so a few passes
  for (let pass = 0; pass < 6; pass++) if (!topUp()) break
  let max = 0
  let moved = 0
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(u[3 * i]!, u[3 * i + 1]!, u[3 * i + 2]!)
    if (d > max) max = d
    if (d > opts.unchanged) moved++
  }
  return { u, max, moved, unresolved }
}

/** 网格顶点的邻接（CSR） / vertex adjacency of a mesh (CSR) */
function meshNeighbours(mesh: Mesh): { start: Uint32Array; list: Uint32Array } {
  const nv = mesh.positions.length / 3
  const sets: Set<number>[] = Array.from({ length: nv }, () => new Set<number>())
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = mesh.indices[t + k]!
    const b = mesh.indices[t + ((k + 1) % 3)]!
    if (a === b) continue
    sets[a]!.add(b)
    sets[b]!.add(a)
  }
  const start = new Uint32Array(nv + 1)
  for (let v = 0; v < nv; v++) start[v + 1] = start[v]! + sets[v]!.size
  const list = new Uint32Array(start[nv]!)
  for (let v = 0; v < nv; v++) {
    let k = start[v]!
    for (const j of [...sets[v]!].sort((x, y) => x - y)) list[k++] = j
  }
  return { start, list }
}

// ── 剪掉趾上的部分 / clipping what lies on the toes ──────────────────────────────────────────────────

/** 趾骨（足）；其余的骨都算“别的骨” / the phalanges of the foot; every other bone counts as "another bone" */
export const TOE_BONE = /phalanx of (left|right) .*toe$/i

/**
 * 按顶点上的标量把网格剪开，保留 s ≥ 0 的一侧；跨过零的三角形沿零线切开。切口不加盖（筋膜是一张开口的片）。
 * Clips a mesh by a per-vertex scalar, keeping the side s ≥ 0; triangles across zero are cut along the zero
 * line. The cut is not capped (a fascia is an open sheet).
 */
export function clipByScalar(mesh: Mesh, s: Float32Array | Float64Array): Mesh {
  const p = mesh.positions
  const nv = p.length / 3
  const pos: number[] = Array.from(p)
  const cutVertex = new Map<number, number>()
  const val = (v: number) => (Math.abs(s[v]!) < 1e-9 ? 1e-9 : s[v]!)
  const cut = (a: number, b: number): number => {
    const key = a < b ? a * nv + b : b * nv + a
    let v = cutVertex.get(key)
    if (v === undefined) {
      // 从下标小的一端插值，两边的三角形得到同一个点 / interpolated from the lower index, so both triangles get the same point
      const lo = Math.min(a, b), hi = Math.max(a, b)
      const t = val(lo) / (val(lo) - val(hi))
      v = pos.length / 3
      pos.push(p[3 * lo]! + t * (p[3 * hi]! - p[3 * lo]!), p[3 * lo + 1]! + t * (p[3 * hi + 1]! - p[3 * lo + 1]!), p[3 * lo + 2]! + t * (p[3 * hi + 2]! - p[3 * lo + 2]!))
      cutVertex.set(key, v)
    }
    return v
  }
  const keep: number[] = []
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
    const in3 = v.map((i) => val(i) > 0)
    const count = in3.filter(Boolean).length
    if (count === 3) keep.push(v[0]!, v[1]!, v[2]!)
    else if (count === 0) continue
    else {
      const lone = count === 1 ? in3.indexOf(true) : in3.indexOf(false)
      const a = v[lone]!, b = v[(lone + 1) % 3]!, c = v[(lone + 2) % 3]!
      const ab = cut(a, b)
      const ac = cut(a, c)
      if (count === 1) keep.push(a, ab, ac)
      else keep.push(ab, b, c, ab, c, ac)
    }
  }
  return compact({ positions: Float32Array.from(pos), indices: Uint32Array.from(keep) })
}

/**
 * 在趾根剪掉：比任何别的骨都更靠近趾骨的部分去掉（分界正落在跖趾关节的间隙里，趾蹼处也一并去掉）。
 * Clips at the toe bases: what is nearer to a phalanx of a toe than to any other bone is removed (the
 * boundary falls in the gap of the metatarsophalangeal joints, and the web spaces go with the toes).
 */
export function clipAtToeBases(mesh: Mesh, bones: { name: string; mesh: Mesh }[], opts: ThinOptions): { mesh: Mesh; removedCm2: number; fragmentsDropped: number } | null {
  const b = measure(mesh).bbox
  const pad = 0.06
  const near = bones.filter((x) => {
    const q = measure(x.mesh).bbox
    return !(q[0] > b[3] + pad || q[3] < b[0] - pad || q[1] > b[4] + pad || q[4] < b[1] - pad || q[2] > b[5] + pad || q[5] < b[2] - pad)
  })
  const cloud = (list: { mesh: Mesh }[]): PointIndex | null => {
    const pts: number[] = []
    for (const x of list) for (const v of thinPoints(surfacePoints(x.mesh, 0.0015), 0.001)) pts.push(v)
    return pts.length ? new PointIndex(Float32Array.from(pts), 0.008) : null
  }
  const toes = cloud(near.filter((x) => TOE_BONE.test(x.name)))
  const rest = cloud(near.filter((x) => !TOE_BONE.test(x.name)))
  if (!toes || !rest) return null
  const nv = mesh.positions.length / 3
  const s = new Float32Array(nv)
  const cap = 0.08
  let any = false
  for (let v = 0; v < nv; v++) {
    const x = mesh.positions[3 * v]!, y = mesh.positions[3 * v + 1]!, z = mesh.positions[3 * v + 2]!
    const dt = Math.min(cap, toes.distance(x, y, z, cap))
    const dr = Math.min(cap, rest.distance(x, y, z, cap))
    // 两边都远：留着 / far from both: kept
    s[v] = dt >= cap && dr >= cap ? cap : dt - dr
    if (s[v]! < 0) any = true
  }
  if (!any) return null
  const before = measure(mesh).area
  const clipped = clipByScalar(mesh, s)
  // 丢掉剪剩的小碎片 / drop the small fragments left by the clip
  const parts = components(clipped).map((m) => ({ m, area: measure(m).area }))
  const largest = parts.reduce((a, c) => Math.max(a, c.area), 0)
  const kept = parts.filter((c) => c.area >= opts.fragmentShare * largest)
  const out = kept.length === parts.length ? clipped : mergeAll(kept.map((c) => c.m))
  return { mesh: out, removedCm2: Math.round((before - measure(out).area) * 1e6) / 100, fragmentsDropped: parts.length - kept.length }
}

function mergeAll(meshes: Mesh[]): Mesh {
  const nv = meshes.reduce((a, m) => a + m.positions.length / 3, 0)
  const ni = meshes.reduce((a, m) => a + m.indices.length, 0)
  const positions = new Float32Array(3 * nv)
  const indices = new Uint32Array(ni)
  let v = 0, i = 0
  for (const m of meshes) {
    positions.set(m.positions, 3 * v)
    for (let k = 0; k < m.indices.length; k++) indices[i + k] = m.indices[k]! + v
    v += m.positions.length / 3
    i += m.indices.length
  }
  return { positions, indices }
}

// ── 神经中心线 / nerve centrelines ───────────────────────────────────────────────────────────────────

/** 把一条中心线重采样到间距不超过 step / resamples a centreline to a spacing of at most `step` */
function resample(line: Polyline, step: number): Polyline {
  const pts: number[] = []
  const rad: number[] = []
  const n = line.radius.length
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const ax = line.points[3 * i - 3]!, ay = line.points[3 * i - 2]!, az = line.points[3 * i - 1]!
      const bx = line.points[3 * i]!, by = line.points[3 * i + 1]!, bz = line.points[3 * i + 2]!
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / step))
      for (let j = 1; j < k; j++) {
        const t = j / k
        pts.push(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az))
        rad.push(line.radius[i - 1]! + t * (line.radius[i]! - line.radius[i - 1]!))
      }
    }
    pts.push(line.points[3 * i]!, line.points[3 * i + 1]!, line.points[3 * i + 2]!)
    rad.push(line.radius[i]!)
  }
  return { points: Float32Array.from(pts), radius: Float32Array.from(rad) }
}

/**
 * 神经：移动中心线。各分支重采样后连成一个图（相邻点相连；分支的端点连到别的分支上离它最近的点，
 * 这样分叉处两条线一起动），解出位移后按 nerveCourse.ts 的容差重新简化。没有点需要动时返回 null。
 * A nerve: its centrelines are moved. The branches are resampled and joined into one graph (consecutive
 * points; a branch end is linked to the nearest point of another branch, so that both lines move together
 * at a fork); after the solve the lines are simplified again with the tolerances of nerveCourse.ts. Null
 * when no point needs to move.
 */
export function recourseCentrelines(field: SkinField, lines: Polyline[], opts: ThinOptions, relief?: (points: Float32Array, u: Float32Array, nbrStart: Uint32Array, nbrs: Uint32Array) => void): { lines: Polyline[]; maxMm: number; movedShare: number; unresolved: number } | null {
  const fine = lines.map((l) => resample(l, opts.nerveStep))
  const offs: number[] = [0]
  for (const l of fine) offs.push(offs[offs.length - 1]! + l.radius.length)
  const n = offs[offs.length - 1]!
  if (!n) return null
  const points = new Float32Array(3 * n)
  const want = new Float32Array(n)
  fine.forEach((l, b) => {
    points.set(l.points, 3 * offs[b]!)
    for (let i = 0; i < l.radius.length; i++) want[offs[b]! + i] = opts.margin + l.radius[i]!
  })
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  const link = (a: number, b: number) => {
    sets[a]!.add(b)
    sets[b]!.add(a)
  }
  fine.forEach((l, b) => {
    for (let i = 1; i < l.radius.length; i++) link(offs[b]! + i - 1, offs[b]! + i)
  })
  // 分叉：端点连到别的分支上 1.5 个步长以内最近的点 / forks: an end is linked to the nearest point of another branch within 1.5 steps
  fine.forEach((l, b) => {
    for (const e of l.radius.length > 1 ? [0, l.radius.length - 1] : [0]) {
      const g = offs[b]! + e
      let best = -1
      let bd = (1.5 * opts.nerveStep) ** 2
      for (let j = 0; j < n; j++) {
        if (j >= offs[b]! && j < offs[b + 1]!) continue
        const d = (points[3 * j]! - points[3 * g]!) ** 2 + (points[3 * j + 1]! - points[3 * g + 1]!) ** 2 + (points[3 * j + 2]! - points[3 * g + 2]!) ** 2
        if (d < bd) {
          bd = d
          best = j
        }
      }
      if (best >= 0) link(g, best)
    }
  })
  const start = new Uint32Array(n + 1)
  for (let v = 0; v < n; v++) start[v + 1] = start[v]! + sets[v]!.size
  const list = new Uint32Array(start[n]!)
  for (let v = 0; v < n; v++) {
    let k = start[v]!
    for (const j of [...sets[v]!].sort((x, y) => x - y)) list[k++] = j
  }
  const res = solveInward(field, points, want, start, list, opts)
  if (!res || res.max <= opts.unchanged) return null
  if (relief) relief(points, res.u, start, list)
  const out = fine.map((l, b) => {
    const pts = new Float32Array(l.points.length)
    for (let i = 0; i < pts.length; i++) pts[i] = l.points[i]! + res.u[3 * offs[b]! + i]!
    return simplifyPolyline({ points: pts, radius: l.radius }, 0.00025, 0.15, 0.012)
  })
  return { lines: out, maxMm: Math.round(res.max * 1e4) / 10, movedShare: Math.round((res.moved / n) * 1e4) / 1e4, unresolved: res.unresolved }
}

// ── 整个阶段 / the whole stage ───────────────────────────────────────────────────────────────────────

export interface ThinPartIn {
  id: string
  name: string
  tissue: string
  provenance: string
  mesh: Mesh
  centrelines?: Polyline[]
  /** 网格是由中心线生成的管（神经）：移动中心线并重建 / the mesh is a tube built from the centrelines (nerves): move the centrelines and rebuild */
  tube?: boolean
}

export interface ThinPartRow {
  id: string
  name: string
  tissue: string
  rule: string
  action: ThinAction
  /** 剪掉的面积和丢弃的碎片数（只有 clipAtToeBases） / area clipped away and fragments dropped (clipAtToeBases only) */
  clipped?: { removedCm2: number; fragmentsDropped: number }
  /** 位移：最大值、被移动的顶点（或中心线点）所占比例、仍在皮肤外又找不到皮肤面的点数 / displacement: the largest, the share of vertices (or centreline points) moved, points still outside with no skin surface found */
  moved: { how: 'vertices' | 'centrelines'; maxMm: number; share: number; unresolved: number } | null
  /** 露在参考皮肤外的面积（cm²；thinOutside.ts 的量法），之前和之后 / area outside the reference skin (cm², measured as in thinOutside.ts), before and after */
  outsideCm2: { before: number; after: number }
  areaCm2: { before: number; after: number }
  provenance: { before: string; after: string }
  note: string
  /** 可选的附加测量（见 ThinExtra.insideBone）：表面采样点落在骨内的比例，之前和之后，以及之后落入最多的那块骨 / optional extra measurement (see ThinExtra.insideBone): share of surface samples inside a bone, before and after, and the bone holding most of them afterwards */
  insideBone?: { samples: number; before: number; after: number; bone: string | null }
  /** 只在要求了 keepOutOfBone 时才有：位移被退回的点数 / present only with keepOutOfBone: points whose displacement was scaled back */
  boneRelief?: { points: number }
}

/**
 * 可选的附加测量，不改变任何结果；不给时报告与原先逐字节相同。
 * Optional extra measurements. They change no result, and without them the report is byte for byte what it was.
 */
export interface ThinExtra {
  /**
   * 被处理的部件里名称匹配 `parts` 的（指、趾的血管和神经），量它的表面有多少落在名称匹配 `bones` 的骨内：
   * 位移场只看皮肤，把一条贴着皮肤的血管推向指（趾）的轴线时，它可能被推进指（趾）骨。
   * For the treated parts whose name matches `parts` (vessels and nerves of the digits): how much of their
   * surface lies inside a bone whose name matches `bones`. The field looks at the skin only; pushing a
   * vessel that hugs the skin towards the axis of a digit could push it into the phalanx.
   */
  insideBone?: { parts: RegExp; bones: RegExp; spacing?: number }
  /**
   * 给了 insideBone 时可再加上（改变结果，默认不做）：名称匹配的部件里，位移之前不在骨内、位移之后落进骨内的点，
   * 把它的位移按比例退回到刚好不进骨为止（退回的比例在邻点间略作平滑）。这样的点可能达不到皮下 margin 的深度。
   * With insideBone given, this may be added (it changes results; off by default): in the matching parts, a
   * point that was not inside a bone before the displacement and is inside one after it has its displacement
   * scaled back until it is just out of the bone (the scale is smoothed a little over neighbours). Such a
   * point may then fall short of the margin under the skin.
   */
  keepOutOfBone?: boolean
}

export interface ThinPartsResult {
  /** 改动过的部件 / the parts that changed */
  changed: Map<string, { mesh: Mesh; centrelines?: Polyline[]; deformed: boolean; clipped: boolean }>
  report: {
    applied: true
    marginMm: number
    triggerMm: number
    options: ThinOptions
    rules: { key: string; pattern: string; action: ThinAction; reason: { zh: string; en: string }; source: { name: string; url: string } | null }[]
    candidates: number
    treated: number
    clippedParts: number
    relabelledToWarped: string[]
    outsideCm2: { before: number; after: number }
    parts: ThinPartRow[]
    /** 只在要求了附加测量时才有 / present only when the extra measurement was asked for */
    insideBone?: { rule: string; partsMeasured: number; partsTouchingBoneAfter: number; samples: number; shareBefore: number; shareAfter: number; worst: { id: string; name: string; before: number; after: number; bone: string | null }[] }
  }
}

/**
 * @param parts     这一步可以动的薄结构（调用方按 THIN_TISSUES 选好） / the thin structures this stage may touch (chosen by the caller with THIN_TISSUES)
 * @param bones     全部的骨（剪趾根用） / all bones (for the clip at the toe bases)
 * @param reference 参考皮肤（闭合） / the reference skin (closed)
 * @param rules     本人体的规则表 / this body's rule table
 * @param extra     可选的附加测量（不改变结果） / optional extra measurements (no result changes)
 */
export function settleThinParts(parts: ThinPartIn[], bones: { name: string; mesh: Mesh }[], reference: Mesh, rules: ThinRule[], opts: ThinOptions = THIN_DEFAULTS, extra?: ThinExtra): ThinPartsResult {
  const field = new SkinField(reference)
  const changed: ThinPartsResult['changed'] = new Map()
  const rows: ThinPartRow[] = []
  const beforeMeshes: { id: string; name: string; tissue: string; mesh: Mesh }[] = []
  const afterMeshes: { id: string; name: string; tissue: string; mesh: Mesh }[] = []
  const relabelled: string[] = []
  let clippedParts = 0
  // 附加测量和退回位移共用的“在骨内”判断（只在要求了才建） / the inside-bone test shared by the extra measurement and the relief (built only when asked for)
  const solid = extra?.insideBone ? bones.filter((b) => extra.insideBone!.bones.test(b.name)).map((b) => ({ name: b.name, box: measure(b.mesh).bbox, mesh: b.mesh, tester: null as InsideTester | null })) : []
  const boneAt = (x: number, y: number, z: number): string | null => {
    for (const b of solid) {
      if (x < b.box[0] || x > b.box[3] || y < b.box[1] || y > b.box[4] || z < b.box[2] || z > b.box[5]) continue
      if ((b.tester ??= new InsideTester(b.mesh, 48)).contains(x, y, z)) return b.name
    }
    return null
  }
  const RELIEF_CLEARANCE = 0.0006
  let boneSurface: PointIndex | null = null
  /** 把新落进骨内的点的位移退回；返回退回的点数 / scales back the displacement of points newly inside a bone; returns how many */
  const relieve = (P: Float32Array, u: Float32Array, nbrStart: Uint32Array, nbrs: Uint32Array): number => {
    const n = P.length / 3
    const frac = new Float32Array(n).fill(1)
    // “碰骨”= 在骨内，或离骨面不到 RELIEF_CLEARANCE（管状网格的顶点之间还有面） / "at bone" = inside a bone, or nearer than RELIEF_CLEARANCE to its surface (between the vertices of a tube there is still surface)
    boneSurface ??= new PointIndex(Float32Array.from(solid.flatMap((b) => [...thinPoints(surfacePoints(b.mesh, 0.0008), 0.0006)])), 0.003)
    const inAt = (i: number, t: number) => {
      const x = P[3 * i]! + t * u[3 * i]!, y = P[3 * i + 1]! + t * u[3 * i + 1]!, z = P[3 * i + 2]! + t * u[3 * i + 2]!
      return boneSurface!.distance(x, y, z, RELIEF_CLEARANCE) < RELIEF_CLEARANCE || boneAt(x, y, z) !== null
    }
    const settle = (i: number): boolean => {
      if (!inAt(i, frac[i]!)) return false
      // 本来就碰着骨的点：不再往里带 / a point at bone to begin with is not taken further
      if (inAt(i, 0)) {
        frac[i] = 0
        return true
      }
      let lo = 0, hi = frac[i]!
      for (let k = 0; k < 7; k++) {
        const mid = (lo + hi) / 2
        if (inAt(i, mid)) hi = mid
        else lo = mid
      }
      frac[i] = lo
      return true
    }
    const hit = new Uint8Array(n)
    for (let i = 0; i < n; i++) if ((u[3 * i] !== 0 || u[3 * i + 1] !== 0 || u[3 * i + 2] !== 0) && settle(i)) hit[i] = 1
    let count = 0
    for (let i = 0; i < n; i++) count += hit[i]!
    if (!count) return 0
    for (let pass = 0; pass < 2; pass++) {
      const t = Float32Array.from(frac)
      for (let i = 0; i < n; i++) {
        const a = nbrStart[i]!, b = nbrStart[i + 1]!
        if (b === a) continue
        let m = 0
        for (let k = a; k < b; k++) m += t[nbrs[k]!]!
        frac[i] = Math.min(t[i]!, 0.5 * t[i]! + (0.5 * m) / (b - a))
      }
    }
    for (let i = 0; i < n; i++) if (frac[i]! < 1) {
      if (settle(i) && !hit[i]) {
        hit[i] = 1
        count++
      }
      u[3 * i] = u[3 * i]! * frac[i]!
      u[3 * i + 1] = u[3 * i + 1]! * frac[i]!
      u[3 * i + 2] = u[3 * i + 2]! * frac[i]!
    }
    return count
  }
  for (const part of parts) {
    const rule = rules.find((r) => r.name.test(part.name))
    if (!rule) continue
    const relief = !!extra?.keepOutOfBone && !!extra.insideBone && extra.insideBone.parts.test(part.name)
    let relieved = 0
    let mesh = part.mesh
    let lines = part.centrelines
    let clip: ThinPartRow['clipped']
    let moved: ThinPartRow['moved'] = null
    if (rule.action === 'clipAtToeBases') {
      const c = clipAtToeBases(mesh, bones, opts)
      if (c) {
        mesh = c.mesh
        clip = { removedCm2: c.removedCm2, fragmentsDropped: c.fragmentsDropped }
      }
    }
    if (part.tube && lines?.length) {
      const r = relief ? recourseCentrelines(field, lines, opts, (P, u, st, li) => void (relieved += relieve(P, u, st, li))) : recourseCentrelines(field, lines, opts)
      if (r) {
        const tubes = nerveTubes(r.lines)
        if (tubes) {
          mesh = tubes
          lines = r.lines
          moved = { how: 'centrelines', maxMm: r.maxMm, share: r.movedShare, unresolved: r.unresolved }
        }
      }
    } else {
      const nb = meshNeighbours(mesh)
      // 顶点都到位之后，凹处的三角形内部仍可能露在外面（弦跨过凹面）：把这些三角形三个顶点的目标深度加深再解，最多几遍
      // with every vertex in place a triangle may still lie outside in a concavity (its chord spans it): the target depth of such a triangle's three vertices is increased and the field solved again, a few times at most
      const want = new Float32Array(mesh.positions.length / 3).fill(opts.margin)
      let res = solveInward(field, mesh.positions, want, nb.start, nb.list, opts)
      const s4 = new Float64Array(4)
      for (let pass = 0; res && pass < opts.chordPasses; pass++) {
        const u = res.u
        const P = mesh.positions
        let bumped = 0
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = mesh.indices[t]!, b = mesh.indices[t + 1]!, c = mesh.indices[t + 2]!
          const ax = P[3 * a]! + u[3 * a]!, ay = P[3 * a + 1]! + u[3 * a + 1]!, az = P[3 * a + 2]! + u[3 * a + 2]!
          const bx = P[3 * b]! + u[3 * b]!, by = P[3 * b + 1]! + u[3 * b + 1]!, bz = P[3 * b + 2]! + u[3 * b + 2]!
          const cx = P[3 * c]! + u[3 * c]!, cy = P[3 * c + 1]! + u[3 * c + 1]!, cz = P[3 * c + 2]! + u[3 * c + 2]!
          // 重心和三条边的中点 / the centroid and the three edge midpoints
          let worst = Infinity
          for (const [x, y, z] of [[(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3], [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2], [(bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2], [(cx + ax) / 2, (cy + ay) / 2, (cz + az) / 2]] as const) {
            if (field.sample(x, y, z, opts.margin, s4) && s4[0]! < worst) worst = s4[0]!
          }
          if (worst >= opts.chordDepth) continue
          const add = opts.margin - worst
          for (const v of [a, b, c]) if (want[v]! < opts.maxDepth) want[v] = Math.min(opts.maxDepth, Math.max(want[v]!, opts.margin + add))
          bumped++
        }
        if (!bumped) break
        res = solveInward(field, mesh.positions, want, nb.start, nb.list, opts) ?? res
      }
      if (res && relief) relieved += relieve(mesh.positions, res.u, nb.start, nb.list)
      if (res && res.max > opts.unchanged) {
        const pos = new Float32Array(mesh.positions.length)
        for (let i = 0; i < pos.length; i++) pos[i] = mesh.positions[i]! + res.u[i]!
        mesh = { positions: pos, indices: mesh.indices }
        moved = { how: 'vertices', maxMm: Math.round(res.max * 1e4) / 10, share: Math.round((res.moved / (pos.length / 3)) * 1e4) / 1e4, unresolved: res.unresolved }
        // 没有随管重建的中心线（中心线不完整的几条神经）跟着同样的规则各自移动 / centrelines not rebuilt into tubes (the few nerves with incomplete centrelines) follow by the same rule on their own
        if (lines?.length) {
          const r = recourseCentrelines(field, lines, opts)
          if (r) lines = r.lines
        }
      }
    }
    if (!clip && !moved) continue
    const deformed = !!moved
    // scanned 的部件被形变或剪过就不再是“源数据原样”：改标 warped（与肩带校正的做法一致） / a scanned part that was deformed or clipped is no longer "as in the source": relabelled warped (as the shoulder correction does)
    const after = part.provenance === 'scanned' ? 'warped' : part.provenance
    if (after !== part.provenance) relabelled.push(part.id)
    if (clip) clippedParts++
    changed.set(part.id, { mesh, ...(lines && lines !== part.centrelines ? { centrelines: lines } : {}), deformed, clipped: !!clip })
    beforeMeshes.push({ id: part.id, name: part.name, tissue: part.tissue, mesh: part.mesh })
    afterMeshes.push({ id: part.id, name: part.name, tissue: part.tissue, mesh })
    const what = [clip ? `clipped at the toe bases (${clip.removedCm2} cm² removed)` : '', moved ? `${moved.how === 'centrelines' ? 'centrelines re-coursed and tubes rebuilt' : 'vertices displaced by a smooth inward field'} (up to ${moved.maxMm} mm)` : ''].filter(Boolean).join('; ')
    rows.push({
      id: part.id, name: part.name, tissue: part.tissue, rule: rule.key, action: rule.action, ...(clip ? { clipped: clip } : {}), moved,
      outsideCm2: { before: 0, after: 0 }, areaCm2: { before: 0, after: 0 }, provenance: { before: part.provenance, after }, ...(relief ? { boneRelief: { points: relieved } } : {}),
      note: `${what}, against the reference skin with a ${opts.margin * 1000} mm margin${after !== part.provenance ? '; scanned geometry changed, so relabelled warped' : ''}`,
    })
  }
  // 逐部件量露出的面积，之前和之后（同一把尺子：thinOutside.ts） / area outside per part, before and after (the same yardstick: thinOutside.ts)
  const r2 = (v: number) => Math.round(v * 100) / 100
  let sumB = 0, sumA = 0
  if (rows.length) {
    const mb = thinStructuresOutsideSkin(reference, beforeMeshes, undefined, 0.002, 0)
    const ma = thinStructuresOutsideSkin(reference, afterMeshes, undefined, 0.002, 0)
    const byB = new Map(mb.rows.map((x) => [x.id, x]))
    const byA = new Map(ma.rows.map((x) => [x.id, x]))
    for (const row of rows) {
      row.outsideCm2 = { before: byB.get(row.id)?.outsideCm2 ?? 0, after: byA.get(row.id)?.outsideCm2 ?? 0 }
      row.areaCm2 = { before: byB.get(row.id)?.areaCm2 ?? 0, after: byA.get(row.id)?.areaCm2 ?? 0 }
      sumB += row.outsideCm2.before
      sumA += row.outsideCm2.after
    }
  }
  // 附加测量：指、趾的血管和神经有多少落在骨内（之前、之后） / the extra measurement: how much of the digital vessels and nerves lies inside bone (before, after)
  let insideBone: ThinPartsResult['report']['insideBone']
  if (extra?.insideBone) {
    const ib = extra.insideBone
    const spacing = ib.spacing ?? 0.001
    const count = (mesh: Mesh): { n: number; inside: number; by: Map<string, number> } => {
      const pts = thinPoints(surfacePoints(mesh, spacing), spacing * 0.8)
      const by = new Map<string, number>()
      let inside = 0
      for (let i = 0; i < pts.length; i += 3) {
        const name = boneAt(pts[i]!, pts[i + 1]!, pts[i + 2]!)
        if (name === null) continue
        inside++
        by.set(name, (by.get(name) ?? 0) + 1)
      }
      return { n: pts.length / 3, inside, by }
    }
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4
    let nB = 0, nA = 0, sB = 0, sA = 0, measured = 0, touching = 0
    const beforeOf = new Map(beforeMeshes.map((x) => [x.id, x.mesh]))
    const afterOf = new Map(afterMeshes.map((x) => [x.id, x.mesh]))
    for (const row of rows) {
      if (!ib.parts.test(row.name)) continue
      const b = count(beforeOf.get(row.id)!)
      const a = count(afterOf.get(row.id)!)
      const top = [...a.by].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]
      row.insideBone = { samples: a.n, before: b.n ? r4(b.inside / b.n) : 0, after: a.n ? r4(a.inside / a.n) : 0, bone: top ? top[0] : null }
      measured++
      if (a.inside) touching++
      nB += b.n; sB += b.inside; nA += a.n; sA += a.inside
    }
    insideBone = {
      rule: `surface samples (about ${spacing * 1000} mm apart) of the treated parts named /${ib.parts.source}/ that lie inside a bone named /${ib.bones.source}/, as a share, before and after the treatment`,
      partsMeasured: measured, partsTouchingBoneAfter: touching, samples: nA, shareBefore: nB ? r4(sB / nB) : 0, shareAfter: nA ? r4(sA / nA) : 0,
      worst: rows.filter((r) => r.insideBone && r.insideBone.after > 0).sort((p, q) => q.insideBone!.after - p.insideBone!.after || (p.id < q.id ? -1 : 1)).slice(0, 12).map((r) => ({ id: r.id, name: r.name, before: r.insideBone!.before, after: r.insideBone!.after, bone: r.insideBone!.bone })),
    }
  }
  rows.sort((a, b) => b.outsideCm2.before - a.outsideCm2.before || (a.id < b.id ? -1 : 1))
  return {
    changed,
    report: {
      applied: true, marginMm: opts.margin * 1000, triggerMm: opts.trigger * 1000, options: opts,
      rules: rules.map((r) => ({ key: r.key, pattern: r.name.source, action: r.action, reason: r.reason, source: r.source ?? null })),
      candidates: parts.length, treated: rows.length, clippedParts, relabelledToWarped: relabelled.sort(),
      outsideCm2: { before: r2(sumB), after: r2(sumA) }, parts: rows,
      ...(insideBone ? { insideBone } : {}),
    },
  }
}
