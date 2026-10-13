// 面部表情的离线渲染：每个 AU 单独全强度、以及各疼痛强度下的头部特写（皮肤视图和肌肉视图）。
// Offline renders of the facial expression: every AU alone at full intensity and the pain levels,
// as close-ups of the head (skin view and muscle view).

import { join } from 'node:path'
import type { Part, Rig } from '../../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../../src/face/types.ts'
import type { Body } from '../rig/io.ts'
import { Poser } from '../rig/pose.ts'
import { isLipPart } from './build.ts'
import { type Image, type RenderItem, type Rgb, type View, render, sheet } from '../rig/render.ts'
import { type AUs, AU_MAX, activations, deform, displacement, painAUs } from './model.ts'

const SKIN: Rgb = [224, 180, 150]
const MUSCLE: Rgb = [186, 72, 62]

export interface FaceScene {
  body: Body
  rig: Rig
  rigBin: Uint8Array
  face: FaceData
  bin: Uint8Array
  /** 肌肉视图里画的部件 / the parts drawn in the muscle view. */
  deepParts: { part: Part; color: Rgb }[]
  center: [number, number, number]
  halfHeight: number
  /** 皮肤的开口（有的话）：皮肤视图里要画出洞里看得见的深层部件，口腔袋画成深色 / the skin's openings, when present: the skin view then draws the deep parts seen through the holes and the oral pouch dark. */
  openings?: FaceOpenings | null
}

export function scene(body: Body, rig: Rig, rigBin: Uint8Array, face: FaceData, bin: Uint8Array, openings: FaceOpenings | null = null): FaceScene {
  const skin = body.byId.get(face.skin)!
  const muscles = new Set(face.channels.flatMap((c) => c.parts))
  const ys = [...muscles].map((id) => body.byId.get(id)!).filter((p) => !/platysma/i.test(p.name))
  const minY = Math.min(...ys.map((p) => p.bbox[1])), maxY = skin.bbox[4]
  const colorOf = (p: Part): Rgb | null => {
    if (p.id === face.skin) return null
    if (p.bbox[4] < minY - 0.06 || !body.meshes.has(p.id)) return null
    if (p.tissue === 'muscle') return muscles.has(p.id) ? MUSCLE : [205, 140, 130]
    if (p.tissue === 'bone') return [232, 226, 206]
    if (p.tissue === 'tooth') return [250, 250, 244]
    if (/cornea/i.test(p.name)) return [40, 40, 60]
    if (/sclera/i.test(p.name)) return [245, 245, 245]
    if (/tarsal plate/i.test(p.name)) return [214, 150, 150]
    // 深层的唇按名字找：一个部件（Lip）或拆开的两个（Upper lip / Lower lip）/ the deep lips are found by name: one part (Lip) or two after the split (Upper lip / Lower lip)
    if (isLipPart(p)) return [226, 130, 130]
    if (/eyebrow/i.test(p.name)) return [90, 62, 40]
    if (p.tissue === 'cartilage' && p.bbox[5] > skin.bbox[5] - 0.12) return [200, 215, 225]
    return null
  }
  const deepParts = body.data.parts.map((part) => ({ part, color: colorOf(part) })).filter((x): x is { part: Part; color: Rgb } => x.color !== null)
  // 取景：从颏到额肌上缘 / framing: from the chin to the top of frontalis
  const top = Math.max(...ys.map((p) => p.bbox[4]))
  void maxY
  return { body, rig, rigBin, face, bin, deepParts, openings, center: [face.landmarks.midX, (minY + top) / 2 - 0.004, 0.1], halfHeight: (top - minY) / 2 + 0.012 }
}

/** 给定 AU 强度下，一个部件变形并摆好下颌后的顶点。 A part's vertices for the given AU intensities, deformed and with the jaw posed. */
export function posedPart(s: FaceScene, poser: Poser, partId: string, act: Record<string, number>): Float32Array {
  const rest = s.body.meshes.get(partId)!.positions
  return poser.part(partId, deform(s.face.channels, s.bin, partId, rest, act), 'dqs', false)
}

const POUCH: Rgb = [58, 26, 26], RIM: Rgb = [206, 128, 118]

