// 看一眼开口后的皮肤：头部在静止、张口 10° / 25°、上睑下落 / 上提时的渲染图（软件光栅器 tools/rig/render.ts）。
// 张口：皮肤顶点按 weights.bin 里的下颌份额绕颞下颌关节轴转（线性混合）；下颌骨、下牙、下牙龈和舌整体跟着转。
// 这只是检查用的最简单的摆法，不是运行时的蒙皮，也没有表情肌的位移场。
// A look at the opened skin: the head at rest, with the mouth opened by 10° / 25° and with the upper lid
// lowered / raised (software rasteriser of tools/rig/render.ts). Mouth opening: skin vertices turn about
// the axis of the temporomandibular joint by their jaw share in weights.bin (linear blend); mandible, lower
// teeth, lower gingiva and tongue turn with it as rigid bodies. This is the simplest posing for a check,
// not the runtime skinning, and no field of a facial muscle is applied.
//
//   bun tools/skinopen/render.ts <body> [package-open-dir] [out-dir]

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readBody } from '../rig/io.ts'
import { type RenderItem, type Rgb, type View, render, sheet } from '../rig/render.ts'

const bodyId = process.argv[2]
if (!bodyId) throw new Error('usage: bun tools/skinopen/render.ts <body> [package-open-dir] [out-dir]')
const pkg = process.argv[3] ?? join('data/raw/bodyshape/out', `${bodyId}-skin-open`)
const outDir = process.argv[4] ?? join(pkg, 'renders')
mkdirSync(outDir, { recursive: true })

interface Obj { positions: Float32Array; groups: Map<string, number[]> }
function readObj(file: string): Obj {
  const pos: number[] = []
  const groups = new Map<string, number[]>()
  let cur: number[] = []
  groups.set('skin', cur)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const t = line.split(/\s+/)
      pos.push(Number(t[1]), Number(t[2]), Number(t[3]))
    } else if (line.startsWith('g ')) {
      const name = line.slice(2).trim()
      if (!groups.has(name)) groups.set(name, [])
      cur = groups.get(name)!
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1)
      for (let k = 1; k + 1 < t.length; k++) cur.push(t[0]!, t[k]!, t[k + 1]!)
    }
  }
  return { positions: Float32Array.from(pos), groups }
}

const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
const joints = JSON.parse(readFileSync(join(pkg, 'joints.json'), 'utf8')) as { names: string[]; parents: number[]; mapping: { anatomical: string | null }[] }
const opened = readObj(join(pkg, 'skin.obj'))
const closed = readObj(join(pkg, 'skin-closed.obj'))
const nv = opened.positions.length / 3

// 每个顶点的下颌份额 / jaw share of every vertex
const jawJoint = joints.mapping.findIndex((m) => m?.anatomical === 'tmj')
const inJaw = joints.names.map((_, i) => {
  for (let k = i; k >= 0; k = joints.parents[k]!) if (k === jawJoint) return true
  return false
})
function readJawShare(file: string): Float32Array {
  const wb = readFileSync(file)
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength)
  const out = new Float32Array(nv)
  for (let r = 0; r < wb.byteLength / 12; r++) if (inJaw[dv.getUint32(r * 12 + 4, true)]) out[dv.getUint32(r * 12, true)]! += dv.getFloat32(r * 12 + 8, true)
  return out
}
const jawShare = readJawShare(join(pkg, 'weights.bin'))
// 闭合皮肤用原包的权重（原包在旁边时）；找不到就用开口包里同一批顶点的权重
// the closed skin takes the delivered weights when the source package lies next to this one, otherwise the weights the opened package gives the same vertices
const srcWeights = join(pkg.replace(/-open\/?$/, ''), 'weights.bin')
let jawShare0 = jawShare.slice(0, closed.positions.length / 3)
if (srcWeights !== join(pkg, 'weights.bin') && existsSync(srcWeights)) {
  const wb0 = readFileSync(srcWeights)
  const dv0 = new DataView(wb0.buffer, wb0.byteOffset, wb0.byteLength)
  jawShare0 = new Float32Array(closed.positions.length / 3)
  for (let r = 0; r < wb0.byteLength / 12; r++) if (inJaw[dv0.getUint32(r * 12 + 4, true)]) jawShare0[dv0.getUint32(r * 12, true)]! += dv0.getFloat32(r * 12 + 8, true)
}

const body = await readBody(join('public/anatomy', bodyId))
const rig = JSON.parse(readFileSync(join('public/anatomy', bodyId, 'rig.json'), 'utf8')) as { joints: { id: string; center: number[]; axes: number[][] }[] }
const tmj = rig.joints.find((j) => j.id === 'tmj')!

