// 一次刺激在三维视图里画的东西：皮肤上的疼痛分布层、从皮肤到神经根的通路折线、沿通路走的两个标记
// （Aδ 快、C 慢）和刺激点。通路在静止空间里给出；摆了姿势或改了体型时，每个折线点跟着离它最近的
// 神经（或皮肤）顶点一起动。
// What one stimulus draws in the 3D view: the pain map layer on the skin, the pathway polyline from the
// skin to the nerve root, two markers travelling along it (Aδ fast, C slow) and the stimulus site. The
// pathway is given in rest space; when the body is posed or reshaped, every polyline point moves with
// the nerve (or skin) vertex nearest to it.

import { BufferAttribute, BufferGeometry, Color, Group, Line, LineBasicNodeMaterial, Mesh, MeshBasicNodeMaterial, SphereGeometry, type PerspectiveCamera } from 'three/webgpu'
import { attribute, float, mix, select, uniform, varying, vec3 } from 'three/tsl'
import type { SkinGeometry } from './skinLayer.ts'
import { PAIN_COLORS } from './stimColors.ts'
import { SkinPatch } from './skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export { PAIN_COLORS }

/** 皮肤上的疼痛分布层 / The pain map layer on the skin. */
export class PainOverlay {
  readonly patch: SkinPatch
  private readonly material: MeshBasicNodeMaterial
  private readonly intensity = uniform(0)

  constructor(
    source: SkinGeometry,
    private readonly skinning: SkinningData,
  ) {
    const w: N = varying(attribute('aPain', 'float'))
    const focus: N = w.greaterThan(0.36)
    const territory: N = w.greaterThan(0.21)
    const wf: N = w.sub(0.35).div(0.65).clamp(0, 1)
    this.material = new MeshBasicNodeMaterial()
    this.material.colorNode = select(focus, vec3(...new Color(PAIN_COLORS.focus).toArray()), select(territory, vec3(...new Color(PAIN_COLORS.territory).toArray()), vec3(...new Color(PAIN_COLORS.dermatome).toArray()))) as N
    // 接触区随强度变亮；两档背景是显示用的固定值，不是那里的疼痛强度
    // the contact area brightens with intensity; the two background levels are fixed display values, not pain there
    this.material.opacityNode = select(w.lessThan(0.01), float(0), select(focus, mix(float(0.3), float(0.95), wf.mul((this.intensity as N).mul(0.8).add(0.2))), select(territory, float(0.3), float(0.16)))) as N
    this.material.transparent = true
    this.material.depthWrite = false
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = -2
    this.material.polygonOffsetUnits = -4
    this.patch = new SkinPatch(source, null, this.material)
    this.patch.mesh.renderOrder = 3
    this.setSkinning('off')
  }

  /** `weights`：每个皮肤顶点一个 0–1 的值；null 为隐藏 / `weights`: one 0–1 value per skin vertex; null hides the layer. */
  setWeights(weights: Float32Array | null): void {
    this.patch.mesh.visible = !!weights
    if (weights) this.patch.setAttribute('aPain', weights, 1)
  }

  /** 此刻的强度，0–10 / The intensity right now, 0–10. */
  setIntensity(level: number): void {
    this.intensity.value = Math.min(1, Math.max(0, level / 10))
  }

  setSkinning(mode: SkinningMode): void {
    this.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.material.positionNode
    this.material.needsUpdate = true
  }

  dispose(): void {
    this.patch.dispose()
    this.material.dispose()
  }
}

/** 折线上每个点绑定到的顶点 / The vertex each polyline point is bound to. */
export interface PathBinding {
  /** 候选部件数组里的下标；-1 为没有绑定（留在静止位置）/ index into the candidates; -1 = unbound (stays at rest) */
  part: Int32Array
  vertex: Int32Array
  /** 静止空间里 点 − 顶点 / point − vertex in rest space */
  offset: Float32Array
}

/** 把折线重采样到最多 `max` 个点（保留首尾）/ Resample a polyline to at most `max` points (ends kept). */
export function resamplePolyline(flat: ArrayLike<number>, max: number): Float32Array {
  const n = Math.floor(flat.length / 3)
  if (n <= max) return Float32Array.from(flat as ArrayLike<number>)
  const out = new Float32Array(max * 3)
  for (let i = 0; i < max; i++) {
    const k = Math.round((i * (n - 1)) / (max - 1)) * 3
    out[i * 3] = flat[k]!
    out[i * 3 + 1] = flat[k + 1]!
    out[i * 3 + 2] = flat[k + 2]!
  }
  return out
}

/** 每个折线点绑定到候选部件里离它最近的顶点（静止空间）/ Bind every polyline point to the nearest vertex among the candidates (rest space). */
export function bindPath(points: Float32Array, candidates: readonly Float32Array[]): PathBinding {
  const n = points.length / 3
  const part = new Int32Array(n).fill(-1), vertex = new Int32Array(n).fill(-1), offset = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = points[i * 3]!, y = points[i * 3 + 1]!, z = points[i * 3 + 2]!
    let best = Infinity
    candidates.forEach((p, c) => {
      for (let v = 0; v < p.length; v += 3) {
        const dx = p[v]! - x, dy = p[v + 1]! - y, dz = p[v + 2]! - z
        const d = dx * dx + dy * dy + dz * dz
        if (d < best) {
          best = d
          part[i] = c
          vertex[i] = v / 3
        }
      }
    })
    if (part[i]! >= 0) {
      const p = candidates[part[i]!]!, v = vertex[i]! * 3
      offset[i * 3] = x - p[v]!
      offset[i * 3 + 1] = y - p[v + 1]!
      offset[i * 3 + 2] = z - p[v + 2]!
    }
  }
  return { part, vertex, offset }
}