/**
 * 皮肤视图要画的东西：皮肤（有开口时口腔袋深色、睑缘内卷粉色）、眉毛，以及有开口时从洞里看得见的眼球、牙、牙龈、舌。
 * 深层的 Lip 部件不画（皮肤不透明时查看器也把它藏起来）。
 * What the skin view draws: the skin (with openings: pouch dark, lid rims pink), the eyebrow hair and, with openings, what shows
 * through the holes — eyeball, teeth, gingiva, tongue. The deep Lip part is not drawn (the viewer hides it too while the skin is opaque).
 */
export function skinViewItems(s: FaceScene, poser: Poser, channels: Record<string, number>): RenderItem[] {
  const skinMesh = s.body.meshes.get(s.face.skin)!
  const item: RenderItem = { positions: posedPart(s, poser, s.face.skin, channels), indices: skinMesh.indices, color: SKIN }
  const O = s.openings
  if (O) {
    const col = new Uint8Array(skinMesh.positions.length)
    for (let i = 0; i < col.length; i += 3) col.set(SKIN, i)
    for (const v of [...O.oralPouch.upper, ...O.oralPouch.lower, ...O.oralPouch.seam]) col.set(POUCH, v * 3)
    for (const r of O.lidRims) for (const v of r.vertices) col.set(RIM, v * 3)
    item.vertexColors = col
  }
  const items: RenderItem[] = [item]
  for (const d of s.deepParts) if (/eyebrow/i.test(d.part.name)) items.push({ positions: posedPart(s, poser, d.part.id, channels), indices: s.body.meshes.get(d.part.id)!.indices, color: d.color })
  if (O) {
    for (const part of s.body.data.parts) {
      if (!s.body.meshes.has(part.id) || part.bbox[4] < s.center[1] - 0.2) continue
      const color: Rgb | null = /cornea/i.test(part.name) ? [70, 60, 60] : /sclera/i.test(part.name) ? [240, 238, 232] : part.tissue === 'tooth' ? [246, 244, 232] : /gingiva/i.test(part.name) ? [214, 120, 124] : /^tongue$/i.test(part.name) ? [196, 96, 104] : null
      if (color) items.push({ positions: posedPart(s, poser, part.id, channels), indices: s.body.meshes.get(part.id)!.indices, color })
    }
  }
  return items
}

/** 只画皮肤（和眉毛）的大图：正面和斜侧。 Large skin-only images (with the eyebrow hair): front and three-quarter. */
export function renderSkin(s: FaceScene, aus: AUs, size = 760): Image[] {
  const { channels, jaw } = activations(s.face, aus)
  const pose = jaw > 0 ? { [s.face.jaw.joint]: Array.from({ length: s.face.jaw.dof + 1 }, (_, k) => (k === s.face.jaw.dof ? jaw : 0)) } : {}
  const poser = new Poser(s.rig, s.rigBin, pose)
  const items = skinViewItems(s, poser, channels)
  const view = (yaw: number): View => ({ yaw, center: [s.center[0], s.center[1] - 0.006, s.center[2]], halfHeight: s.halfHeight - 0.012, width: size, height: size })
  return [render(items, view(0)), render(items, view(40))]
}