function rotate(p: ArrayLike<number>, share: ArrayLike<number> | number, deg: number): Float32Array {
  const out = Float32Array.from(p as number[])
  if (!deg) return out
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  const [ux, uy, uz] = tmj.axes[0]!, [cx, cy, cz] = tmj.center
  for (let i = 0; i < out.length; i += 3) {
    const w = typeof share === 'number' ? share : share[i / 3]!
    if (w <= 0) continue
    const x = out[i]! - cx!, y = out[i + 1]! - cy!, z = out[i + 2]! - cz!
    const d = ux! * x + uy! * y + uz! * z
    // 罗德里格斯公式 / Rodrigues' formula
    const rx = x * c + (uy! * z - uz! * y) * s + ux! * d * (1 - c)
    const ry = y * c + (uz! * x - ux! * z) * s + uy! * d * (1 - c)
    const rz = z * c + (ux! * y - uy! * x) * s + uz! * d * (1 - c)
    out[i] = out[i]! + w * (rx - x)
    out[i + 1] = out[i + 1]! + w * (ry - y)
    out[i + 2] = out[i + 2]! + w * (rz - z)
  }
  return out
}

// 深层部件：颜色、是否随下颌 / deep parts: colour and whether they move with the jaw
const DEEP: [RegExp, Rgb, boolean][] = [
  [/^(left|right) sclera$/i, [240, 240, 236], false],
  [/^(left|right) iris$/i, [70, 110, 150], false],
  [/upper .*tooth$/i, [250, 246, 225], false],
  [/lower .*tooth$/i, [250, 246, 225], true],
  [/^gingiva of upper jaw$/i, [205, 110, 115], false],
  [/^gingiva of lower jaw$/i, [205, 110, 115], true],
  [/^tongue$/i, [190, 70, 80], true],
]
function deepItems(deg: number): RenderItem[] {
  const out: RenderItem[] = []
  for (const p of body.data.parts) {
    const d = DEEP.find(([rx]) => rx.test(p.name))
    const m = body.meshes.get(p.id)
    if (!d || !m) continue
    out.push({ positions: d[2] ? rotate(m.positions, 1, deg) : m.positions, indices: m.indices, color: d[1] })
  }
  return out
}

const SKIN: Rgb = [226, 178, 156]
const GROUP_COLOR: Record<string, Rgb> = { skin: SKIN, lidRimL: [214, 150, 140], lidRimR: [214, 150, 140], oralPouchUpper: [70, 22, 28], oralPouchLower: [70, 22, 28] }

/** 上睑的位移：睑缘及其上方 8 mm 内的上睑皮肤（和内卷）上下移动 mm / lid displacement: the upper margin, the upper-lid skin within 8 mm above it and its rim move by mm */
function moveUpperLids(pos: Float32Array, mm: number): Float32Array {
  if (!mm) return pos
  const out = Float32Array.from(pos)
  const m = manifest.face.margins as Record<string, number[] | number>
  const sheets = manifest.face.sheets as Record<string, { upper: number[]; lower: number[] }>
  const aids = manifest.face.constructionAids as Record<string, { vertices: number[]; of: number[] }>
  for (const side of ['L', 'R']) {
    const margin = (m[`upperLid${side}`] as number[]).slice(1, -1)
    const lowerY = Math.min(...(m[`lowerLid${side}`] as number[]).map((v) => pos[v * 3 + 1]!))
    const xs = margin.map((v) => pos[v * 3]!), x0 = Math.min(...xs), x1 = Math.max(...xs)
    const amount = (v: number): number => {
      let best = Infinity
      for (const u of margin) best = Math.min(best, Math.hypot(pos[v * 3]! - pos[u * 3]!, pos[v * 3 + 1]! - pos[u * 3 + 1]!, pos[v * 3 + 2]! - pos[u * 3 + 2]!))
      // 向两眦收拢 / tapering towards the canthi
      const t = (pos[v * 3]! - x0) / (x1 - x0), taper = Math.sin(Math.PI * Math.max(0, Math.min(1, t))) ** 0.6
      return Math.max(0, 1 - best / 0.008) ** 1.5 * taper
    }
    const moved = new Map<number, number>()
    for (const v of [...margin, ...sheets[`eye${side}`]!.upper]) moved.set(v, amount(v))
    const rim = aids[`lidRim${side}`]
    if (rim) rim.vertices.forEach((r, i) => moved.has(rim.of[i]!) && margin.includes(rim.of[i]!) && moved.set(r, moved.get(rim.of[i]!)!))
    for (const [v, a] of moved) {
      // 下落时不越过下睑缘 / when lowered, not past the lower margin
      const y = pos[v * 3 + 1]! + (mm / 1000) * a
      out[v * 3 + 1] = mm < 0 ? Math.max(y, Math.min(pos[v * 3 + 1]!, lowerY)) : y
    }
  }
  return out
}

function skinItems(o: Obj, share: Float32Array, deg: number, lidMm = 0): RenderItem[] {
  const pos = moveUpperLids(rotate(o.positions, share, deg), o === opened ? lidMm : 0)
  return [...o.groups].filter(([, f]) => f.length).map(([g, f]) => ({ positions: pos, indices: Uint32Array.from(f), color: GROUP_COLOR[g] ?? SKIN }))
}

