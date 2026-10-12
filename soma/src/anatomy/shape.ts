// 体型控制的运行时：加载 shape.json / shape.bin，控制量的取值、限幅与 URL 编码。纯数据，不依赖 three.js。
// Runtime of the body-shape controls: loading shape.json / shape.bin, control values, clamping
// and the URL encoding. Pure data, no three.js.
//
// 位移与关节缩放本身不在这里重新实现：直接用 tools/rig/shape.ts 的参考实现（Shaper、jointScales）。
// The displacement and the joint scales are not re-implemented here: the reference in
// tools/rig/shape.ts (Shaper, jointScales) is used as is.

import { jointScales, resolveControls } from '../../tools/rig/shape.ts'
import type { Scales } from '../../tools/rig/pose.ts'
import type { ShapeControl, ShapeControlId, ShapeControls, ShapeData } from '../shape/types.ts'
import { fetchJson } from './load.ts'

export type { ShapeControlId, ShapeControls }

export interface LoadedShape {
  data: ShapeData
  bin: Uint8Array
}

/** URL 里各控制量的字母 / The letter of each control in the URL. */
export const SHAPE_LETTERS: Record<ShapeControlId, string> = { stature: 'h', bmi: 'b', legLength: 'l', centralBuild: 'c' }
const LETTER_TO_CONTROL = new Map(Object.entries(SHAPE_LETTERS).map(([id, l]) => [l, id as ShapeControlId]))

/** 校验 shape.json 与 shape.bin 是否自洽；不自洽时抛错。 Check that shape.json and shape.bin agree; throws otherwise. */
export function checkShape(data: ShapeData, bin: Uint8Array): LoadedShape {
  if (!data || !Array.isArray(data.controls) || !data.skin || !Array.isArray(data.followers) || !Array.isArray(data.joints)) {
    throw new Error('shape.json: 结构不符合约定 / not a ShapeData document')
  }
  const n = data.skin.vertexCount
  if (data.skin.fatOffset + n * 12 > bin.length || data.skin.limitOffset + n * 4 > bin.length) throw new Error('shape.bin: 皮肤位移场超出文件范围 / the skin field runs past the end of the file')
  for (const f of data.followers) {
    if (f.skinIndexOffset + f.vertexCount * 4 > bin.length || f.followOffset + f.vertexCount > bin.length) {
      throw new Error(`shape.bin: 部件 ${f.part} 的跟随数据超出文件范围 / follower data runs past the end of the file`)
    }
  }
  return { data, bin }
}

/** 读取某个人体的体型数据；没有则返回 null。 Fetch a body's shape data; null when it has none. */
export async function loadShape(baseUrl: string): Promise<LoadedShape | null> {
  const data = await fetchJson<ShapeData>(`${baseUrl}shape.json`)
  if (!data) return null
  const res = await fetch(`${baseUrl}shape.bin`)
  if (!res.ok) return null
  return checkShape(data, new Uint8Array(await res.arrayBuffer()))
}

/** 把一个控制量限制在这副身体的可用范围内；`limited` 表示请求的值被截断了。 */
/** Clamp one control to the range valid on this body; `limited` says the requested value was cut. */
export function clampControl(c: ShapeControl, value: number): { value: number; limited: 'min' | 'max' | null } {
  if (value < c.valid.min - 1e-9) return { value: c.valid.min, limited: 'min' }
  if (value > c.valid.max + 1e-9) return { value: c.valid.max, limited: 'max' }
  return { value, limited: null }
}

/** 控制量是否都在默认值（身体保持原样）/ Whether every control is at its default (the body as built). */
export function shapeIsDefault(data: ShapeData, controls: ShapeControls): boolean {
  const r = resolveControls(data, controls)
  return data.controls.every((c) => Math.abs(r[c.id] - c.default) < 1e-6)
}

/** 体型给出的关节节段缩放；默认体型时为 null / The joint segment scales of a shape; null at the default shape. */
export function shapeScales(data: ShapeData, controls: ShapeControls): Scales | null {
  if (shapeIsDefault(data, controls)) return null
  const s = jointScales(data, controls)
  return Object.keys(s).length ? s : null
}

/** 解析 URL 里的体型参数，如 "h1.80,b28,l0,c0"；无法解析的项被忽略并报告。 */
/** Parse the URL's shape parameter, e.g. "h1.80,b28,l0,c0"; unparseable items are ignored and reported. */
export function parseShapeParam(value: string): { controls: ShapeControls; bad: boolean } {
  const controls: ShapeControls = {}
  let bad = false
  for (const item of value.split(',').filter(Boolean)) {
    const id = LETTER_TO_CONTROL.get(item[0] ?? '')
    const v = Number(item.slice(1))
    if (!id || item.length < 2 || !Number.isFinite(v)) bad = true
    else controls[id] = v
  }
  return { controls, bad }
}

/** 写成 URL 参数；只写出给定的控制量（调用方只传不在默认值的）。 To a URL parameter; only the controls given are written (callers pass the non-default ones). */
export function formatShapeParam(controls: ShapeControls): string {
  const out: string[] = []
  for (const id of ['stature', 'bmi', 'legLength', 'centralBuild'] as const) {
    const v = controls[id]
    if (v === undefined) continue
    out.push(`${SHAPE_LETTERS[id]}${Math.round(v * (id === 'stature' ? 1000 : 100)) / (id === 'stature' ? 1000 : 100)}`)
  }
  return out.join(',')
}

/** 只留下不在默认值的控制量 / Keep only the controls that are not at their default. */
export function nonDefaultControls(data: ShapeData, controls: ShapeControls): ShapeControls {
  const out: ShapeControls = {}
  for (const c of data.controls) {
    const v = controls[c.id]
    if (v !== undefined && Math.abs(v - c.default) > 1e-6) out[c.id] = v
  }
  return out
}

/** 把主视图的体型控制量换到另一副身体上：保持相对默认值的偏移 / Carry the main view's shape controls over to the other body: keep the offsets from the defaults. */
export function mapShapeControls(main: LoadedShape | null, controls: ShapeControls, other: LoadedShape): ShapeControls {
  const out: ShapeControls = {}
  for (const c of other.data.controls) {
    const v = controls[c.id]
    const from = main?.data.controls.find((x) => x.id === c.id)
    if (v === undefined || !from) continue
    const mapped = clampControl(c, c.default + (v - from.default)).value
    if (Math.abs(mapped - c.default) > 1e-9) out[c.id] = mapped
  }
  return out
}
