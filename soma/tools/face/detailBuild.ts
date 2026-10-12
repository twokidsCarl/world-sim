// 皱纹细节层的构建：面部 UV（柱面投影）和每层的法线贴图。
// Build of the wrinkle detail layer: the face UV chart (a cylindrical projection) and one normal map per layer.
//
// 做法 / Method
//   · UV：绕头部竖直轴的柱面投影，只给表情层会动到的皮肤顶点（面部正面 ±75°）。
//     UV: a cylindrical projection about the head's vertical axis, only for skin vertices the expression layer moves (the front of the face, ±75°).
//   · 每个纹素对应的三维位置：把面部三角形光栅化到 UV 空间。
//     The 3D position of every texel: the face triangles are rasterised into UV space.
//   · 皱纹是皮肤表面上的三维折线（由标志点定位、从正前方投影到皮肤）；纹素的高度 = 到折线的三维距离的函数。
//     所以沟的宽度和深度按真实毫米计，不受 UV 拉伸影响。
//     A wrinkle is a 3D polyline on the skin (placed by landmarks, projected onto the skin from straight ahead); a texel's
//     height is a function of its 3D distance from the polyline, so furrow width and depth are in true millimetres whatever
//     the UV stretch.
//   · 法线：高度沿 u、v 方向按真实长度求斜率，n = normalize(−∂h/∂s_u, −∂h/∂s_v, 1)。
//     Normals: slopes of the height per true length along u and v, n = normalize(−∂h/∂s_u, −∂h/∂s_v, 1).
//   · 没有描摹或复制任何照片；条数、尺寸都来自 data/curated/face/wrinkles.json，其中标明了哪些是假设。
//     No photograph is traced or copied; counts and sizes come from data/curated/face/wrinkles.json, which says what is assumed.

import type { Bilingual, FaceData, FaceDetail, Sourced } from '../../src/face/types.ts'
import { Surface } from '../rig/geom.ts'
import type { Body } from '../rig/io.ts'
import { type V3, sub } from '../rig/math.ts'
import { Image } from '../rig/render.ts'

export interface WrinkleDef {
  ref: 'brow' | 'nasion' | 'canthus' | 'lowerLid' | 'lowerLidMedial' | 'alaToModiolus' | 'modiolus'
  points: [number, number][]
  midline?: boolean
  span?: boolean
  bowMm?: number
  depthMm: number
  widthMm: number
}
export interface WrinklesCurated {
  tile: number
  columns: number
  curve: { gamma: number }
  layers: { id: string; name: Bilingual; drivers: Record<string, number>; basis: Sourced; wrinkles: WrinkleDef[] }[]
}

const MM = 0.001
const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

export interface DetailBuild {
  detail: FaceDetail
  uvBin: Uint8Array
  atlas: Uint8Array
  /** 每个皮肤顶点的 (u, v)，没有的为 NaN / (u, v) per skin vertex, NaN where absent. */
  uv: Float32Array
  /** 画出来的皱纹折线（三维），供检查 / the wrinkle polylines drawn (3D), for inspection. */
  lines: { layer: string; points: V3[] }[]
  skipped: string[]
}

