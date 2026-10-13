// 口角一带的网格质量：不翻折、面积比在带内、唇缘光滑、口腔袋和口内的部件不从皮肤里露出来。
// 只在 face.json 存在且不过期时执行：先运行 `bun tools/face/run.ts male`（和 female）。
// Mesh quality round the mouth corners: nothing folds, area ratios stay within a band, the lip margins are smooth, and neither the
// oral pouch nor the parts inside the mouth show through the skin. Runs only while face.json is present and not stale: run
// `bun tools/face/run.ts male` (and female) first.
//
// 检查的状态 / States checked
//   每个 AU 单独取 5；每个视位；每种情绪原型；下颌张到 0、0.25、0.5、1 倍上限（mouth_corner = 下颌角 / 上限）。
//   Every AU alone at 5; every viseme; every emotion prototype; the jaw opened to 0, 0.25, 0.5 and 1 × its limit (mouth_corner = jaw angle / limit).
//
// 这里陈述的容差 / Tolerances stated here
//   · 区域：到任一口角 16 mm 以内的皮肤三角形（不含口腔袋）。三角形的“高” = 2 × 面积 / 最长边。
//     Region: skin triangles within 16 mm of either corner (pouch excluded). A triangle's "height" = 2 × area / longest edge.
//   · 翻折：法线与静止时相反、且静止或变形后的高 ≥ 0.1 mm 的三角形。高始终不到 0.1 mm 的是唇缘上三点几乎共线的退化三角形
//     （网格本身就有），零点零几毫米的差别就让它的法线翻转，而它不占任何像素。面积比 = 变形后 / 静止，只看静止时高 ≥ 0.1 mm 的三角形。
//     Folds: triangles whose normal is reversed against rest and whose rest or deformed height is ≥ 0.1 mm. Those that stay under
//     0.1 mm are degenerate triangles with three nearly collinear points on the margin (present in the mesh itself): hundredths of a
//     millimetre reverse their normals, and they cover no pixel. Area ratio = deformed / rest, for triangles with a rest height ≥ 0.1 mm.
//   · 按状态的下颌张开角 f = 下颌角 / 上限分三档 / three tiers by the state's jaw opening f = jaw angle / limit:
//       f < 0.2（除 AU26、AU27 外的所有 AU，大多数视位和情绪）：没有翻折；面积比在 [0.4, 3.5] 内。
//       f < 0.2 (every AU but AU26 and AU27, most visemes and emotions): no fold; area ratio within [0.4, 3.5].
//       f < 0.2 且用到唇收拢或外翻（AU18、AU22 和圆唇的视位）：翻折的三角形没有高 ≥ 0.5 mm 的，变形后面积合计 ≤ 2 mm²；面积比在
//       [0.04, 3.5] 内（口收窄四分之一，口角处的小三角形被压得很扁；外翻时两唇相贴的面确实翻了出来）。
//       f < 0.2 with lip pursing or eversion (AU18, AU22 and the rounded visemes): no folded triangle with a height ≥ 0.5 mm, deformed
//       areas summing to ≤ 2 mm²; area ratio within [0.04, 3.5] (the mouth narrows by a quarter and small triangles at the corners
//       are squeezed flat; in eversion the contact surfaces really do turn out).
//       0.2 ≤ f ≤ 0.5（AA、EH、OW、AU26、惊讶）：翻折的三角形没有高 ≥ 0.5 mm 的，它们变形后的面积合计 ≤ 2 mm²；面积比在 [0.05, 7] 内。
//       0.2 ≤ f ≤ 0.5 (AA, EH, OW, AU26, surprise): no folded triangle with a height ≥ 0.5 mm, and their deformed areas sum to ≤ 2 mm²; area ratio within [0.05, 7].
//       f > 0.5（AU27、下颌张到上限，约 50 mm 的开口）：高 ≥ 0.5 mm 的翻折三角形 ≤ 12 个，翻折面积合计 ≤ 45 mm²，面积比 ≤ 13。
//       这一档是已知的缺口：两唇相贴的面在口角处被拉开十倍，其中的小三角形转过了 90°。
//       f > 0.5 (AU27, the jaw at its limit, an opening of about 50 mm): at most 12 folded triangles with a height ≥ 0.5 mm, folded area
//       ≤ 45 mm² in all, area ratio ≤ 13. This tier is a known gap: the contact surfaces of the lips are stretched ten-fold at the
//       corners and small triangles in them turn through more than 90°.
//   · 唇缘光滑：上、下唇缘折线上每个顶点到相邻两点连线中点的距离，最大值不超过静止时的最大值 + 0.5 mm（f > 0.5 时 + 0.8 mm）。
//     Smooth margins: the distance of every vertex of the upper and lower margin polylines from the midpoint of its two neighbours has
//     a maximum no larger than its maximum at rest + 0.5 mm (+ 0.8 mm where f > 0.5).
//   · 深度次序：从正前方和左右各 45° 看（正交投影，0.25 mm 一个像素，口周 70 × 56 mm），口腔袋、牙、牙龈、舌在皮肤外表面之前
//     0.3 mm 以上（且在其前 15 mm 以内）的像素不超过 12 个（0.75 mm²）。
//     Depth order: seen from straight ahead and from 45° on either side (orthographic, 0.25 mm per pixel, 70 × 56 mm round the mouth),
//     at most 12 pixels (0.75 mm²) show pouch, teeth, gingiva or tongue more than 0.3 mm in front of the outer skin surface (and
//     within 15 mm of it).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Rig } from '../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../src/face/types.ts'
import { AU_MAX, type Activations, SPEECH_STYLES, activations, deform, expressionAUs, visemeAUs } from '../tools/face/model.ts'
import { stale } from '../tools/face/run.ts'
import { type Body, readBody } from '../tools/rig/io.ts'
import { Poser } from '../tools/rig/pose.ts'

