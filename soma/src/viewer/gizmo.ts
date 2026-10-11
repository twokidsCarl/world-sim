// 关节操纵环：每个自由度一个圆环，拖动圆环绕该自由度的轴转动关节。
// The joint gizmo: one ring per dof; dragging a ring turns the joint about that dof's axis.

import { BufferAttribute, BufferGeometry, Group, Line, LineBasicNodeMaterial, Vector3, type PerspectiveCamera } from 'three/webgpu'

const SEGMENTS = 72
const COLORS = [0xe8574a, 0x58c46a, 0x4f8fe8]
/** 圆环的屏幕半径（CSS 像素），第 k 个自由度依次大一圈 / On-screen ring radius (CSS px); each dof a bit larger. */
const RING_PX = [58, 70, 82]
/** 指针离圆环多近（CSS 像素）算抓住 / How close (CSS px) the pointer must be to grab a ring. */
const GRAB_PX = 9

export interface GizmoDof {
  /** 自由度的世界方向（单位向量）/ World direction of the dof (unit). */
  axis: [number, number, number]
}

export class JointGizmo {
  readonly group = new Group()
  private readonly rings: Line[] = []
  private readonly center = new Vector3()
  private axes: Vector3[] = []
  private radii: number[] = []

  constructor() {
    for (let k = 0; k < 3; k++) {
      const g = new BufferGeometry()
      // 首尾各存一次同一个点，用折线闭合成环（渲染器不支持 LineLoop）
      // the first point is stored again at the end so a plain line closes the ring (LineLoop is not supported by the renderer)
      g.setAttribute('position', new BufferAttribute(new Float32Array((SEGMENTS + 1) * 3), 3))
      const m = new LineBasicNodeMaterial({ color: COLORS[k] })
      m.depthTest = false
      m.depthWrite = false
      m.transparent = true
      const ring = new Line(g, m)
      ring.frustumCulled = false
      ring.renderOrder = 20
      ring.visible = false
      this.rings.push(ring)
      this.group.add(ring)
    }
    this.group.visible = false
  }

  /** 隐藏 / Hide. */
  clear(): void {
    this.group.visible = false
    this.axes = []
  }

  /**
   * 按关节中心、各自由度的轴和相机重建圆环（屏幕上大小恒定）。
   * Rebuild the rings from the joint centre, the dof axes and the camera (constant on-screen size).
   */
  update(center: [number, number, number], dofs: GizmoDof[], camera: PerspectiveCamera, viewportHeight: number): void {
    this.center.set(...center)
    const perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.distanceTo(this.center)) / Math.max(1, viewportHeight)
    this.axes = dofs.map((d) => new Vector3(...d.axis).normalize())
    this.radii = dofs.map((_, k) => RING_PX[k % 3]! * perPixel)
    const u = new Vector3()
    const v = new Vector3()
    this.rings.forEach((ring, k) => {
      const axis = this.axes[k]
      ring.visible = !!axis
      if (!axis) return
      // 圆环所在平面的两个正交方向 / two orthogonal directions spanning the ring's plane
      u.set(1, 0, 0)
      if (Math.abs(axis.x) > 0.9) u.set(0, 1, 0)
      u.cross(axis).normalize()
      v.crossVectors(axis, u)
      const pos = ring.geometry.getAttribute('position') as BufferAttribute
      const r = this.radii[k]!
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2
        const c = Math.cos(a) * r
        const s = Math.sin(a) * r
        pos.setXYZ(i, this.center.x + u.x * c + v.x * s, this.center.y + u.y * c + v.y * s, this.center.z + u.z * c + v.z * s)
      }
      pos.needsUpdate = true
    })
    this.group.visible = this.axes.length > 0
  }

  /** 指针下的圆环（自由度下标），没有则为 -1 / The ring (dof index) under the pointer, or -1. */
  hit(clientX: number, clientY: number, camera: PerspectiveCamera, rect: DOMRect): number {
    if (!this.group.visible) return -1
    let best = -1
    let bestD = GRAB_PX
    const p = new Vector3()
    this.rings.forEach((ring, k) => {
      if (!ring.visible) return
      const pos = ring.geometry.getAttribute('position') as BufferAttribute
      for (let i = 0; i < SEGMENTS; i++) {
        p.fromBufferAttribute(pos, i).project(camera)
        if (p.z > 1) continue
        const x = rect.left + ((p.x + 1) / 2) * rect.width
        const y = rect.top + ((1 - p.y) / 2) * rect.height
        const d = Math.hypot(x - clientX, y - clientY)
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
    })
    return best
  }

  /**
   * 拖动产生的转角增量：指针绕关节中心在屏幕上转过的角度，符号取决于轴是朝向还是背向观察者。
   * Angle increment of a drag: how far the pointer turned about the joint centre on screen, signed
   * by whether the axis points towards or away from the viewer.
   */
  dragDelta(dof: number, from: { x: number; y: number }, to: { x: number; y: number }, camera: PerspectiveCamera, rect: DOMRect): number {
    const axis = this.axes[dof]
    if (!axis) return 0
    const c = this.center.clone().project(camera)
    const cx = rect.left + ((c.x + 1) / 2) * rect.width
    const cy = rect.top + ((1 - c.y) / 2) * rect.height
    // 屏幕 y 向下，取反后逆时针为正 / screen y points down; negate so counter-clockwise is positive
    const a0 = Math.atan2(-(from.y - cy), from.x - cx)
    const a1 = Math.atan2(-(to.y - cy), to.x - cx)
    let d = a1 - a0
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    const towardViewer = axis.dot(camera.position.clone().sub(this.center)) > 0
    return towardViewer ? d : -d
  }

  dispose(): void {
    for (const r of this.rings) {
      r.geometry.dispose()
      ;(r.material as LineBasicNodeMaterial).dispose()
    }
  }
}
