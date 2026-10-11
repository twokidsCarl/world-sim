// 面部表情的 CPU 参考实现：疼痛强度 → AU 强度 → 通道激活 → 逐顶点位移。
// CPU reference implementation of the facial expression: pain intensity → AU intensities →
// channel activations → per-vertex displacements.
//
// 运行时（GPU 顶点阶段或 CPU 累加）应与这里的结果一致；tests/face*.test.ts 以它为准。
// 只依赖数据契约（src/face/types.ts），前端可以直接导入。
// The runtime (a GPU vertex stage or a CPU accumulation) should reproduce these results;
// tests/face*.test.ts use this file as ground truth. It depends only on the data contract
// (src/face/types.ts), so the frontend can import it as is.
//
// 这是疼痛行为的计算模型，用于教学；模拟人并没有主观感受。
// This is a computational model of pain behaviour for teaching; the simulated body has no
// subjective experience.
//
// 约定 / Conventions
//   · AU 强度 0–5（FACS 的 A–E）；通道激活 a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1)。
//     AU intensities 0–5 (FACS A–E); channel activation a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1).
//   · 位移在静止空间里相加，先于蒙皮：p′ = p + Σ_c a_c · D_c[v]；然后照常用 rig 蒙皮。
//     Displacements add in rest space, before skinning: p′ = p + Σ_c a_c · D_c[v]; then skin with the rig as usual.
//   · 下颌：角度 = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max)，加到 rig 的 jaw.joint 的第 jaw.dof 个自由度上。
//     Jaw: angle = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max), added to dof jaw.dof of the rig joint jaw.joint.
//   · face.bin 的一个场：count × uint32 顶点下标，随后 count × 3 × int16；位移 = 分量 × scale / 32767（米）。
//     A field in face.bin: count × uint32 vertex indices, then count × 3 × int16; displacement = component × scale / 32767 (metres).

import type { FaceChannel, FaceData, FaceField, PainModel } from '../../src/face/types.ts'

/** AU id → 强度（0–5）。缺省为 0。 AU id → intensity (0–5). Missing = 0. */
export type AUs = Record<string, number>
/** 通道 id → 激活（0–1）。缺省为 0。 Channel id → activation (0–1). Missing = 0. */
export type Activations = Record<string, number>

export const AU_MAX = 5
/** int16 分量的满量程 / full scale of the int16 components. */
export const Q = 32767

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 疼痛强度（0–10）下各 AU 的强度：关键帧之间线性插值。 AU intensities at a pain level (0–10): linear between keyframes. */
export function painAUs(pain: PainModel, level: number): AUs {
  const kf = pain.keyframes
  if (kf.length === 0) return {}
  const l = clamp(level, kf[0]!.level, kf[kf.length - 1]!.level)
  let i = 0
  while (i < kf.length - 2 && l > kf[i + 1]!.level) i++
  const a = kf[i]!, b = kf[Math.min(i + 1, kf.length - 1)]!
  const t = b.level > a.level ? clamp((l - a.level) / (b.level - a.level), 0, 1) : 0
  const out: AUs = {}
  for (const id of new Set([...Object.keys(a.aus), ...Object.keys(b.aus)])) {
    const v = (a.aus[id] ?? 0) * (1 - t) + (b.aus[id] ?? 0) * t
    if (v !== 0) out[id] = v
  }
  return out
}

/**
 * Prkachin–Solomon 疼痛强度：AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43。
 * `continuous` 为 false（缺省）时 `binary` 里的 AU 取 0 或 1（强度 ≥ 2.5 记 1）；为 true 时取 强度 / 5。
 * Prkachin–Solomon Pain Intensity: AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43. With `continuous`
 * false (default) the AUs listed in `binary` count 0 or 1 (1 at intensity ≥ 2.5); with true they count intensity / 5.
 */
export function pspi(pain: PainModel, aus: AUs, continuous = false): number {
  const value = (id: string): number => {
    const v = clamp(aus[id] ?? 0, 0, AU_MAX)
    if (!pain.pspi.binary.includes(id)) return v
    return continuous ? v / AU_MAX : v >= AU_MAX / 2 ? 1 : 0
  }
  let s = 0
  for (const term of pain.pspi.terms) s += typeof term === 'string' ? value(term) : Math.max(...term.map(value))
  return s
}