const MM = 0.001
const SLIVER = 0.1 * MM, BIG = 0.5 * MM

for (const bodyId of ['male', 'female'] as const) {
  const DIR = join(import.meta.dirname, '../public/anatomy', bodyId)
  const present = existsSync(join(DIR, 'face.json')) && existsSync(join(DIR, 'face.bin')) && existsSync(join(DIR, 'face', 'openings.json')) && existsSync(join(DIR, 'rig.bin'))
  const fresh = present && stale(DIR).length === 0

  describe.skipIf(!fresh)(`mouth corners (public/anatomy/${bodyId})`, () => {
    const face = (present ? JSON.parse(readFileSync(join(DIR, 'face.json'), 'utf8')) : {}) as FaceData
    const bin = present ? new Uint8Array(readFileSync(join(DIR, 'face.bin'))) : new Uint8Array(0)
    const O = (present ? JSON.parse(readFileSync(join(DIR, 'face', 'openings.json'), 'utf8')) : {}) as FaceOpenings
    const rig = (present ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : {}) as Rig
    const rigBin = present ? new Uint8Array(readFileSync(join(DIR, 'rig.bin'))) : new Uint8Array(0)
    let body: Body
    let rest: Float32Array
    let indices: Uint32Array
    let cornerTris: number[] = []
    let aid: Uint8Array
    let inner: string[] = []
    const states: { name: string; channels: Activations; jaw: number; wide: boolean }[] = []
    beforeAll(async () => {
      body = await readBody(DIR)
      rest = body.meshes.get(face.skin)!.positions
      indices = body.meshes.get(face.skin)!.indices
      aid = new Uint8Array(rest.length / 3)
      for (const v of [...O.oralPouch.upper, ...O.oralPouch.lower, ...O.oralPouch.seam]) aid[v] = 1
      const cl = P(rest, O.points.mouthCornerL), cr = P(rest, O.points.mouthCornerR)
      const near = (v: number): boolean => !aid[v] && Math.min(dist(P(rest, v), cl), dist(P(rest, v), cr)) < 16 * MM
      for (let t = 0; t < indices.length; t += 3) if (near(indices[t]!) && near(indices[t + 1]!) && near(indices[t + 2]!)) cornerTris.push(t)
      // 口内的部件：牙、牙龈、舌 / the parts inside the mouth: teeth, gingiva, tongue
      inner = body.data.parts.filter((p) => body.meshes.has(p.id) && p.bbox[4] > face.landmarks.stomionY.skin - 0.08 && (p.tissue === 'tooth' || /gingiva/i.test(p.name) || /^tongue$/i.test(p.name))).map((p) => p.id)
      for (const au of face.aus) states.push({ name: `${au.id} = 5`, ...activations(face, { [au.id]: AU_MAX }), wide: au.id === 'AU27' })
      for (const v of face.visemes?.visemes ?? []) {
        const o = visemeAUs(face, { [v.id]: 1 })
        states.push({ name: `viseme ${v.id}`, channels: o.channels, jaw: o.jaw, wide: false })
        // 夸张风格（校准之前的数值）也要过同样的检验 / the exaggerated style (the values from before calibration) must pass the same checks
        const c = visemeAUs(face, { [v.id]: 1 }, SPEECH_STYLES.clear)
        states.push({ name: `viseme ${v.id} (clear)`, channels: c.channels, jaw: c.jaw, wide: false })
      }
      for (const e of face.expressions ?? []) states.push({ name: `emotion ${e.id}`, ...activations(face, expressionAUs(face.expressions, e.id, 1)), wide: false })
      for (const f of [0, 0.25, 0.5, 1]) states.push({ name: `jaw ${f} × max`, channels: f > 0 ? { mouth_corner: f } : {}, jaw: f * face.jaw.max, wide: f === 1 })
    }, 120_000)

    const P = (a: Float32Array, v: number): [number, number, number] => [a[v * 3]!, a[v * 3 + 1]!, a[v * 3 + 2]!]
    const dist = (p: number[], q: number[]): number => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
    const poser = (jaw: number): Poser => new Poser(rig, rigBin, jaw > 0 ? { [face.jaw.joint]: Array.from({ length: face.jaw.dof + 1 }, (_, k) => (k === face.jaw.dof ? jaw : 0)) } : {})
    const posedPart = (part: string, channels: Activations, jaw: number): Float32Array => poser(jaw).part(part, deform(face.channels, bin, part, body.meshes.get(part)!.positions, channels), 'dqs', false)

    /** 口角一带：翻折的三角形数，以及面积比的最小值和最大值 / the corner region: number of folded triangles, least and greatest area ratio. */
    const quality = (pos: Float32Array): { folded: number; big: number; area: number; min: number; max: number } => {
      const nrm = (a: Float32Array, i: number, j: number, k: number): { n: number[]; h: number } => {
        const p = P(a, i), q = P(a, j), r = P(a, k)
        const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
        const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
        return { n, h: Math.hypot(n[0]!, n[1]!, n[2]!) / Math.max(1e-12, dist(p, q), dist(q, r), dist(r, p)) }
      }
      let folded = 0, big = 0, area = 0, min = Infinity, max = 0
      for (const t of cornerTris) {
        const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
        const r0 = nrm(rest, a, b, c), r1 = nrm(pos, a, b, c)
        if (r0.n[0]! * r1.n[0]! + r0.n[1]! * r1.n[1]! + r0.n[2]! * r1.n[2]! <= 0 && Math.max(r0.h, r1.h) >= SLIVER) {
          folded++
          if (Math.max(r0.h, r1.h) >= BIG) big++
          area += Math.hypot(r1.n[0]!, r1.n[1]!, r1.n[2]!) / 2
        }
        if (r0.h < SLIVER) continue
        const ratio = Math.hypot(r1.n[0]!, r1.n[1]!, r1.n[2]!) / Math.hypot(r0.n[0]!, r0.n[1]!, r0.n[2]!)
        ;(min = Math.min(min, ratio)), (max = Math.max(max, ratio))
      }
      return { folded, big, area, min, max }
    }
    const roughness = (pos: Float32Array): number => {
      let m = 0
      for (const M of [O.margins.upperLip, O.margins.lowerLip]) {
        for (let i = 1; i + 1 < M.length; i++) {
          const a = P(pos, M[i - 1]!), b = P(pos, M[i]!), c = P(pos, M[i + 1]!)
          m = Math.max(m, dist(b, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2]))
        }
      }
      return m
    }
    /**
     * 深度次序：正交投影的两张深度图——皮肤外表面（朝向观察者的非构造物三角形）和口内的东西（口腔袋、牙、牙龈、舌）；
     * 返回后者在前者之前 0.3–15 mm 的像素数。
     * Depth order: two orthographic depth maps — the outer skin surface (non-aid triangles facing the viewer) and what is inside the
     * mouth (pouch, teeth, gingiva, tongue); returns the number of pixels where the latter lies 0.3–15 mm in front of the former.
     */
    const showThrough = (skinPos: Float32Array, innerPos: { pos: Float32Array; idx: Uint32Array }[], yawDeg: number): number => {
      const yaw = (yawDeg * Math.PI) / 180, cs = Math.cos(yaw), sn = Math.sin(yaw)
      const C = [face.landmarks.midX, face.landmarks.stomionY.skin - 0.006, P(rest, O.margins.upperLip[O.margins.upperLip.length >> 1]!)[2]]
      const px = 0.25 * MM, W = 280, H = 224
      // 视空间：x 向右，y 向上，z 朝向观察者 / view space: x right, y up, z towards the viewer
      const view = (a: Float32Array, v: number): [number, number, number] => {
        const x = a[v * 3]! - C[0]!, y = a[v * 3 + 1]! - C[1]!, z = a[v * 3 + 2]! - C[2]!
        return [x * cs - z * sn, y, x * sn + z * cs]
      }
      const skinZ = new Float32Array(W * H).fill(-Infinity), innerZ = new Float32Array(W * H).fill(-Infinity)
      const raster = (a: Float32Array, i: number, j: number, k: number, buf: Float32Array, frontOnly: boolean): void => {
        const p = view(a, i), q = view(a, j), r = view(a, k)
        const area = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        if (frontOnly ? area <= 1e-14 : Math.abs(area) <= 1e-14) return
        const x0 = Math.max(0, Math.floor(Math.min(p[0], q[0], r[0]) / px + W / 2)), x1 = Math.min(W - 1, Math.ceil(Math.max(p[0], q[0], r[0]) / px + W / 2))
        const y0 = Math.max(0, Math.floor(Math.min(p[1], q[1], r[1]) / px + H / 2)), y1 = Math.min(H - 1, Math.ceil(Math.max(p[1], q[1], r[1]) / px + H / 2))
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const X = (xx - W / 2) * px, Y = (yy - H / 2) * px
            const w0 = ((q[0] - X) * (r[1] - Y) - (q[1] - Y) * (r[0] - X)) / area, w1 = ((r[0] - X) * (p[1] - Y) - (r[1] - Y) * (p[0] - X)) / area, w2 = 1 - w0 - w1
            if (w0 < 0 || w1 < 0 || w2 < 0) continue
            const z = w0 * p[2] + w1 * q[2] + w2 * r[2]
            if (z > buf[yy * W + xx]!) buf[yy * W + xx] = z
          }
        }
      }
      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
        if (Math.abs(rest[a * 3 + 1]! - C[1]!) > 0.08) continue
        if (aid[a] || aid[b] || aid[c]) raster(skinPos, a, b, c, innerZ, false)
        else raster(skinPos, a, b, c, skinZ, true)
      }
      for (const m of innerPos) for (let t = 0; t < m.idx.length; t += 3) raster(m.pos, m.idx[t]!, m.idx[t + 1]!, m.idx[t + 2]!, innerZ, false)
      let n = 0
      for (let i = 0; i < W * H; i++) if (innerZ[i]! > skinZ[i]! + 0.3 * MM && innerZ[i]! < skinZ[i]! + 15 * MM) n++
      return n
    }

    it('folds no triangle round the corners and keeps area ratios within the stated band, in every state', () => {
      const report: string[] = []
      for (const s of states) {
        const q = quality(posedPart(face.skin, s.channels, s.jaw))
        if (process.env.FACE_STATS) report.push(`${s.name}: folded ${q.folded} big ${q.big} area ${(q.area / MM / MM).toFixed(2)}, ratio ${q.min.toFixed(2)}–${q.max.toFixed(2)}`)
        const f = s.jaw / face.jaw.max
        const rounded = (s.channels.lip_purse ?? 0) > 0 || (s.channels.lip_evert ?? 0) > 0
        if (f < 0.2 && rounded) {
          expect.soft(q.big, s.name).toBe(0)
          expect.soft(q.area / MM / MM, s.name).toBeLessThanOrEqual(2)
          expect.soft(q.min, s.name).toBeGreaterThanOrEqual(0.04)
          expect.soft(q.max, s.name).toBeLessThanOrEqual(3.5)
        } else if (f < 0.2) {
          expect.soft(q.folded, s.name).toBe(0)
          expect.soft(q.min, s.name).toBeGreaterThanOrEqual(0.4)
          expect.soft(q.max, s.name).toBeLessThanOrEqual(3.5)
        } else if (f <= 0.5) {
          expect.soft(q.big, s.name).toBe(0)
          expect.soft(q.area / MM / MM, s.name).toBeLessThanOrEqual(2)
          expect.soft(q.min, s.name).toBeGreaterThanOrEqual(0.05)
          expect.soft(q.max, s.name).toBeLessThanOrEqual(7)
        } else {
          expect.soft(q.big, s.name).toBeLessThanOrEqual(12)
          expect.soft(q.area / MM / MM, s.name).toBeLessThanOrEqual(45)
          expect.soft(q.max, s.name).toBeLessThanOrEqual(13)
        }
      }
      if (report.length) console.log(report.join('\n'))
    })

    it('keeps both lip-margin polylines smooth in every state', () => {
      const r0 = roughness(rest)
      const report: string[] = [`rest ${(r0 / MM).toFixed(2)} mm`]
      for (const s of states) {
        const r = roughness(posedPart(face.skin, s.channels, s.jaw))
        if (process.env.FACE_STATS) report.push(`${s.name}: ${(r / MM).toFixed(2)} mm`)
        expect.soft(r / MM, s.name).toBeLessThanOrEqual(r0 / MM + (s.jaw > 0.5 * face.jaw.max ? 0.8 : 0.5))
      }
      if (process.env.FACE_STATS) console.log(report.join('\n'))
    })

    it('shows neither the pouch nor the parts inside the mouth through the skin, from the front and from 45° on both sides', () => {
      const report: string[] = []
      for (const s of states) {
        const skinPos = posedPart(face.skin, s.channels, s.jaw)
        const innerPos = inner.map((id) => ({ pos: posedPart(id, s.channels, s.jaw), idx: body.meshes.get(id)!.indices }))
        for (const yaw of [0, 45, -45]) {
          const n = showThrough(skinPos, innerPos, yaw)
          if (process.env.FACE_STATS && n > 0) report.push(`${s.name} yaw ${yaw}: ${n} px`)
          expect.soft(n, `${s.name}, yaw ${yaw}`).toBeLessThanOrEqual(12)
        }
      }
      if (report.length) console.log(report.join('\n'))
    }, 240_000)
  })
}