export function renderExpression(s: FaceScene, aus: AUs, opts: { size?: number; heat?: boolean } = {}): Image[] {
  const { channels, jaw } = activations(s.face, aus)
  const pose = jaw > 0 ? { [s.face.jaw.joint]: Array.from({ length: s.face.jaw.dof + 1 }, (_, k) => (k === s.face.jaw.dof ? jaw : 0)) } : {}
  const poser = new Poser(s.rig, s.rigBin, pose)
  const size = opts.size ?? 520
  const view = (yaw: number): View => ({ yaw, center: s.center, halfHeight: s.halfHeight, width: size, height: Math.round(size * 1.15) })
  const skinMesh = s.body.meshes.get(s.face.skin)!
  const skinPos = posedPart(s, poser, s.face.skin, channels)
  const skinItem: RenderItem = { positions: skinPos, indices: skinMesh.indices, color: SKIN }
  const brow = s.deepParts.filter((d) => /eyebrow/i.test(d.part.name)).map((d) => ({ positions: posedPart(s, poser, d.part.id, channels), indices: s.body.meshes.get(d.part.id)!.indices, color: d.color }))
  const deep: RenderItem[] = s.deepParts.map((d) => ({ positions: posedPart(s, poser, d.part.id, channels), indices: s.body.meshes.get(d.part.id)!.indices, color: d.color }))
  const out = [render([skinItem, ...brow], view(0)), render([skinItem, ...brow], view(40)), render(deep, view(0)), render(deep, view(40))]
  if (opts.heat) {
    // 位移热图：白 = 不动，红 = 达到单通道上界 / displacement heat map: white = still, red = the single-channel bound
    const d = displacement(s.face.channels, s.bin, s.face.skin, skinMesh.positions.length / 3, channels)
    const col = new Uint8Array(d.length)
    for (let i = 0; i < d.length; i += 3) {
      const t = Math.min(1, Math.hypot(d[i]!, d[i + 1]!, d[i + 2]!) / s.face.bounds.channel)
      col[i] = 255
      col[i + 1] = col[i + 2] = Math.round(255 * (1 - t))
    }
    out.push(render([{ positions: skinPos, indices: skinMesh.indices, color: SKIN, vertexColors: col }], view(0)))
  }
  return out
}

/** 写出全部渲染图，返回文件路径。 Writes every render and returns the file paths. */
export function renderAll(s: FaceScene, outDir: string, log: (m: string) => void): string[] {
  const files: string[] = []
  const save = (img: Image, name: string): void => {
    const f = join(outDir, name)
    img.save(f)
    files.push(f)
  }
  // 皮肤大图：左列静止，右列该 AU 全强度；上排正面，下排斜侧
  // large skin images: rest on the left, the AU at full intensity on the right; front view above, three-quarter view below
  const restSkin = renderSkin(s, {})
  for (const au of s.face.aus) {
    const a = renderSkin(s, { [au.id]: AU_MAX })
    save(sheet([restSkin[0]!, a[0]!, restSkin[1]!, a[1]!], 2), `skin-${au.id}.png`)
  }
  const lv = [0, 2, 4, 6, 8, 10].map((l) => renderSkin(s, painAUs(s.face.pain, l), 640))
  save(sheet(lv.map((x) => x[0]!), 3), 'skin-pain-front.png')
  save(sheet(lv.map((x) => x[1]!), 3), 'skin-pain-oblique.png')
  const neutral = renderExpression(s, {}, { heat: true })
  for (const au of s.face.aus) {
    // 上排静止，下排该 AU 全强度 / top row at rest, bottom row this AU at full intensity
    save(sheet([...neutral, ...renderExpression(s, { [au.id]: AU_MAX }, { heat: true })], 5), `au-${au.id}.png`)
  }
  // 总览：第一列静止，其后每列一个 AU 全强度；上排皮肤正面，下排肌肉正面
  // overview: rest in the first column, then one AU at full intensity per column; skin front view above, muscle front view below
  const small = [renderExpression(s, {}, { size: 330 }), ...s.face.aus.map((au) => renderExpression(s, { [au.id]: AU_MAX }, { size: 330 }))]
  save(sheet([...small.map((c) => c[0]!), ...small.map((c) => c[2]!)], small.length), 'au-overview.png')
  const levels = [0, 2, 4, 6, 8, 10]
  save(sheet(levels.flatMap((l) => renderExpression(s, painAUs(s.face.pain, l), { size: 440 })), 4), 'pain-levels.png')
  // 各强度并排：皮肤正面一行、皮肤斜侧一行、肌肉正面一行
  // the levels side by side: a row of skin front views, a row of skin three-quarter views, a row of muscle front views
  const cols = levels.map((l) => renderExpression(s, painAUs(s.face.pain, l), { size: 400 }))
  save(sheet([0, 1, 2, 3].flatMap((r) => cols.map((c) => c[r]!)), levels.length), 'pain-rows.png')
  log(`renders: ${files.length} files in ${outDir}`)
  return files
}
