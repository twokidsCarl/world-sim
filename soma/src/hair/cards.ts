// 解码发片（格式见 src/look/types.ts 的 HairLod），生成带状三角形，并按皮肤当前的静止位置算出顶点位置。
// Decoding hair cards (format: HairLod in src/look/types.ts), building the strip triangles, and computing vertex
// positions from the skin's current rest positions.

import type { HairLod } from '../look/types.ts'

export interface DecodedLod {
  lod: HairLod
  cards: number
  rings: number
  /** 根的皮肤三角形（3 个顶点）和重心坐标（3 个，和为 1）/ root skin triangle (3 vertices) and barycentric weights (3, summing to 1) */
  rootVerts: Uint32Array
  rootBary: Float32Array
  /** 顶点相对根的位移（米）/ vertex offset from its root (m) */
  offset: Float32Array
  /** 发丝走向（单位向量）/ strand direction (unit) */
  tangent: Float32Array
  /** 层（0–1）和每张发片的随机数（0–1）/ layer (0–1) and a random number per card (0–1) */
  layer: Float32Array
  random: Float32Array
  uv: Float32Array
  index: Uint32Array
}

const pad = (n: number): number => (n + 3) & ~3

/** 一层的字节数 / byte length of one level */
export function lodBytes(lod: HairLod): number {
  const C = lod.cards, V = C * (lod.segments + 1) * 2
  return C * 12 + pad(C * 4) + pad(V * 6) + V * 4 + V * 4
}

/** 解码一层；越界或下标不对就抛错 / decode one level; throws on out-of-range data */
export function decodeLod(bin: Uint8Array, lod: HairLod, offsetUnit: number, skinVertexCount: number): DecodedLod {
  const C = lod.cards, R = lod.segments + 1, V = C * R * 2
  if (lod.offset + lodBytes(lod) > bin.byteLength) throw new Error(`hair cards: level at ${lod.offset} runs past the end of the file`)
  const copy = bin.slice(lod.offset, lod.offset + lodBytes(lod))
  let o = 0
  const rootVerts = new Uint32Array(copy.buffer, o, C * 3)
  o += C * 12
  const bary16 = new Uint16Array(copy.buffer, o, C * 2)
  o += pad(C * 4)
  const off16 = new Int16Array(copy.buffer, o, V * 3)
  o += pad(V * 6)
  const tan8 = new Int8Array(copy.buffer, o, V * 4)
  o += V * 4
  const uv16 = new Uint16Array(copy.buffer, o, V * 2)
  for (let i = 0; i < rootVerts.length; i++) if (rootVerts[i]! >= skinVertexCount) throw new Error(`hair cards: root vertex ${rootVerts[i]} is beyond the skin (${skinVertexCount})`)
  const rootBary = new Float32Array(C * 3)
  for (let c = 0; c < C; c++) {
    const w1 = bary16[c * 2]! / 65535, w2 = bary16[c * 2 + 1]! / 65535
    rootBary.set([Math.max(0, 1 - w1 - w2), w1, w2], c * 3)
  }
  const offset = new Float32Array(V * 3)
  for (let i = 0; i < V * 3; i++) offset[i] = off16[i]! * offsetUnit
  const tangent = new Float32Array(V * 3), layer = new Float32Array(V), random = new Float32Array(V)
  for (let v = 0; v < V; v++) {
    const x = tan8[v * 4]!, y = tan8[v * 4 + 1]!, z = tan8[v * 4 + 2]!
    const l = Math.hypot(x, y, z) || 1
    tangent[v * 3] = x / l
    tangent[v * 3 + 1] = y / l
    tangent[v * 3 + 2] = z / l
    layer[v] = Math.max(0, tan8[v * 4 + 3]!) / 127
    const c = Math.floor(v / (R * 2))
    random[v] = ((Math.imul(c + 1, 2654435761) >>> 0) % 1000) / 1000
  }
  const uv = new Float32Array(V * 2)
  for (let i = 0; i < V * 2; i++) uv[i] = uv16[i]! / 65535
  return { lod, cards: C, rings: R, rootVerts, rootBary, offset, tangent, layer, random, uv, index: stripIndex(C, R) }
}

/** 每张发片一条带子：环 r 的左右两个顶点和环 r+1 的组成两个三角形 / one strip per card: the left and right vertices of ring r and ring r+1 make two triangles */
export function stripIndex(cards: number, rings: number): Uint32Array {
  const out = new Uint32Array(cards * (rings - 1) * 6)
  let k = 0
  for (let c = 0; c < cards; c++) {
    for (let r = 0; r + 1 < rings; r++) {
      const a = (c * rings + r) * 2
      out[k++] = a
      out[k++] = a + 1
      out[k++] = a + 2
      out[k++] = a + 1
      out[k++] = a + 3
      out[k++] = a + 2
    }
  }
  return out
}

