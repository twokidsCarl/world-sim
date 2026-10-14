// 入口：bun tools/hair/build.ts [male|female …] — 程序化生成头发（短、长）、眉毛、睫毛，做成发片和贴图集。
// Entry point: bun tools/hair/build.ts [male|female …] — procedurally grow scalp hair (short, long), eyebrows and
// eyelashes, and turn them into hair cards and a card atlas.
//
// 输入 / inputs
//   public/anatomy/<body>/ 的皮肤（integumentary GLB）、头发和眉毛外壳、look/skin-uv.*、face/openings.json
//   data/curated/hair/hair.json                 文献数值和出处 / the literature values and their sources
// 输出 / outputs
//   public/anatomy/<body>/hair/hair.json        说明（格式见 src/look/types.ts 的 HairData）/ description (format: HairData in src/look/types.ts)
//   public/anatomy/<body>/hair/<piece>.cards.bin 发片 / the cards
//   public/anatomy/<body>/hair/atlas-a.png、atlas-b.png 贴图集 / the atlas
//   data/raw/hair/<body>/strands.json           引导发丝和统计（不入库，本机测试用）/ guide strands and statistics (not in git; for local tests)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HairData, HairLod, HairPiece, HairPieceId } from '../../src/look/types.ts'
import { ATLAS_SIZE, Atlas, type CardKind, DEPTH_RANGE, TILES, renderTile, tileRect } from './atlas.ts'
import { type Card, type CardOptions, makeCards } from './cards.ts'
import { browGroom, lashGroom, type Lash } from './face.ts'
import { type HeadFrame, earDistance, fromHead, headFrame, toHead, azimuth } from './frame.ts'
import { styleCoverage } from './coverage.ts'
import { Surface, type V3, dot, len, sub } from './geom.ts'
import { scalpGroom } from './groom.ts'
import { encodePng } from './png.ts'
import { EAR_MARGIN, follicles, loadParams, makeScalp, type Params } from './scalp.ts'
import { type BodyData, ROOT, loadBody } from './skin.ts'
import type { Strand } from './strands.ts'

const OFFSET_UNIT = 2e-5
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

interface LodSpec extends Omit<CardOptions, 'sequential'> {
  maxDistance: number
  /** 睫毛：每张发片几根 / lashes: lashes per card */
  perCard?: number
}

const SPECS: Record<HairPieceId, LodSpec[]> = {
  short: [
    { clusters: 0.38, segments: 5, minWidth: 0.006, maxWidth: 0.015, tipWidth: 0.6, orient: 'scalp', clearance: 0.0004, maxDistance: 1.2 },
    { clusters: 0.12, segments: 3, minWidth: 0.009, maxWidth: 0.024, tipWidth: 0.6, orient: 'scalp', clearance: 0.0006, maxDistance: 3 },
    { clusters: 0.045, segments: 2, minWidth: 0.014, maxWidth: 0.034, tipWidth: 0.6, orient: 'scalp', clearance: 0.001, maxDistance: Infinity },
  ],
  long: [
    { clusters: 0.4, segments: 14, minWidth: 0.008, maxWidth: 0.022, tipWidth: 0.45, orient: 'scalp', clearance: 0.0005, maxDistance: 1.2, smooth: 4 },
    { clusters: 0.13, segments: 8, minWidth: 0.011, maxWidth: 0.032, tipWidth: 0.45, orient: 'scalp', clearance: 0.0008, maxDistance: 3, smooth: 4 },
    { clusters: 0.05, segments: 5, minWidth: 0.016, maxWidth: 0.045, tipWidth: 0.5, orient: 'scalp', clearance: 0.0012, maxDistance: Infinity, smooth: 4 },
  ],
  brows: [
    { clusters: 0.34, segments: 3, minWidth: 0.0006, maxWidth: 0.0018, tipWidth: 0.6, orient: 'skin', clearance: 0.00015, maxDistance: 1.5 },
    { clusters: 0.15, segments: 2, minWidth: 0.001, maxWidth: 0.003, tipWidth: 0.6, orient: 'skin', clearance: 0.0002, maxDistance: Infinity },
  ],
  lashes: [
    { clusters: 0, perCard: 3, segments: 4, minWidth: 0.0007, maxWidth: 0.002, tipWidth: 0.7, orient: 'spread', clearance: 0.0002, maxDistance: 1.5 },
    { clusters: 0, perCard: 6, segments: 2, minWidth: 0.0012, maxWidth: 0.004, tipWidth: 0.7, orient: 'spread', clearance: 0.0002, maxDistance: Infinity },
  ],
}

