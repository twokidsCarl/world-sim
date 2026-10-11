// 体型的 CPU 参考实现：控制量 → 各关节的节段缩放 + 皮肤位移 → 任意部件在静止空间的位置。
// CPU reference of the body shape: controls → per-joint segment scales + skin displacement → the
// rest-space positions of any part.
//
// 与 pose.ts 配合：先用这里的 shapedRest 得到静止空间的顶点，再交给 new Poser(rig, bin, pose, scales)。
// 默认控制值下一切恒等：缩放全为 1、位移全为 0。
// Used with pose.ts: shapedRest gives the rest-space vertices, which then go to
// new Poser(rig, bin, pose, scales). At the default controls everything is the identity: all
// scales 1, all displacements 0.

import type { ShapeControlId, ShapeControls, ShapeData } from '../../src/shape/types.ts'
import type { Scales } from './pose.ts'

/** 补全缺省值并限制在这副身体的可用范围内。 Fills in defaults and clamps to the range valid on this body. */
export function resolveControls(shape: ShapeData, controls: ShapeControls = {}, clamp = true): Record<ShapeControlId, number> {
  const out = {} as Record<ShapeControlId, number>
  for (const c of shape.controls) {
    const v = controls[c.id] ?? c.default
    out[c.id] = clamp ? Math.min(c.valid.max, Math.max(c.valid.min, v)) : v
  }
  return out
}

/** 各比例因子的值（默认控制值下为 1）。 The value of every proportion factor (1 at the default controls). */
export function factorValues(shape: ShapeData, controls: ShapeControls = {}, clamp = true): Record<string, number> {
  const c = resolveControls(shape, controls, clamp)
  const d = Object.fromEntries(shape.controls.map((x) => [x.id, x.default])) as Record<ShapeControlId, number>
  const out: Record<string, number> = {}
  for (const f of shape.factors) {
    out[f.id] = (c.stature / d.stature) ** f.exponents.stature * Math.exp(f.exponents.legLength * (c.legLength - d.legLength) + f.exponents.centralBuild * (c.centralBuild - d.centralBuild))
  }
  return out
}

/** 各关节的节段缩放，可直接交给 pose.ts。 The segment scale of every joint, ready for pose.ts. */
export function jointScales(shape: ShapeData, controls: ShapeControls = {}, clamp = true): Scales {
  const f = factorValues(shape, controls, clamp)
  const out: Scales = {}
  for (const j of shape.joints) {
    let along = 1, across = 1
    for (const t of j.along) along *= 1 + t.gain * ((f[t.factor] ?? 1) - 1)
    for (const t of j.across) across *= 1 + t.gain * ((f[t.factor] ?? 1) - 1)
    if (along !== 1 || across !== 1) out[j.joint] = { along, across }
  }
  return out
}

/** 目标 BMI 对应的胖瘦场倍数 m（线性插值）。 The multiplier m of the fat field for a target BMI (linear interpolation). */
export function bmiUnits(shape: ShapeData, bmi: number): number {
  const t = shape.skin.bmiToUnits
  if (!t.length) return 0
  if (bmi <= t[0]![0]) return t[0]![1]
  for (let i = 1; i < t.length; i++) {
    if (bmi <= t[i]![0]) return t[i - 1]![1] + ((t[i]![1] - t[i - 1]![1]) * (bmi - t[i - 1]![0])) / (t[i]![0] - t[i - 1]![0])
  }
  return t[t.length - 1]![1]
}

/**
 * 皮肤各顶点的位移（flat xyz，米）：m·fat，长度限制在 limit 以内。
 * Displacement of every skin vertex (flat xyz, metres): m·fat with its length capped at `limit`.
 */
export function skinDisplacement(shape: ShapeData, bin: Uint8Array, controls: ShapeControls = {}, clamp = true): Float32Array {
  const n = shape.skin.vertexCount
  const out = new Float32Array(n * 3)
  const m = bmiUnits(shape, resolveControls(shape, controls, clamp).bmi)
  if (m === 0) return out
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (let i = 0; i < n; i++) {
    const o = shape.skin.fatOffset + i * 12
    let x = m * dv.getFloat32(o, true), y = m * dv.getFloat32(o + 4, true), z = m * dv.getFloat32(o + 8, true)
    const lim = dv.getFloat32(shape.skin.limitOffset + i * 4, true)
    const l = Math.hypot(x, y, z)
    if (l > lim && l > 0) {
      const k = lim / l
      ;(x *= k), (y *= k), (z *= k)
    }
    out[i * 3] = x
    out[i * 3 + 1] = y
    out[i * 3 + 2] = z
  }
  return out
}

/** 体型求值器：一次算好关节缩放和皮肤位移，再逐部件给出静止空间的顶点。 A shaped body: joint scales and skin displacement computed once, rest-space vertices of parts on demand. */
export class Shaper {
  readonly scales: Scales
  readonly skin: Float32Array
  private readonly follower: Map<string, { skinIndexOffset: number; followOffset: number; vertexCount: number }>
  private readonly dv: DataView

  constructor(readonly shape: ShapeData, readonly bin: Uint8Array, controls: ShapeControls = {}, clamp = true) {
    this.scales = jointScales(shape, controls, clamp)
    this.skin = skinDisplacement(shape, bin, controls, clamp)
    this.follower = new Map(shape.followers.map((f) => [f.part, f]))
    this.dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  }

  /**
   * 部件在静止空间里、施加体型位移之后的顶点（关节缩放由 Poser 随后施加）。
   * A part's rest-space vertices after the shape displacement (the joint scales are applied afterwards by the Poser).
   */
  shapedRest(partId: string, rest: Float32Array): Float32Array {
    if (partId === this.shape.skin.part) {
      const out = new Float32Array(rest.length)
      for (let i = 0; i < rest.length; i++) out[i] = rest[i]! + (this.skin[i] ?? 0)
      return out
    }
    const f = this.follower.get(partId)
    if (!f) return rest
    const out = Float32Array.from(rest)
    const n = Math.min(f.vertexCount, rest.length / 3)
    for (let i = 0; i < n; i++) {
      const w = this.bin[f.followOffset + i]!
      if (w === 0) continue
      const s = this.dv.getUint32(f.skinIndexOffset + i * 4, true) * 3, k = w / 255
      out[i * 3] = out[i * 3]! + k * this.skin[s]!
      out[i * 3 + 1] = out[i * 3 + 1]! + k * this.skin[s + 1]!
      out[i * 3 + 2] = out[i * 3 + 2]! + k * this.skin[s + 2]!
    }
    return out
  }
}
