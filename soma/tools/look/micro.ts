// 入口：bun tools/look/micro.ts — 生成写实皮肤的微细起伏贴图（可平铺，程序化，种子固定，结果逐字节确定）。
// Entry point: bun tools/look/micro.ts — build the lifelike skin's micro-relief tile (tileable, procedural, fixed
// seed, byte-for-byte deterministic).
//
// 输出 / output: public/anatomy/<body>/look/skin-micro.png（两个人体同一份 / the same file for both bodies）
//   512² RGB，一块代表 TILE_MM × TILE_MM 的皮肤；每个通道是一层的高度，128 = 平均面，0 最深。
//   512² RGB; one tile stands for TILE_MM × TILE_MM of skin; each channel is the height of one layer, 128 = the mean
//   surface, 0 the deepest.
//   R  面部毛孔 / facial pores：Flament 等 2015（2,585 名女性颊部）：密度约 10–80 个/cm²，平均面积 0.03–0.22 mm²；
//      这里取 40 个/cm²、面积对数正态、中位 0.08 mm²（取值在其范围内，具体数是假设）
//      Flament et al. 2015 (cheeks of 2,585 women): density about 10–80 per cm², mean area 0.03–0.22 mm²; here 40 per
//      cm² with a log-normal area of median 0.08 mm² (within their ranges; the exact values are assumed)
//   G  身体的微细纹理 / body micro-relief：细小的毛囊口（120 个/cm²、直径约 0.08 mm）加三组交叉的皮沟（间距 0.5–0.9 mm），都是假设
//      fine follicular openings (120 per cm², about 0.08 mm across) plus three crossing families of skin furrows (0.5–0.9 mm apart); all assumed
//   B  皮嵴 / epidermal ridges：迷宫状的带通噪声，周期 0.45 mm（成人嵴宽约 0.4–0.5 mm 的量级；纹型不是真实指纹）
//      labyrinth-like band-pass noise with a 0.45 mm period (the order of adult ridge breadth, about 0.4–0.5 mm; not a real fingerprint pattern)
//
// 所有成分都在整数格点上取波矢或按环绕距离计算，所以贴图严格可平铺。
// Every component uses wave vectors on the integer lattice or wrap-around distances, so the tile is strictly tileable.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Image } from '../rig/render.ts'

export const MICRO_SIZE = 512
export const TILE_MM = 10
const SEED = 20261015

/** 确定的伪随机数（mulberry32）/ deterministic pseudo-random numbers (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 环面上的周期噪声：格点波矢 |k| ∈ [k0, k1] 的余弦和，振幅 ∝ |k|^−p / periodic noise on the torus: a sum of cosines with lattice wave vectors |k| ∈ [k0, k1], amplitude ∝ |k|^−p */
function torusNoise(rand: () => number, k0: number, k1: number, p: number, dir?: { angle: number; spread: number }): (x: number, y: number) => number {
  const waves: [number, number, number, number][] = []
  const K = Math.ceil(k1)
  for (let i = -K; i <= K; i++) {
    for (let j = 0; j <= K; j++) {
      if (j === 0 && i <= 0) continue
      const k = Math.hypot(i, j)
      if (k < k0 || k > k1) continue
      if (dir) {
        // 只留方向在 angle ± spread 内的波（得到大致平行的嵴）/ keep only waves within angle ± spread (giving roughly parallel ridges)
        let d = Math.atan2(j, i) - dir.angle
        d = Math.atan2(Math.sin(2 * d), Math.cos(2 * d)) / 2
        if (Math.abs(d) > dir.spread) continue
      }
      waves.push([i, j, rand() * Math.PI * 2, k ** -p * (0.5 + rand())])
    }
  }
  const norm = Math.sqrt(waves.reduce((s, w) => s + w[3] * w[3], 0) / 2) || 1
  return (x, y) => {
    let s = 0
    for (const [i, j, ph, a] of waves) s += a * Math.cos(2 * Math.PI * (i * x + j * y) + ph)
    return s / norm
  }
}

/** 环绕距离下散布的点（最小间距的投镖法）/ points scattered with wrap-around distances (dart throwing with a minimum spacing) */
function scatter(rand: () => number, n: number, minDist: number): [number, number][] {
  const pts: [number, number][] = []
  let tries = 0
  while (pts.length < n && tries < n * 200) {
    tries++
    const x = rand(), y = rand()
    const ok = pts.every(([px, py]) => {
      const dx = Math.abs(x - px), dy = Math.abs(y - py)
      return Math.hypot(Math.min(dx, 1 - dx), Math.min(dy, 1 - dy)) >= minDist
    })
    if (ok) pts.push([x, y])
  }
  return pts
}

/** 把一组凹坑加到高度场上（环绕）/ add a set of pits to a height field (wrapping) */
function addPits(h: Float32Array, size: number, pits: { x: number; y: number; r: number; depth: number }[]): void {
  for (const p of pits) {
    const rp = p.r * size
    const R = Math.ceil(rp * 1.6)
    const cx = p.x * size, cy = p.y * size
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const px = Math.floor(cx) + dx, py = Math.floor(cy) + dy
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / rp
        if (d >= 1.5) continue
        // 漏斗状的坑，外缘有一圈很浅的隆起 / a funnel-shaped pit with a very shallow raised rim
        const v = d < 1 ? -p.depth * (1 - d * d) ** 2 : p.depth * 0.08 * Math.sin(((d - 1) / 0.5) * Math.PI)
        const ix = ((px % size) + size) % size, iy = ((py % size) + size) % size
        h[iy * size + ix] = h[iy * size + ix]! + v
      }
    }
  }
}