const KIND: Record<HairPieceId, CardKind> = { short: 'short', long: 'long', brows: 'brow', lashes: 'lash' }

/** 睫毛按（链、排）分组、沿睑缘排序，每 n 根一张 / lashes grouped by (chain, row), ordered along the margin, n per card */
function lashGroups(lashes: Lash[], n: number): number[][] {
  const by = new Map<string, number[]>()
  lashes.forEach((l, i) => {
    const k = `${l.side},${l.upper},${l.row}`
    const g = by.get(k)
    if (g) g.push(i)
    else by.set(k, [i])
  })
  const out: number[][] = []
  for (const g of by.values()) {
    g.sort((a, b) => lashes[a]!.t - lashes[b]!.t)
    for (let i = 0; i < g.length; i += n) out.push(g.slice(i, i + n))
  }
  return out
}

/** 一层发片打包成二进制 / pack one level of cards into binary */
function packLod(cards: Card[], segments: number, kind: CardKind): Uint8Array {
  const C = cards.length, R = segments + 1, V = C * R * 2
  const pad = (n: number): number => (n + 3) & ~3
  const sizes = [C * 12, pad(C * 4), pad(V * 6), V * 4, V * 4]
  const buf = new Uint8Array(sizes.reduce((a, b) => a + b, 0))
  let o = 0
  const rootVerts = new Uint32Array(buf.buffer, o, C * 3)
  o += sizes[0]!
  const rootBary = new Uint16Array(buf.buffer, o, C * 2)
  o += sizes[1]!
  const offset = new Int16Array(buf.buffer, o, V * 3)
  o += sizes[2]!
  const tangent = new Int8Array(buf.buffer, o, V * 4)
  o += sizes[3]!
  const uv = new Uint16Array(buf.buffer, o, V * 2)
  const q16 = (v: number): number => Math.max(-32767, Math.min(32767, Math.round(v / OFFSET_UNIT)))
  cards.forEach((c, ci) => {
    rootVerts.set(c.root.verts, ci * 3)
    rootBary[ci * 2] = Math.round(c.root.bary[1] * 65535)
    rootBary[ci * 2 + 1] = Math.round(c.root.bary[2] * 65535)
    const [tx, ty, tw, th] = tileRect(kind, c.tile)
    for (let r = 0; r < R; r++) {
      const t = sub(c.centre[Math.min(R - 1, r + 1)]!, c.centre[Math.max(0, r - 1)]!)
      const l = len(t) || 1
      for (let s = 0; s < 2; s++) {
        const v = (ci * R + r) * 2 + s
        const p = c.verts[r * 2 + s]!
        for (let k = 0; k < 3; k++) offset[v * 3 + k] = q16(p[k]! - c.root.p[k]!)
        for (let k = 0; k < 3; k++) tangent[v * 4 + k] = Math.round((t[k]! / l) * 127)
        tangent[v * 4 + 3] = Math.round(c.layer * 127)
        // 贴图格内留半个像素的边 / half a pixel of margin inside the tile
        const u = tx + 0.5 + s * (tw - 1), vv = ty + 0.5 + (r / segments) * (th - 1)
        uv[v * 2] = Math.round((u / ATLAS_SIZE) * 65535)
        uv[v * 2 + 1] = Math.round((vv / ATLAS_SIZE) * 65535)
      }
    }
  })
  return buf
}

/** 弧长 / arc length */
const arcLength = (pts: V3[]): number => pts.slice(1).reduce((a, p, i) => a + len(sub(p, pts[i]!)), 0)
const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!
const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** 头皮上几个区域的毛囊密度（每平方厘米）：半径 1 厘米的圆片内计数 / follicle density in a few scalp regions (per cm²): a count within a 1 cm disc */
function regionDensity(f: HeadFrame, surface: Surface, pts: V3[]): Record<string, number> {
  const probe = (dir: V3): V3 | null => {
    const d = surface.ray(f.origin, dir, 0.4)
    return isFinite(d) ? [f.origin[0] + dir[0] * d, f.origin[1] + dir[1] * d, f.origin[2] + dir[2] * d] : null
  }
  const at = (l: V3): V3 => {
    const w = sub(fromHead(f, l), f.origin)
    const n = len(w)
    return [w[0] / n, w[1] / n, w[2] / n]
  }
  const regions: Record<string, V3> = { vertex: at([0, 1, -0.25]), occipital: at([0, 0.35, -1]), frontal: at([0.15, 0.9, 0.55]), temporal: at([0.95, 0.45, 0.15]) }
  const out: Record<string, number> = {}
  for (const [k, dir] of Object.entries(regions)) {
    const c = probe(dir)
    if (!c) continue
    let n = 0
    for (const p of pts) if (len(sub(p, c)) < 0.01) n++
    out[k] = Math.round(n / Math.PI)
  }
  return out
}

