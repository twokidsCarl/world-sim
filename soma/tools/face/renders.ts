// 面部表情的离线渲染：每个 AU 单独全强度、以及各疼痛强度下的头部特写（皮肤视图和肌肉视图）。
// Offline renders of the facial expression: every AU alone at full intensity and the pain levels,
// as close-ups of the head (skin view and muscle view).

import { join } from 'node:path'
import type { Part, Rig } from '../../src/anatomy/types.ts'
import type { FaceData } from '../../src/face/types.ts'
import type { Body } from '../rig/io.ts'
import { Poser } from '../rig/pose.ts'
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
}

export function scene(body: Body, rig: Rig, rigBin: Uint8Array, face: FaceData, bin: Uint8Array): FaceScene {
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
    if (/^lip$/i.test(p.name)) return [226, 130, 130]
    if (/eyebrow/i.test(p.name)) return [90, 62, 40]
    if (p.tissue === 'cartilage' && p.bbox[5] > skin.bbox[5] - 0.12) return [200, 215, 225]
    return null
  }
  const deepParts = body.data.parts.map((part) => ({ part, color: colorOf(part) })).filter((x): x is { part: Part; color: Rgb } => x.color !== null)
  // 取景：从颏到额肌上缘 / framing: from the chin to the top of frontalis
  const top = Math.max(...ys.map((p) => p.bbox[4]))
  void maxY
  return { body, rig, rigBin, face, bin, deepParts, center: [face.landmarks.midX, (minY + top) / 2 - 0.004, 0.1], halfHeight: (top - minY) / 2 + 0.012 }
}

/** 给定 AU 强度下，一个部件变形并摆好下颌后的顶点。 A part's vertices for the given AU intensities, deformed and with the jaw posed. */
export function posedPart(s: FaceScene, poser: Poser, partId: string, act: Record<string, number>): Float32Array {
  const rest = s.body.meshes.get(partId)!.positions
  return poser.part(partId, deform(s.face.channels, s.bin, partId, rest, act), 'dqs', false)
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