/** 按绑定算出折线此刻的位置；`now(c)` 给出候选部件此刻的顶点（null 表示没变）/ The polyline's current positions from its binding; `now(c)` gives a candidate's current vertices (null = unchanged). */
export function boundPositions(rest: Float32Array, b: PathBinding, now: (candidate: number) => ArrayLike<number> | null, out: Float32Array): Float32Array {
  for (let i = 0; i < rest.length / 3; i++) {
    const p = b.part[i]! >= 0 ? now(b.part[i]!) : null
    if (!p) {
      out[i * 3] = rest[i * 3]!
      out[i * 3 + 1] = rest[i * 3 + 1]!
      out[i * 3 + 2] = rest[i * 3 + 2]!
      continue
    }
    const v = b.vertex[i]! * 3
    out[i * 3] = p[v]! + b.offset[i * 3]!
    out[i * 3 + 1] = p[v + 1]! + b.offset[i * 3 + 1]!
    out[i * 3 + 2] = p[v + 2]! + b.offset[i * 3 + 2]!
  }
  return out
}

/** 折线上按弧长比例 0–1 处的点 / The point at arc-length fraction 0–1 along a polyline. */
export function pointAlong(flat: ArrayLike<number>, fraction: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const n = Math.floor(flat.length / 3)
  if (n === 0) return out
  let total = 0
  for (let i = 1; i < n; i++) total += Math.hypot(flat[i * 3]! - flat[i * 3 - 3]!, flat[i * 3 + 1]! - flat[i * 3 - 2]!, flat[i * 3 + 2]! - flat[i * 3 - 1]!)
  let want = Math.min(1, Math.max(0, fraction)) * total
  for (let i = 1; i < n; i++) {
    const l = Math.hypot(flat[i * 3]! - flat[i * 3 - 3]!, flat[i * 3 + 1]! - flat[i * 3 - 2]!, flat[i * 3 + 2]! - flat[i * 3 - 1]!)
    if (want <= l || i === n - 1) {
      const k = l > 0 ? Math.min(1, want / l) : 0
      for (let a = 0; a < 3; a++) out[a] = flat[i * 3 - 3 + a]! + (flat[i * 3 + a]! - flat[i * 3 - 3 + a]!) * k
      return out
    }
    want -= l
  }
  return out
}

/** 通路折线和三个标记 / The pathway line and the three markers. */
export class PathVisuals {
  readonly group = new Group()
  private readonly line: Line
  private readonly lineMaterial: LineBasicNodeMaterial
  private readonly site: Mesh
  private readonly fast: Mesh
  private readonly slow: Mesh
  private positions = new Float32Array(0)

  constructor() {
    this.lineMaterial = new LineBasicNodeMaterial({ color: PAIN_COLORS.path })
    this.lineMaterial.depthTest = false
    this.lineMaterial.transparent = true
    this.lineMaterial.opacity = 0.9
    this.line = new Line(new BufferGeometry(), this.lineMaterial)
    this.line.frustumCulled = false
    this.line.renderOrder = 6
    const sphere = new SphereGeometry(1, 14, 10)
    const marker = (color: string): Mesh => {
      const m = new MeshBasicNodeMaterial({ color })
      m.depthTest = false
      m.transparent = true
      const mesh = new Mesh(sphere, m)
      mesh.renderOrder = 7
      mesh.frustumCulled = false
      mesh.visible = false
      return mesh
    }
    this.site = marker('#ffffff')
    this.fast = marker(PAIN_COLORS.fast)
    this.slow = marker(PAIN_COLORS.slow)
    this.group.add(this.line, this.site, this.fast, this.slow)
    this.group.visible = false
  }

  /** 折线此刻的位置（展平 xyz）；点数变了就重建缓冲 / The polyline's current positions (flat xyz); the buffer is rebuilt when the point count changes. */
  setLine(flat: Float32Array): void {
    const g = this.line.geometry
    if (flat.length !== this.positions.length) {
      this.positions = new Float32Array(flat.length)
      g.setAttribute('position', new BufferAttribute(this.positions, 3))
    }
    this.positions.set(flat)
    ;(g.getAttribute('position') as BufferAttribute).needsUpdate = true
    this.group.visible = flat.length >= 6
  }

  /**
   * 标记的位置：`fast` / `slow` 是沿通路的比例（0 在皮肤，1 在神经根）；null 为不显示。
   * 标记按到相机的距离缩放，在屏幕上大小大致不变。
   * Marker positions: `fast` / `slow` are fractions along the pathway (0 at the skin, 1 at the root); null hides
   * one. Markers scale with their distance from the camera so that they stay about the same size on screen.
   */
  setMarkers(fast: number | null, slow: number | null, camera: PerspectiveCamera): void {
    const place = (mesh: Mesh, fraction: number | null, px: number): void => {
      mesh.visible = fraction !== null && this.positions.length >= 3
      if (!mesh.visible) return
      const p = pointAlong(this.positions, fraction!)
      mesh.position.set(p[0], p[1], p[2])
      mesh.scale.setScalar(Math.max(0.0015, mesh.position.distanceTo(camera.position) * px))
    }
    place(this.site, 0, 0.0035)
    place(this.fast, fast, 0.0055)
    place(this.slow, slow, 0.0055)
  }

  clear(): void {
    this.group.visible = false
  }

  get points(): Float32Array {
    return this.positions
  }

  dispose(): void {
    this.line.geometry.dispose()
    this.lineMaterial.dispose()
    this.site.geometry.dispose()
    for (const m of [this.site, this.fast, this.slow]) (m.material as MeshBasicNodeMaterial).dispose()
  }
}