async function buildBody(body: 'male' | 'female', P: Params): Promise<void> {
  const t0 = performance.now()
  const b: BodyData = await loadBody(body)
  const surface = new Surface(b.skin.positions, b.skin.indices)
  const f = headFrame(b, surface)
  const scalp = makeScalp(b, f, P)
  const seed = body === 'male' ? 11 : 23
  const fol = follicles(b, scalp, surface, P, seed)
  let scalpArea = 0
  {
    // 头皮面积：毛囊单位按"每单位一个"的泊松盘撒出来，面积 = 单位数 / 单位密度（只算满密度的区域会偏小，这里按三角形积分）
    // scalp area: integrate over the triangles where the density is non-zero
    const P0 = b.skin.positions
    for (const [a, c, d] of scalp.triangles) {
      const pa: V3 = [P0[a * 3]!, P0[a * 3 + 1]!, P0[a * 3 + 2]!], pc: V3 = [P0[c * 3]!, P0[c * 3 + 1]!, P0[c * 3 + 2]!], pd: V3 = [P0[d * 3]!, P0[d * 3 + 1]!, P0[d * 3 + 2]!]
      const cen: V3 = [(pa[0] + pc[0] + pd[0]) / 3, (pa[1] + pc[1] + pd[1]) / 3, (pa[2] + pc[2] + pd[2]) / 3]
      const u = sub(pc, pa), v = sub(pd, pa)
      const area = len([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]) / 2
      if (scalp.density(cen) > 0) scalpArea += area
    }
  }
  const regions = regionDensity(f, surface, fol.follicles.map((x) => x.p))
  console.log(`${body}: ${fol.follicles.length} follicles in ${fol.units.length} units, scalp ${(scalpArea * 1e4).toFixed(0)} cm², regions ${JSON.stringify(regions)}`)

  const grooms: Record<HairPieceId, Strand[]> = { short: [], long: [], brows: [], lashes: [] }
  const extra: Record<HairPieceId, Record<string, number>> = { short: {}, long: {}, brows: {}, lashes: {} }
  for (const style of ['short', 'long'] as const) {
    const g = scalpGroom(b, f, surface, scalp, style, P, seed + (style === 'long' ? 100 : 0))
    grooms[style] = g.guides
    const wide = g.guides.filter((st) => Math.abs(toHead(f, st.pts[st.pts.length - 1]!)[0]) > 0.14).length
    console.log(`  ${style}: ${g.guides.length} guides, ${wide} tips beyond 14 cm sideways (${((performance.now() - t0) / 1000).toFixed(1)} s)`)
  }
  const brows = browGroom(b, f, surface, P, seed + 200)
  grooms.brows = brows.strands
  const lashes = lashGroom(b, f, surface, P, seed + 300)
  grooms.lashes = lashes
  extra.brows = { perSide: Math.round(brows.strands.length / 2), areaCm2PerSide: r3(brows.area * 1e4) }
  extra.lashes = {
    upperPerLid: Math.round(lashes.filter((l) => l.upper).length / 2),
    lowerPerLid: Math.round(lashes.filter((l) => !l.upper).length / 2),
    upperLengthMm: r3(pct(lashes.filter((l) => l.upper).map((l) => arcLength(l.pts) * 1000), 0.5)),
    lowerLengthMm: r3(pct(lashes.filter((l) => !l.upper).map((l) => arcLength(l.pts) * 1000), 0.5)),
  }
  const follicleTotal = fol.follicles.length
  for (const id of ['short', 'long'] as const) {
    extra[id] = {
      follicles: follicleTotal,
      units: fol.units.length,
      scalpAreaCm2: Math.round(scalpArea * 1e4),
      densityPerCm2: Math.round(follicleTotal / (scalpArea * 1e4)),
      ...Object.fromEntries(Object.entries(regions).map(([k, v]) => [`density_${k}`, v])),
    }
  }

  const outDir = join(ROOT, 'public', 'anatomy', body, 'hair')
  mkdirSync(outDir, { recursive: true })
  const atlas = new Atlas()
  const pieces: HairPiece[] = []
  for (const id of ['short', 'long', 'brows', 'lashes'] as HairPieceId[]) {
    const strands = grooms[id]
    const kind = KIND[id]
    const lods: HairLod[] = []
    const blobs: Uint8Array[] = []
    let offset = 0
    let lod0: Card[] = []
    SPECS[id].forEach((spec, li) => {
      const opts: CardOptions = { ...spec, clusters: Math.max(1, Math.round(strands.length * spec.clusters)), sequential: id === 'lashes' ? lashGroups(lashes, spec.perCard!) : undefined }
      const cards = makeCards(b, f, surface, strands, opts, seed + li * 13)
      for (const c of cards) c.tile %= TILES[kind].count
      if (li === 0) lod0 = cards
      const blob = packLod(cards, spec.segments, kind)
      lods.push({ cards: cards.length, segments: spec.segments, maxDistance: isFinite(spec.maxDistance) ? spec.maxDistance : 1e3, offset })
      blobs.push(blob)
      offset += blob.length
    })
    // 贴图格：从第 0 层里挑有代表性的发片 / tiles: representative cards picked from level 0
    const tiles = TILES[kind]
    const pool = lod0.filter((c) => c.members.length >= (id === 'lashes' ? 2 : 3))
    // 睫毛在贴图里画粗 1.8 倍：真实直径远小于一个像素，按真值画会几乎看不见（本项目的显示补偿，不是测量值）
    // lashes are drawn 1.8 times thicker in the atlas: the real diameter is far below a pixel and would all but vanish (this project's display compensation, not a measurement)
    const diameter = (id === 'brows' ? P.browDiameter.value : id === 'lashes' ? P.lashDiameter.value * 1.8 : P.fibreDiameter.value) / 1e6
    for (let t = 0; t < tiles.count; t++) {
      const card = pool[Math.floor(((t + 0.5) / tiles.count) * pool.length)] ?? lod0[t % lod0.length]!
      const w = card.width.reduce((a, x) => a + x, 0) / card.width.length
      // 插值的根数：让单层覆盖率约 0.7（−ln(1−0.7) × 宽 / 直径）/ interpolated strands: about 0.7 single-layer coverage (−ln(1−0.7) × width / diameter)
      const count = id === 'lashes' ? 0 : id === 'brows' ? 6 : Math.round(1.2 * (w / diameter))
      renderTile(atlas, tileRect(kind, t), card, strands, {
        kind,
        diameter,
        count,
        spread: id === 'brows' ? 0.0003 : 0.0024,
        clump: id === 'brows' ? 0.2 : 0.55,
        wander: id === 'long' ? 0.0012 : id === 'short' ? 0.0006 : 0.0001,
        seed: seed * 31 + t,
      })
    }
    const file = `${id}.cards.bin`
    const bin = new Uint8Array(offset)
    let o = 0
    for (const bl of blobs) bin.set(bl, o), (o += bl.length)
    writeFileSync(join(outDir, file), bin)
    const lengths = strands.map((s) => arcLength(s.pts) * 1000)
    pieces.push({
      id,
      file,
      bytes: bin.length,
      lods,
      stats: { strands: strands.length, lengthMmP10: r3(pct(lengths, 0.1)), lengthMmP50: r3(pct(lengths, 0.5)), lengthMmP90: r3(pct(lengths, 0.9)), ...extra[id] },
    })
    console.log(`  ${id}: ${lods.map((l) => `${l.cards}×${l.segments}`).join(', ')} cards, ${(bin.length / 1024).toFixed(0)} KiB`)
  }
  const { a, b: bImg } = atlas.encode()
  // 遮盖率检查 / the coverage check
  const coverage: Record<string, Record<string, number>> = {}
  for (const style of ['short', 'long'] as const) {
    const piece = pieces.find((p) => p.id === style)!
    const bin = new Uint8Array(readFileSync(join(outDir, piece.file)))
    const r = styleCoverage(b, f, surface, scalp, style, bin, piece.lods[0]!, OFFSET_UNIT, a, ATLAS_SIZE)
    coverage[style] = { all: r3(r.all), ...Object.fromEntries(Object.entries(r.views).map(([k, v]) => [k, r3(v)])) }
    console.log(`  coverage ${style}: ${JSON.stringify(coverage[style])}`)
  }
  // 头皮底色：每个头皮顶点离边界的带符号距离（毫米）/ the scalp tint: signed distance of each scalp vertex from the border (mm)
  const scalpDist = new Map<number, number>()
  for (const tri of scalp.triangles) {
    for (const v of tri) {
      if (scalpDist.has(v)) continue
      const p: V3 = [b.skin.positions[v * 3]!, b.skin.positions[v * 3 + 1]!, b.skin.positions[v * 3 + 2]!]
      const d = Math.min(scalp.aboveHairline(p), earDistance(f, toHead(f, p)) - EAR_MARGIN)
      scalpDist.set(v, Math.max(-127, Math.min(127, Math.round(d * 1000))))
    }
  }
  // 只留离头皮不到 1.5 厘米的三角形用到的顶点 / keep only vertices of triangles reaching within 1.5 cm of the scalp
  const keepV = new Set<number>()
  for (const tri of scalp.triangles) if (Math.max(...tri.map((v) => scalpDist.get(v)!)) > -15) for (const v of tri) keepV.add(v)
  const scalpVerts = [...keepV].sort((x, y) => x - y)
  const scalpBin = new Uint8Array(scalpVerts.length * 5)
  new Uint32Array(scalpBin.buffer, 0, scalpVerts.length).set(scalpVerts)
  scalpVerts.forEach((v, i) => (scalpBin[scalpVerts.length * 4 + i] = scalpDist.get(v)! & 255))
  writeFileSync(join(outDir, 'scalp.bin'), scalpBin)
  const pngA = encodePng(a, ATLAS_SIZE, ATLAS_SIZE, 4), pngB = encodePng(bImg, ATLAS_SIZE, ATLAS_SIZE, 1)
  writeFileSync(join(outDir, 'atlas-a.png'), pngA)
  writeFileSync(join(outDir, 'atlas-b.png'), pngB)
  const pre = body === 'female' ? 'W_' : ''
  const glb = new Uint8Array(readFileSync(join(ROOT, 'public', 'anatomy', body, 'integumentary.glb')))
  const data: HairData = {
    schema: 1,
    skin: b.skin.id,
    skinVertexCount: b.skin.positions.length / 3,
    offsetUnit: OFFSET_UNIT,
    atlas: { a: 'atlas-a.png', b: 'atlas-b.png', size: ATLAS_SIZE, depthRange: DEPTH_RANGE },
    // 两个人体都缺省短发：女性长发还在改进（发片成条、侧面体积不足），可用 hair=long 选 / both bodies default to short: the female long style is still being improved (ribbon-like cards, little volume at the sides) and can be chosen with hair=long
    defaultStyle: 'short',
    hides: [`${pre}FJ2813`, `${pre}FJ2812`],
    pieces,
    scalp: { file: 'scalp.bin', vertices: scalpVerts.length },
    coverage,
    inputs: { 'integumentary.glb': sha(glb), 'hair.json (curated)': sha(new Uint8Array(readFileSync(join(ROOT, 'data', 'curated', 'hair', 'hair.json')))) },
    source: {
      zh: '程序化生成（tools/hair/build.ts）：发际线、密度、纤维直径、睫毛和眉毛的根数与长度取自 data/curated/hair/hair.json 所列文献（标明了哪些是假设）；发片和贴图集由本项目自己的发丝画成，随项目数据以 CC BY-SA 4.0 发布。',
      en: "Generated procedurally (tools/hair/build.ts): hairline, density, fibre diameter, and the counts and lengths of eyelashes and eyebrow hairs come from the literature listed in data/curated/hair/hair.json (assumptions are marked there); the cards and the atlas are drawn from this project's own strands and published with the project data under CC BY-SA 4.0.",
    },
  }
  writeFileSync(join(outDir, 'hair.json'), JSON.stringify(data, null, 1) + '\n')
  // 本机测试用的发丝（不入库）/ strands for local tests (not in git)
  const rawDir = join(ROOT, 'data', 'raw', 'hair', body)
  mkdirSync(rawDir, { recursive: true })
  const q = (p: V3): number[] => p.map((x) => Math.round(x * 1e5) / 1e5)
  writeFileSync(
    join(rawDir, 'strands.json'),
    JSON.stringify({
      follicles: fol.follicles.length,
      pieces: Object.fromEntries(Object.entries(grooms).map(([k, ss]) => [k, ss.map((s) => ({ verts: s.root.verts, bary: s.root.bary.map((x) => Math.round(x * 1e5) / 1e5), pts: s.pts.map(q) }))])),
    }),
  )
  void dot
  void toHead
  void azimuth
  void existsSync
  const total = pieces.reduce((a, p) => a + p.bytes, 0) + pngA.length + pngB.length + scalpBin.length
  console.log(`${body}: atlas ${(pngA.length / 1024).toFixed(0)} + ${(pngB.length / 1024).toFixed(0)} KiB, total ${(total / 1e6).toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}

if (import.meta.main) {
  const P = loadParams()
  const bodies = (process.argv.slice(2).length ? process.argv.slice(2) : ['male', 'female']) as ('male' | 'female')[]
  for (const body of bodies) await buildBody(body, P)
}
