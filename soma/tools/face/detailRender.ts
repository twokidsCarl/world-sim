// 带皱纹细节的离线渲染：正交投影、平面着色，再按逐像素取样的切线空间法线扰动。
// Offline renders with the wrinkle detail: orthographic, flat-shaded, then perturbed per pixel by the sampled tangent-space normal.
//
// tools/rig/render.ts 只做平面着色，所以这里另写一条渲染路径；光照方向、相机约定与它相同。
// tools/rig/render.ts only does flat shading, so this is a render path of its own; light direction and camera conventions are the same.

import { Poser } from '../rig/pose.ts'
import { Image, type Rgb, type View } from '../rig/render.ts'
import { type DetailLayers, compositeNormal } from './detail.ts'
import { type AUs, activations } from './model.ts'
import { type FaceScene, skinViewItems } from './renders.ts'

export interface DetailItem {
  positions: Float32Array
  indices: Uint32Array
  color: Rgb
  /** 可选的逐顶点颜色（扁平 rgb，0–255）/ optional per-vertex colours (flat rgb 0–255). */
  vertexColors?: Uint8Array
  /** 每顶点 (u, v)，NaN = 没有细节 / (u, v) per vertex, NaN = no detail. */
  uv?: Float32Array
}

export function renderDetailed(items: DetailItem[], view: View, layers: DetailLayers | null, weights: number[]): Image {
  const img = new Image(view.width, view.height)
  const zbuf = new Float32Array(view.width * view.height).fill(-Infinity)
  const yaw = (view.yaw * Math.PI) / 180, pitch = ((view.pitch ?? 0) * Math.PI) / 180
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const right = [cy, 0, -sy], back = [sy * cp, sp, cy * cp], up = [-sy * sp, cp, -cy * sp]
  const scale = view.height / (2 * view.halfHeight)
  // 相机空间的光 (0.35, 0.5, 0.8) 换到世界空间 / the camera-space light (0.35, 0.5, 0.8) taken to world space
  const lc = [0.35, 0.5, 0.8], ll = Math.hypot(lc[0]!, lc[1]!, lc[2]!)
  const L = [0, 1, 2].map((k) => (lc[0]! * right[k]! + lc[1]! * up[k]! + lc[2]! * back[k]!) / ll)
  const active = !!layers && weights.some((w) => w > 0)
  for (const it of items) {
    const p = it.positions, n = p.length / 3
    const sx = new Float32Array(n), syy = new Float32Array(n), sz = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = p[i * 3]! - view.center[0], y = p[i * 3 + 1]! - view.center[1], z = p[i * 3 + 2]! - view.center[2]
      sx[i] = (x * right[0]! + y * right[1]! + z * right[2]!) * scale + view.width / 2
      syy[i] = view.height / 2 - (x * up[0]! + y * up[1]! + z * up[2]!) * scale
      sz[i] = x * back[0]! + y * back[1]! + z * back[2]!
    }
    for (let t = 0; t < it.indices.length; t += 3) {
      const a = it.indices[t]!, b = it.indices[t + 1]!, c = it.indices[t + 2]!
      const x0 = sx[a]!, y0 = syy[a]!, x1 = sx[b]!, y1 = syy[b]!, x2 = sx[c]!, y2 = syy[c]!
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (area === 0) continue
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(view.width - 1, Math.ceil(Math.max(x0, x1, x2)))
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(view.height - 1, Math.ceil(Math.max(y0, y1, y2)))
      if (minX > maxX || minY > maxY) continue
      // 世界空间的面法线，朝向观察者 / the face normal in world space, turned towards the viewer
      const e1 = [p[b * 3]! - p[a * 3]!, p[b * 3 + 1]! - p[a * 3 + 1]!, p[b * 3 + 2]! - p[a * 3 + 2]!], e2 = [p[c * 3]! - p[a * 3]!, p[c * 3 + 1]! - p[a * 3 + 1]!, p[c * 3 + 2]! - p[a * 3 + 2]!]
      let N = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
      const nl = Math.hypot(N[0]!, N[1]!, N[2]!) || 1
      N = N.map((x) => x / nl)
      if (N[0]! * back[0]! + N[1]! * back[1]! + N[2]! * back[2]! < 0) N = N.map((x) => -x)
      // 切线：u 增大的方向在切面内的单位向量；副切线 B = N × T（v 增大，向上）
      // tangent: the unit direction of increasing u within the tangent plane; bitangent B = N × T (increasing v, up)
      let Tn: number[] | null = null, Bn: number[] | null = null
      const uv = it.uv
      const has = active && uv && !Number.isNaN(uv[a * 2]!) && !Number.isNaN(uv[b * 2]!) && !Number.isNaN(uv[c * 2]!)
      if (has) {
        const du1 = uv[b * 2]! - uv[a * 2]!, dv1 = uv[b * 2 + 1]! - uv[a * 2 + 1]!, du2 = uv[c * 2]! - uv[a * 2]!, dv2 = uv[c * 2 + 1]! - uv[a * 2 + 1]!
        const det = du1 * dv2 - du2 * dv1
        if (Math.abs(det) > 1e-14) {
          let T = [0, 1, 2].map((k) => (e1[k]! * dv2 - e2[k]! * dv1) / det)
          const d = T[0]! * N[0]! + T[1]! * N[1]! + T[2]! * N[2]!
          T = T.map((x, k) => x - N[k]! * d)
          const tl = Math.hypot(T[0]!, T[1]!, T[2]!)
          if (tl > 1e-12) {
            Tn = T.map((x) => x / tl)
            Bn = [N[1]! * Tn[2]! - N[2]! * Tn[1]!, N[2]! * Tn[0]! - N[0]! * Tn[2]!, N[0]! * Tn[1]! - N[1]! * Tn[0]!]
          }
        }
      }
      const vc = it.vertexColors
      const cr = vc ? (vc[a * 3]! + vc[b * 3]! + vc[c * 3]!) / 3 : it.color[0], cg = vc ? (vc[a * 3 + 1]! + vc[b * 3 + 1]! + vc[c * 3 + 1]!) / 3 : it.color[1], cb = vc ? (vc[a * 3 + 2]! + vc[b * 3 + 2]! + vc[c * 3 + 2]!) / 3 : it.color[2]
      const flat = 0.35 + 0.65 * Math.max(0, N[0]! * L[0]! + N[1]! * L[1]! + N[2]! * L[2]!)
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area, w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area, w2 = 1 - w0 - w1
          if (w0 < 0 || w1 < 0 || w2 < 0) continue
          const z = w0 * sz[a]! + w1 * sz[b]! + w2 * sz[c]!
          const k = y * view.width + x
          if (z <= zbuf[k]!) continue
          zbuf[k] = z
          let shade = flat
          if (Tn && Bn && uv && layers) {
            const u = w0 * uv[a * 2]! + w1 * uv[b * 2]! + w2 * uv[c * 2]!, v = w0 * uv[a * 2 + 1]! + w1 * uv[b * 2 + 1]! + w2 * uv[c * 2 + 1]!
            const nt = compositeNormal(layers, weights, u, v)
            if (nt[2] < 0.99999) {
              const nx = Tn[0]! * nt[0] + Bn[0]! * nt[1] + N[0]! * nt[2], ny = Tn[1]! * nt[0] + Bn[1]! * nt[1] + N[1]! * nt[2], nz = Tn[2]! * nt[0] + Bn[2]! * nt[1] + N[2]! * nt[2]
              shade = 0.35 + 0.65 * Math.max(0, nx * L[0]! + ny * L[1]! + nz * L[2]!)
            }
          }
          img.data[k * 3] = cr * shade
          img.data[k * 3 + 1] = cg * shade
          img.data[k * 3 + 2] = cb * shade
        }
      }
    }
  }
  return img
}