export function buildDetail(body: Body, face: FaceData, faceBin: Uint8Array, cur: WrinklesCurated): DetailBuild {
  const skin = body.meshes.get(face.skin)!
  const P = skin.positions
  const nv = P.length / 3
  const mid = face.landmarks.midX
  const eyes = face.landmarks.eyes
  if (eyes.length < 2) throw new Error('face detail: two eyes are needed')

  // —— UV ——
  const axis = { x: mid, z: (eyes[0]!.globe[2] + eyes[1]!.globe[2]) / 2 - 0.075 }
  const radius = 0.1
  const moved = new Uint8Array(nv)
  const dv = new DataView(faceBin.buffer, faceBin.byteOffset, faceBin.byteLength)
  for (const ch of face.channels) for (const f of ch.fields) if (f.part === face.skin) for (let i = 0; i < f.count; i++) moved[dv.getUint32(f.offset + i * 4, true)] = 1
  const theta = (v: number): number => Math.atan2(P[v * 3]! - axis.x, P[v * 3 + 2]! - axis.z)
  const LIMIT = (75 * Math.PI) / 180
  // 面部的高度范围：眼上 45 mm 到口裂下 45 mm / the height range of the face: 45 mm above the eyes to 45 mm below the oral fissure
  const yTop = Math.max(...eyes.map((e) => e.globe[1])) + 45 * MM, yBottom = face.landmarks.stomionY.skin - 45 * MM
  const inMask = new Uint8Array(nv)
  let y0 = Infinity, y1 = -Infinity, tMax = 0
  for (let v = 0; v < nv; v++) {
    const y = P[v * 3 + 1]!
    if (!moved[v] || y > yTop || y < yBottom || P[v * 3 + 2]! < axis.z) continue
    const t = theta(v)
    if (Math.abs(t) > LIMIT) continue
    inMask[v] = 1
    ;(y0 = Math.min(y0, y)), (y1 = Math.max(y1, y)), (tMax = Math.max(tMax, Math.abs(t)))
  }
  const extent = Math.max(2 * tMax * radius, y1 - y0) * 1.02
  const T = cur.tile
  const uv = new Float32Array(nv * 2).fill(NaN)
  const toUv = (x: number, y: number, z: number): [number, number] => [0.5 + (Math.atan2(x - axis.x, z - axis.z) * radius) / extent, (y - y0) / extent + (1 - (y1 - y0) / extent) / 2]
  let count = 0
  for (let v = 0; v < nv; v++) {
    if (!inMask[v]) continue
    const [u, w] = toUv(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!)
    // 量化到 uint16，之后一律用量化后的值 / quantised to uint16; the quantised value is used from here on
    uv[v * 2] = Math.round(Math.min(1, Math.max(0, u)) * 65535) / 65535
    uv[v * 2 + 1] = Math.round(Math.min(1, Math.max(0, w)) * 65535) / 65535
    count++
  }
  const uvBin = new Uint8Array(count * 8)
  {
    const o = new DataView(uvBin.buffer)
    let i = 0
    for (let v = 0; v < nv; v++) {
      if (!inMask[v]) continue
      o.setUint32(i * 4, v, true)
      o.setUint16(count * 4 + i * 4, Math.round(uv[v * 2]! * 65535), true)
      o.setUint16(count * 4 + i * 4 + 2, Math.round(uv[v * 2 + 1]! * 65535), true)
      i++
    }
  }

  // —— 纹素 → 三维位置；同时统计拉伸 / texel → 3D position; stretch statistics on the way ——
  const pos = new Float32Array(T * T * 3).fill(NaN)
  const depth = new Float32Array(T * T).fill(-Infinity)
  const stretch: number[] = []
  let tris = 0, flipped = 0
  for (let t = 0; t < skin.indices.length; t += 3) {
    const a = skin.indices[t]!, b = skin.indices[t + 1]!, c = skin.indices[t + 2]!
    if (!inMask[a] || !inMask[b] || !inMask[c]) continue
    tris++
    const ax = uv[a * 2]! * (T - 1), ay = (1 - uv[a * 2 + 1]!) * (T - 1), bx = uv[b * 2]! * (T - 1), by = (1 - uv[b * 2 + 1]!) * (T - 1), cx = uv[c * 2]! * (T - 1), cy = (1 - uv[c * 2 + 1]!) * (T - 1)
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    // 图像的 y 向下，所以朝外的三角形在这里面积为负 / image y points down, so outward-facing triangles have negative area here
    if (area >= 0) flipped++
    const A: V3 = [P[a * 3]!, P[a * 3 + 1]!, P[a * 3 + 2]!], B: V3 = [P[b * 3]!, P[b * 3 + 1]!, P[b * 3 + 2]!], C: V3 = [P[c * 3]!, P[c * 3 + 1]!, P[c * 3 + 2]!]
    if (Math.abs(area) > 1e-9) {
      const e1 = sub(B, A), e2 = sub(C, A)
      const area3 = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
      // 线性拉伸：sqrt(三维面积 / UV 面积)，UV 面积按参考尺度换成米 / linear stretch: sqrt(3D area / UV area), the UV area converted to metres at the reference scale
      stretch.push(Math.sqrt(area3 / (Math.abs(area) * (extent / (T - 1)) ** 2)))
    }
    if (Math.abs(area) < 1e-9) continue
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(T - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(T - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / area, w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / area, w2 = 1 - w0 - w1
        if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue
        const px = w0 * A[0] + w1 * B[0] + w2 * C[0], py = w0 * A[1] + w1 * B[1] + w2 * C[1], pz = w0 * A[2] + w1 * B[2] + w2 * C[2]
        // 重叠处保留离轴最远（最外面）的那一层 / where the chart overlaps, the layer farthest from the axis (outermost) is kept
        const r = Math.hypot(px - axis.x, pz - axis.z)
        const k = y * T + x
        if (r <= depth[k]!) continue
        depth[k] = r
        ;(pos[k * 3] = px), (pos[k * 3 + 1] = py), (pos[k * 3 + 2] = pz)
      }
    }
  }
  stretch.sort((a, b) => a - b)
  const q = (f: number): number => +(stretch[Math.min(stretch.length - 1, Math.floor(f * stretch.length))] ?? 0).toFixed(3)

  // —— 标志点 / landmarks ——
  const surf = new Surface(skin)
  const front = (x: number, y: number): V3 | null => {
    const h = surf.firstHit([x, y, 1], [x, y, -1])
    return h ? [x, y, 1 - h.distance] : null
  }
  const chan = (id: string) => face.channels.find((c) => c.id === id)
  const avgY = (id: string, end: 'originOnSkin' | 'insertionOnSkin'): number | null => {
    const l = chan(`${id}_L`), r = chan(`${id}_R`)
    return l && r ? (l.line[end][1] + r.line[end][1]) / 2 : null
  }
  const browY = avgY('corrugator', 'originOnSkin'), nasionY = avgY('procerus', 'originOnSkin')
  const lines: DetailBuild['lines'] = []
  const skipped: string[] = []
  const resolve = (w: WrinkleDef, side: 1 | -1): ((f: number, a: number, dy: number) => [number, number] | null) => {
    const eye = eyes.find((e) => (e.side === 'L') === (side === 1))!
    const fis = eye.skinFissure ?? eye.fissure
    const S = side === 1 ? 'L' : 'R'
    return (f, a, dy) => {
      if (w.ref === 'brow') return browY === null ? null : [mid + side * a, browY + dy * MM]
      if (w.ref === 'nasion') return nasionY === null ? null : [mid + (w.midline ? a : side * a) * MM, nasionY + dy * MM]
      if (!fis || fis.lowerY === undefined || fis.upperY === undefined) return w.ref === 'canthus' || w.ref === 'lowerLid' || w.ref === 'lowerLidMedial' ? null : resolveMouth(w, side, S, f, a, dy)
      const medial = side === 1 ? fis.x0 : fis.x1, lateral = side === 1 ? fis.x1 : fis.x0
      if (w.ref === 'canthus') return [lateral + side * a * MM, (fis.lowerY + fis.upperY) / 2 + dy * MM]
      if (w.ref === 'lowerLid') return [medial + a * (lateral - medial), fis.lowerY + dy * MM]
      if (w.ref === 'lowerLidMedial') return [medial + side * a * MM, fis.lowerY + dy * MM]
      return resolveMouth(w, side, S, f, a, dy)
    }
  }
  const resolveMouth = (w: WrinkleDef, side: 1 | -1, S: string, f: number, a: number, dy: number): [number, number] | null => {
    const mod = chan(`zygomaticus_major_${S}`)?.line.insertionOnSkin
    if (!mod) return null
    if (w.ref === 'modiolus') return [mod[0] + side * a * MM, mod[1] + dy * MM]
    const ala = chan(`llsan_${S}`)?.line.insertionOnSkin
    if (!ala) return null
    const A = [ala[0] + side * 3 * MM, ala[1]], M = [mod[0] + side * 5 * MM, mod[1] + 2 * MM]
    return [A[0]! + (M[0]! - A[0]!) * f + side * (w.bowMm ?? 0) * MM * Math.sin(Math.PI * f), A[1]! + (M[1]! - A[1]!) * f]
  }
  // 'brow' 的 a 也是毫米 / the `a` of 'brow' is millimetres too
  const SEG = 28

  // —— 各层的高度场和法线 / height field and normals per layer ——
  const rows = Math.ceil(cur.layers.length / cur.columns)
  const img = new Image(cur.columns * T, rows * T, [128, 128, 255])
  const layers: FaceDetail['layers'] = []
  cur.layers.forEach((layer, li) => {
    const h = new Float32Array(T * T)
    let drawn = 0, maxDepth = 0
    for (const w of layer.wrinkles) {
      for (const side of (w.midline ? [1] : [1, -1]) as (1 | -1)[]) {
        const at = resolve(w, side)
        const [p0, p1, p2] = w.points as [[number, number], [number, number], [number, number]]
        const pts: V3[] = []
        let ok = true
        for (let i = 0; i <= SEG && ok; i++) {
          // 过三个控制点的二次插值 / quadratic interpolation through the three control points
          const t = i / SEG, l0 = 2 * (t - 0.5) * (t - 1), l1 = -4 * t * (t - 1), l2 = 2 * t * (t - 0.5)
          const a = l0 * p0[0] + l1 * p1[0] + l2 * p2[0], dy = l0 * p0[1] + l1 * p1[1] + l2 * p2[1]
          const xy = w.ref === 'brow' ? ((browY === null ? null : [mid + side * a * MM, browY + dy * MM]) as [number, number] | null) : w.ref === 'alaToModiolus' ? at(t, 0, 0) : at(t, a, dy)
          const p = xy ? front(xy[0], xy[1]) : null
          if (!p) ok = false
          else pts.push(p)
        }
        if (!ok) {
          skipped.push(`${layer.id}: ${w.ref} (${side === 1 ? 'L' : 'R'})`)
          continue
        }
        lines.push({ layer: layer.id, points: pts })
        drawn++
        maxDepth = Math.max(maxDepth, w.depthMm * MM)
        // 折线在 UV 里的范围，向外放宽 / the polyline's extent in UV, widened
        let x0 = T, x1 = 0, yy0 = T, yy1 = 0
        for (const p of pts) {
          const [u, v] = toUv(p[0], p[1], p[2])
          const x = u * (T - 1), y = (1 - v) * (T - 1)
          ;(x0 = Math.min(x0, x)), (x1 = Math.max(x1, x)), (yy0 = Math.min(yy0, y)), (yy1 = Math.max(yy1, y))
        }
        const sigma = w.widthMm * MM, reachM = 4 * sigma
        const pad = Math.ceil((reachM / (extent / (T - 1))) * 4) + 2
        const total = pts.length - 1
        for (let y = Math.max(0, Math.floor(yy0) - pad); y <= Math.min(T - 1, Math.ceil(yy1) + pad); y++) {
          for (let x = Math.max(0, Math.floor(x0) - pad); x <= Math.min(T - 1, Math.ceil(x1) + pad); x++) {
            const k = y * T + x
            const qx = pos[k * 3]!
            if (Number.isNaN(qx)) continue
            const qy = pos[k * 3 + 1]!, qz = pos[k * 3 + 2]!
            let best = Infinity, bestS = 0
            for (let i = 0; i < total; i++) {
              const a = pts[i]!, b = pts[i + 1]!
              const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2]
              const l2 = ex * ex + ey * ey + ez * ez
              const tt = l2 > 0 ? Math.min(1, Math.max(0, ((qx - a[0]) * ex + (qy - a[1]) * ey + (qz - a[2]) * ez) / l2)) : 0
              const d = Math.hypot(qx - a[0] - ex * tt, qy - a[1] - ey * tt, qz - a[2] - ez * tt)
              if (d < best) (best = d), (bestS = (i + tt) / total)
            }
            if (best > reachM) continue
            // 两端渐隐；沟的两侧各有一道低矮的隆起（被挤起的皮肤）
            // fade at both ends; a low ridge on either side of the furrow (the skin pushed up)
            const taper = smooth(bestS / 0.25) * smooth((1 - bestS) / 0.25)
            const g = Math.exp(-(best * best) / (2 * sigma * sigma)), ridge = Math.exp(-((best - 2.2 * sigma) ** 2) / (2 * (0.9 * sigma) ** 2))
            h[k] = h[k]! + w.depthMm * MM * taper * (0.3 * ridge - g)
          }
        }
      }
    }
    const col = li % cur.columns, row = Math.floor(li / cur.columns)
    const dist = (a: number, b: number): number => Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!)
    for (let y = 1; y < T - 1; y++) {
      for (let x = 1; x < T - 1; x++) {
        const k = y * T + x
        if (Number.isNaN(pos[k * 3]!)) continue
        let gx = 0, gy = 0
        const l = k - 1, r = k + 1, up = k - T, dn = k + T
        if (!Number.isNaN(pos[l * 3]!) && !Number.isNaN(pos[r * 3]!)) {
          const d = dist(l, r)
          if (d > 1e-7) gx = (h[r]! - h[l]!) / d
        }
        // v 向上增大，图像的行向下 / v grows upwards, image rows grow downwards
        if (!Number.isNaN(pos[up * 3]!) && !Number.isNaN(pos[dn * 3]!)) {
          const d = dist(up, dn)
          if (d > 1e-7) gy = (h[up]! - h[dn]!) / d
        }
        if (gx === 0 && gy === 0) continue
        // 斜率限制在 ±2，防止展开很差的地方（鼻孔缘）出尖刺 / slopes are limited to ±2 against spikes where the unwrap is poor (nostril rims)
        gx = Math.max(-2, Math.min(2, gx))
        gy = Math.max(-2, Math.min(2, gy))
        const n = 1 / Math.hypot(gx, gy, 1)
        const o = ((row * T + y) * img.width + col * T + x) * 3
        img.data[o] = Math.round((-gx * n * 0.5 + 0.5) * 255)
        img.data[o + 1] = Math.round((-gy * n * 0.5 + 0.5) * 255)
        img.data[o + 2] = Math.round((n * 0.5 + 0.5) * 255)
      }
    }
    layers.push({ id: layer.id, name: layer.name, tile: [col, row], drivers: layer.drivers, wrinkles: drawn, maxDepth: +maxDepth.toFixed(6), basis: layer.basis })
  })
  const atlas = img.png()
  const detail: FaceDetail = {
    schema: 1,
    body: face.body,
    note: { zh: '表情性皱纹的细节层：面部 UV 和按动作单元混合的法线贴图。皱纹按解剖关系程序化生成，没有使用任何人的照片；条数和尺寸是假设。这是疼痛行为的计算模型，用于教学；模拟人并没有主观感受。', en: 'The detail layer of expression wrinkles: a face UV chart and normal maps blended by action unit. The wrinkles are generated procedurally from anatomical relations; no photograph of any person was used; counts and sizes are assumptions. This is a computational model of pain behaviour for teaching; the simulated body has no subjective experience.' },
    skin: face.skin,
    vertexCount: nv,
    inputs: {},
    uv: { file: 'uv.bin', count, projection: { kind: 'cylindrical', axis: { x: +axis.x.toFixed(6), z: +axis.z.toFixed(6) }, radius, y0: +(y0 - ((1 - (y1 - y0) / extent) / 2) * extent).toFixed(6), extent: +extent.toFixed(6) }, texel: +(extent / (T - 1)).toFixed(7), stretch: { triangles: tris, flipped: +(flipped / Math.max(1, tris)).toFixed(4), p05: q(0.05), median: q(0.5), p95: q(0.95), max: q(0.9999) } },
    atlas: { file: 'wrinkles.png', width: img.width, height: img.height, tile: T, columns: cur.columns, rows, bytes: atlas.length },
    curve: { gamma: cur.curve.gamma },
    layers,
    convention: { zh: '切线空间：x 沿 u 增大的方向（身体左侧），y 沿 v 增大的方向（向上），z 沿表面法线向外；rgb = n · 0.5 + 0.5（OpenGL 约定，绿色向上）。法线贴图按线性数据读取，不做 sRGB 解码。', en: 'Tangent space: x along increasing u (towards the body\'s left), y along increasing v (up), z out along the surface normal; rgb = n · 0.5 + 0.5 (the OpenGL convention, green up). The normal map is read as linear data, without sRGB decoding.' },
    cautions: [
      { zh: '皱纹的条数、长度、间距、深度和强度曲线都是假设；每个人的皱纹不同，这里每种只画了一种典型样式，男女相同。', en: 'Count, length, spacing, depth and the intensity curve of the wrinkles are assumptions; wrinkles differ between people, and only one canonical pattern of each kind is drawn, the same for both sexes.' },
      { zh: '细节只改变光照用的法线，不改变轮廓：侧面看沟纹没有深度，沟里也没有阴影。', en: 'The detail only changes the normal used for lighting, not the silhouette: seen side-on the furrows have no depth, and they cast no shadow.' },
      { zh: '柱面展开在鼻侧壁、鼻孔缘和睑缘褶皱处被压缩或重叠（见 uv.stretch）；皱纹是按三维距离画的，所以宽度不受影响，但这些地方的纹素较粗。', en: 'The cylindrical unwrap is compressed or overlaps on the nasal sidewalls, nostril rims and lid-margin folds (see uv.stretch); the wrinkles are drawn by 3D distance, so their width is unaffected, but texels are coarser there.' },
    ],
  }
  return { detail, uvBin, atlas, uv, lines, skipped }
}