// 视图中心取自 manifest 里的线 / view centres from the lines of the manifest
const P = opened.positions
const mg = manifest.face.margins as Record<string, number[]>
const centre = (ids: number[]): [number, number, number] => [0, 1, 2].map((k) => ids.reduce((s, v) => s + P[v * 3 + k]!, 0) / ids.length) as [number, number, number]
const mouth = centre(mg.upperLip!), eyeL = centre([...mg.upperLidL!, ...mg.lowerLidL!]), eyeR = centre([...mg.upperLidR!, ...mg.lowerLidR!])
const headC: [number, number, number] = [(eyeL[0] + eyeR[0]) / 2, (eyeL[1] + mouth[1]) / 2 + 0.01, mouth[2] - 0.08]
const W = 560, H = 640
const views: Record<string, View> = {
  front: { yaw: 0, center: headC, halfHeight: 0.13, width: W, height: H },
  threeQuarter: { yaw: 40, pitch: 5, center: headC, halfHeight: 0.13, width: W, height: H },
  mouthFront: { yaw: 0, center: [mouth[0], mouth[1] - 0.012, mouth[2]], halfHeight: 0.04, width: W, height: H },
  mouthBelow: { yaw: 25, pitch: -25, center: [mouth[0], mouth[1] - 0.012, mouth[2]], halfHeight: 0.04, width: W, height: H },
  mouthSide: { yaw: 80, center: [mouth[0], mouth[1] - 0.012, mouth[2] - 0.02], halfHeight: 0.05, width: W, height: H },
  eyeFront: { yaw: 0, center: eyeL, halfHeight: 0.02, width: W, height: 420 },
  eyeOblique: { yaw: 45, pitch: 15, center: eyeL, halfHeight: 0.02, width: W, height: 420 },
  eyeBelow: { yaw: -20, pitch: -30, center: eyeL, halfHeight: 0.02, width: W, height: 420 },
  eyesFront: { yaw: 0, center: [(eyeL[0] + eyeR[0]) / 2, eyeL[1], eyeL[2]], halfHeight: 0.03, width: 2 * W, height: 420 },
}
const BG: Rgb = [245, 245, 245]
const shot = (items: RenderItem[], v: string) => render(items, views[v]!, BG)
const save = (name: string, imgs: ReturnType<typeof shot>[], cols: number) => {
  sheet(imgs, cols).save(join(outDir, name))
  console.log(join(outDir, name))
}

// 1. 静止：闭合的原皮肤 | 开口后的皮肤 / at rest: the closed skin as delivered | the opened skin
const rest = (o: Obj, s: Float32Array) => [...deepItems(0), ...skinItems(o, s, 0)]
for (const v of ['front', 'threeQuarter', 'mouthFront', 'mouthBelow', 'eyesFront']) save(`rest-${v}.png`, [shot(rest(closed, jawShare0), v), shot(rest(opened, jawShare), v)], 2)
// 口区静止时的像素差（只画皮肤）/ pixel difference of the mouth region at rest (skin only)
for (const v of ['mouthFront', 'mouthBelow', 'mouthSide']) {
  const a = shot(skinItems(closed, jawShare0, 0), v), b = shot(skinItems(opened, jawShare, 0), v)
  let diff = 0
  for (let i = 0; i < a.data.length; i += 3) if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 6) diff++
  console.log(`rest, ${v}: ${diff} of ${a.width * a.height} pixels differ between the closed and the opened skin`)
}
// 2. 张口 / mouth opening
for (const deg of [10, 25]) {
  const open = [...deepItems(deg), ...skinItems(opened, jawShare, deg)]
  const was = [...deepItems(deg), ...skinItems(closed, jawShare0, deg)]
  save(`mouth-${deg}deg.png`, [shot(was, 'mouthFront'), shot(open, 'front'), shot(open, 'mouthFront'), shot(open, 'mouthBelow'), shot(open, 'mouthSide'), shot(open, 'threeQuarter')], 3)
}
// 2b. 口角渐入的那份权重（有的话）：上排默认权重，下排渐入权重 / the corner-taper weights when present: default weights above, tapered below
const altFile = join(pkg, 'weights-corner-taper.bin')
if (existsSync(altFile)) {
  const alt = readJawShare(altFile)
  const row = (share: Float32Array) => [10, 25].flatMap((deg) => {
    const it = [...deepItems(deg), ...skinItems(opened, share, deg)]
    return [shot(it, 'mouthFront'), shot(it, 'mouthBelow')]
  })
  save('mouth-corner-taper.png', [...row(jawShare), ...row(alt)], 4)
}
// 3. 眼 / eyes
const eyeRow = (mm: number) => {
  const it = [...deepItems(0), ...skinItems(opened, jawShare, 0, mm)]
  return [shot(it, 'eyeFront'), shot(it, 'eyeOblique'), shot(it, 'eyeBelow')]
}
save('eyes.png', [...eyeRow(0), ...eyeRow(2), ...eyeRow(-3), ...eyeRow(-6), ...eyeRow(-12)], 3)