/** 皮肤（和眉毛）带细节的大图：正面和斜侧。 Large skin images (with the eyebrow hair) with detail: front and three-quarter. */
export function renderSkinDetailed(s: FaceScene, uv: Float32Array, layers: DetailLayers, weightsOf: (aus: AUs) => number[], aus: AUs, size = 760, zoom?: { center: [number, number, number]; halfHeight: number; yaws?: [number, number] }): Image[] {
  const { channels, jaw } = activations(s.face, aus)
  const pose = jaw > 0 ? { [s.face.jaw.joint]: Array.from({ length: s.face.jaw.dof + 1 }, (_, k) => (k === s.face.jaw.dof ? jaw : 0)) } : {}
  const poser = new Poser(s.rig, s.rigBin, pose)
  const items: DetailItem[] = skinViewItems(s, poser, channels).map((it, i) => ({ ...it, ...(i === 0 ? { uv } : {}) }))
  const view = (yaw: number): View => ({ yaw, center: zoom?.center ?? [s.center[0], s.center[1] - 0.006, s.center[2]], halfHeight: zoom?.halfHeight ?? s.halfHeight - 0.012, width: size, height: size })
  const w = weightsOf(aus)
  return [renderDetailed(items, view(zoom?.yaws?.[0] ?? 0), layers, w), renderDetailed(items, view(zoom?.yaws?.[1] ?? 40), layers, w)]
}