function lognormal(rand: () => number, median: number, sigma: number): number {
  const u = Math.max(1e-9, rand()), v = rand()
  return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v))
}

export interface MicroLayers {
  size: number
  /** 每层的高度，约在 [−1, 1] / each layer's height, roughly in [−1, 1] */
  pores: Float32Array
  body: Float32Array
  ridges: Float32Array
  /** 面部毛孔：个数（每块 TILE_MM²）和各自的面积（mm²），标定对照表用 / facial pores: their count (per TILE_MM² tile) and each area (mm²), for the calibration tables */
  facePores: { count: number; tileCm2: number; areasMm2: number[] }
}

export function buildMicro(size = MICRO_SIZE, seed = SEED): MicroLayers {
  const rand = rng(seed)
  const mm = 1 / TILE_MM // 每毫米占贴图的比例 / tile fraction per millimetre
  const n = size * size
  const at = (f: (x: number, y: number) => number): Float32Array => {
    const out = new Float32Array(n)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = f((x + 0.5) / size, (y + 0.5) / size)
    return out
  }
  // ── 面部毛孔 / facial pores ──
  const area = (TILE_MM / 10) ** 2 // cm²
  const facePts = scatter(rand, Math.round(40 * area), 0.7 * mm)
  const pores = at(torusNoise(rand, 10, 24, 1)).map((v) => v * 0.06)
  const areasMm2: number[] = []
  addPits(pores, size, facePts.map(([x, y]) => {
    const a = Math.min(0.3, Math.max(0.025, lognormal(rand, 0.08, 0.5))) // mm²
    areasMm2.push(a)
    return { x, y, r: Math.sqrt(a / Math.PI) * mm, depth: 0.7 + 0.3 * rand() }
  }))
  // ── 身体：细毛孔 + 交叉皮沟 / body: fine pores + crossing furrows ──
  const finePts = scatter(rand, Math.round(120 * area), 0.45 * mm)
  const body = new Float32Array(n)
  const wobble = torusNoise(rand, 2, 6, 1)
  const depthMod = torusNoise(rand, 3, 9, 1)
  const families: { a: [number, number]; m: number; w: number; d: number }[] = [
    { a: [1, 1], m: Math.round(TILE_MM / 0.75 / Math.SQRT2), w: 0.03, d: 0.9 },
    { a: [1, -1], m: Math.round(TILE_MM / 0.85 / Math.SQRT2), w: 0.03, d: 0.8 },
    { a: [1, 0], m: Math.round(TILE_MM / 0.55), w: 0.022, d: 0.45 },
  ]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size
      let h = 0
      for (const f of families) {
        const norm = Math.hypot(f.a[0], f.a[1])
        // 线族 {a·x = k/m}：a 是整数向量，所以可平铺 / the line family {a·x = k/m}: a is an integer vector, so it tiles
        const s = (f.a[0] * u + f.a[1] * v) * f.m + 0.12 * wobble(u + 0.3, v)
        const dist = (Math.abs(s - Math.round(s)) / (f.m * norm)) * TILE_MM // mm
        h -= f.d * Math.max(0, 0.45 + 0.75 * depthMod(u, v + 0.17 * f.m)) * Math.exp(-((dist / f.w) ** 2))
      }
      body[y * size + x] = 0.55 * h
    }
  }
  addPits(body, size, finePts.map(([x, y]) => ({ x, y, r: (0.04 + 0.015 * rand()) * mm, depth: 0.5 + 0.3 * rand() })))
  // ── 皮嵴：环形格点上的带通噪声，过一个软阈值成迷宫状 / ridges: band-pass noise on a lattice ring, through a soft threshold into a labyrinth ──
  const ring = TILE_MM / 0.45
  const band = torusNoise(rand, ring - 1.2, ring + 1.2, 0, { angle: 0.3, spread: 0.45 })
  const ridges = at((x, y) => Math.tanh(1.6 * band(x, y)))
  return { size, pores, body, ridges, facePores: { count: facePts.length, tileCm2: area, areasMm2 } }
}

/** 三层合成 RGB8：128 + 127·h / pack the three layers into RGB8: 128 + 127·h */
export function packMicro(m: MicroLayers): Uint8Array {
  const out = new Uint8Array(m.size * m.size * 3)
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(128 + 127 * v)))
  for (let i = 0; i < m.size * m.size; i++) {
    out[i * 3] = q(m.pores[i]!)
    out[i * 3 + 1] = q(m.body[i]!)
    out[i * 3 + 2] = q(m.ridges[i]!)
  }
  return out
}

function main(): void {
  const root = join(import.meta.dirname, '..', '..')
  const t0 = performance.now()
  const packed = packMicro(buildMicro())
  const img = new Image(MICRO_SIZE, MICRO_SIZE)
  img.data.set(packed)
  const png = img.png()
  for (const body of ['male', 'female']) {
    const dir = join(root, 'public', 'anatomy', body, 'look')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skin-micro.png'), png)
  }
  console.log(`skin-micro.png: ${MICRO_SIZE}², ${(png.length / 1024).toFixed(0)} kB, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

if (import.meta.main) main()