/**
 * 顶点的静止位置 = 根（皮肤当前静止位置上按重心坐标插值）+ 位移。皮肤因体型、表情、软组织偏移而动，根跟着动。
 * Vertex rest position = root (interpolated by barycentric weights on the skin's current rest positions) + offset. The
 * skin moves with shape, expression and soft-tissue offset; the roots follow.
 */
export function placeVertices(d: DecodedLod, skin: ArrayLike<number>, out: Float32Array): void {
  const perCard = d.rings * 2
  for (let c = 0; c < d.cards; c++) {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 3; k++) {
      const v = d.rootVerts[c * 3 + k]! * 3, w = d.rootBary[c * 3 + k]!
      x += skin[v]! * w
      y += skin[v + 1]! * w
      z += skin[v + 2]! * w
    }
    for (let j = 0; j < perCard; j++) {
      const i = (c * perCard + j) * 3
      out[i] = x + d.offset[i]!
      out[i + 1] = y + d.offset[i + 1]!
      out[i + 2] = z + d.offset[i + 2]!
    }
  }
}

/** 每张发片取根三角形里权重最大的那个皮肤顶点：蒙皮影响照抄它 / per card, the root triangle's skin vertex with the largest weight: skinning influences are copied from it */
export function dominantVertex(d: DecodedLod, c: number): number {
  let best = 0
  for (let k = 1; k < 3; k++) if (d.rootBary[c * 3 + k]! > d.rootBary[c * 3 + best]!) best = k
  return d.rootVerts[c * 3 + best]!
}

/**
 * 每个发片顶点最近的皮肤顶点（按静止位置）。贴着皮肤的毛（胡须、阴毛、腋毛）每个顶点照抄它的蒙皮影响：皮肤在大幅姿势下
 * 拉伸、转动时，发片沿整条跟着那一片皮肤走，不会像按根刚性连着那样离开皮肤。
 * The nearest skin vertex of every card vertex (by rest position). For hair lying on the skin (beard, pubic, axillary)
 * each vertex copies its skinning influences: when the skin stretches and turns in a large pose, the card follows that
 * patch of skin along its whole length instead of leaving it, as it would if rigidly tied to its root.
 */
export function surfaceAnchors(cardPos: Float32Array, skin: ArrayLike<number>, normals?: ArrayLike<number>, d?: DecodedLod): Uint32Array {
  const n = cardPos.length / 3
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, cardPos[i * 3 + k]!)
      hi[k] = Math.max(hi[k]!, cardPos[i * 3 + k]!)
    }
  }
  const pad = 0.03
  lo = lo.map((v) => v - pad)
  hi = hi.map((v) => v + pad)
  const C = 0.01
  const grid = new Map<number, number[]>()
  const key = (x: number, y: number, z: number): number => (Math.floor(x / C) + 1000) * 4000000 + (Math.floor(y / C) + 1000) * 2000 + (Math.floor(z / C) + 1000)
  const nv = skin.length / 3
  for (let v = 0; v < nv; v++) {
    const x = skin[v * 3]!, y = skin[v * 3 + 1]!, z = skin[v * 3 + 2]!
    if (x < lo[0]! || y < lo[1]! || z < lo[2]! || x > hi[0]! || y > hi[1]! || z > hi[2]!) continue
    const k = key(x, y, z)
    const l = grid.get(k)
    if (l) l.push(v)
    else grid.set(k, [v])
  }
  // 只取与根同一面的皮肤顶点（法线与根的法线夹角小于 60°）：腋窝里臂和胸壁的皮肤贴在一起，最近的顶点可能在对面
  // only skin vertices on the root's side (normal within 60° of the root's): in the axilla the arm and chest skin lie together, and the nearest vertex can be on the opposite side
  const per = d ? d.rings * 2 : 0
  const rootN = new Float64Array(3)
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const x = cardPos[i * 3]!, y = cardPos[i * 3 + 1]!, z = cardPos[i * 3 + 2]!
    let best = d ? dominantVertex(d, Math.floor(i / per)) : 0, bd = Infinity
    if (normals && d) {
      rootN.fill(0)
      const c = Math.floor(i / per)
      for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) rootN[j] = rootN[j]! + normals[d.rootVerts[c * 3 + k]! * 3 + j]! * d.rootBary[c * 3 + k]!
    }
    for (let r = 1; r <= 3 && bd === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        const l = grid.get(key(x + dx * C, y + dy * C, z + dz * C))
        if (!l) continue
        for (const v of l) {
          if (normals && d && normals[v * 3]! * rootN[0]! + normals[v * 3 + 1]! * rootN[1]! + normals[v * 3 + 2]! * rootN[2]! < 0.5 * Math.hypot(rootN[0]!, rootN[1]!, rootN[2]!)) continue
          const e = (skin[v * 3]! - x) ** 2 + (skin[v * 3 + 1]! - y) ** 2 + (skin[v * 3 + 2]! - z) ** 2
          if (e < bd) (bd = e), (best = v)
        }
      }
    }
    out[i] = best
  }
  return out
}