/**
 * 时间包络（0–1）：刺激在 t = 0 开始、持续 `duration` 秒。latency 之后在 onset 内平滑升到 1，
 * 刺激结束后在 offset 内平滑回落。乘到疼痛强度或 AU 强度上。
 * Time envelope (0–1) for a stimulus starting at t = 0 and lasting `duration` seconds: after
 * `latency` it rises smoothly to 1 within `onset`, and falls back within `offset` once the
 * stimulus has ended. Multiply the pain level or the AU intensities by it.
 */
export function envelope(timing: PainModel['timing'], t: number, duration: number): number {
  const up = smooth((t - timing.latency) / Math.max(1e-6, timing.onset))
  // 短于起始时间的刺激达不到峰值 / a stimulus shorter than the onset never reaches the apex
  const peak = smooth((Math.max(0, duration)) / Math.max(1e-6, timing.onset))
  const end = duration + timing.latency
  if (t <= end) return up
  return Math.min(up, peak) * (1 - smooth((t - end) / Math.max(1e-6, timing.offset)))
}

/** AU 强度 → 通道激活和下颌张开角（弧度）。 AU intensities → channel activations and jaw opening (radians). */
export function activations(face: Pick<FaceData, 'aus' | 'jaw'>, aus: AUs): { channels: Activations; jaw: number } {
  const channels: Activations = {}
  let jaw = 0
  for (const au of face.aus) {
    const k = clamp(aus[au.id] ?? 0, 0, AU_MAX) / AU_MAX
    if (k === 0) continue
    for (const [id, w] of Object.entries(au.channels)) channels[id] = (channels[id] ?? 0) + w * k
    jaw += (au.jaw ?? 0) * k
  }
  for (const id of Object.keys(channels)) channels[id] = clamp(channels[id]!, 0, 1)
  return { channels, jaw: clamp(jaw, 0, face.jaw.max) }
}

/** 读出一个场：顶点下标和位移（米）。 Decodes one field: vertex indices and displacements in metres. */
export function readField(bin: Uint8Array, field: FaceField): { index: Uint32Array; delta: Float32Array } {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const index = new Uint32Array(field.count), delta = new Float32Array(field.count * 3)
  const k = field.scale / Q
  let o = field.offset
  for (let i = 0; i < field.count; i++, o += 4) index[i] = dv.getUint32(o, true)
  for (let i = 0; i < field.count * 3; i++, o += 2) delta[i] = dv.getInt16(o, true) * k
  return { index, delta }
}

/**
 * 一个部件在给定激活下的逐顶点位移（米，静止空间），长度 3 × vertexCount。
 * Per-vertex displacement of one part for the given activations (metres, rest space), length 3 × vertexCount.
 */
export function displacement(channels: FaceChannel[], bin: Uint8Array, part: string, vertexCount: number, act: Activations): Float32Array {
  const out = new Float32Array(vertexCount * 3)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (const ch of channels) {
    const a = clamp(act[ch.id] ?? 0, 0, 1)
    if (a === 0) continue
    for (const f of ch.fields) {
      if (f.part !== part) continue
      const k = (a * f.scale) / Q
      const vo = f.offset + f.count * 4
      for (let i = 0; i < f.count; i++) {
        const v = dv.getUint32(f.offset + i * 4, true) * 3
        out[v] = out[v]! + dv.getInt16(vo + i * 6, true) * k
        out[v + 1] = out[v + 1]! + dv.getInt16(vo + i * 6 + 2, true) * k
        out[v + 2] = out[v + 2]! + dv.getInt16(vo + i * 6 + 4, true) * k
      }
    }
  }
  return out
}

/** 静止顶点 + 位移；之后再交给 rig 蒙皮。 Rest vertices plus displacement; hand the result to the rig for skinning. */
export function deform(channels: FaceChannel[], bin: Uint8Array, part: string, rest: Float32Array, act: Activations): Float32Array {
  const d = displacement(channels, bin, part, rest.length / 3, act)
  for (let i = 0; i < d.length; i++) d[i] = d[i]! + rest[i]!
  return d
}

/** 一步到位：疼痛强度 → 激活和下颌角。 In one step: pain level → activations and jaw angle. */
export function painExpression(face: Pick<FaceData, 'aus' | 'jaw' | 'pain'>, level: number): { aus: AUs; channels: Activations; jaw: number; pspi: number } {
  const aus = painAUs(face.pain, level)
  return { aus, ...activations(face, aus), pspi: pspi(face.pain, aus) }
}
