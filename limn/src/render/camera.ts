import type { Bounds, View } from './Renderer'

export type Mat3 = Float32Array

export const identity3 = (): Mat3 => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

/** a * b，列主序 / a * b, column-major. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Float32Array(9)
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r]! * b[c * 3]! + a[3 + r]! * b[c * 3 + 1]! + a[6 + r]! * b[c * 3 + 2]!
  return o
}

/** 绕单位轴旋转 `angle` 弧度 / Rotation by `angle` radians about a unit axis. */
export function axisAngle(x: number, y: number, z: number, angle: number): Mat3 {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c
  return new Float32Array([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ])
}

/** 依次绕屏幕 x、y、z 轴旋转，单位为度 / Rotations in degrees about the screen's x, then y, then z axes. */
export function euler(xDeg: number, yDeg: number, zDeg: number): Mat3 {
  const r = Math.PI / 180
  return mul3(axisAngle(0, 0, 1, zDeg * r), mul3(axisAngle(0, 1, 0, yDeg * r), axisAngle(1, 0, 0, xDeg * r)))
}

/**
 * 按该朝向下实际可见的内容取景：每段已放置原子在屏幕空间的包围盒，外加边距。
 * `aspect` 是图像宽 / 高。
 * Frame what is actually visible from this orientation: the screen-space box
 * of every placed run, with a margin. `aspect` is image width / height.
 */
export function fit(bounds: Bounds, rot: Mat3 = identity3(), aspect = 1, margin = 1.1): View {
  const s = bounds.spheres
  if (s.length === 0) return { rot, center: [...bounds.center], height: bounds.radius * 2 * margin, clipFront: Infinity }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let i = 0; i < s.length; i += 4) {
    const x = rot[0]! * s[i]! + rot[3]! * s[i + 1]! + rot[6]! * s[i + 2]!
    const y = rot[1]! * s[i]! + rot[4]! * s[i + 1]! + rot[7]! * s[i + 2]!
    const z = rot[2]! * s[i]! + rot[5]! * s[i + 1]! + rot[8]! * s[i + 2]!
    const r = s[i + 3]!
    x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r)
    y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r)
    z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r)
  }
  // 从视图空间回到世界空间：rot 是正交归一的，所以用它的转置
  // back from view space to world: rot is orthonormal, so its transpose
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2
  const center: [number, number, number] = [
    rot[0]! * cx + rot[1]! * cy + rot[2]! * cz,
    rot[3]! * cx + rot[4]! * cy + rot[5]! * cz,
    rot[6]! * cx + rot[7]! * cy + rot[8]! * cz,
  ]
  return { rot, center, height: Math.max(y1 - y0, (x1 - x0) / aspect) * margin, clipFront: Infinity, halfDepth: (z1 - z0) / 2 }
}

/** 把屏幕空间的拖动（像素）变成叠加在当前旋转之上的一个旋转 / Screen-space drag in pixels to a rotation applied on top of the current one. */
export function dragRotate(rot: Mat3, dx: number, dy: number, viewportPx: number): Mat3 {
  const len = Math.hypot(dx, dy)
  if (len === 0) return rot
  const angle = (len / viewportPx) * Math.PI * 1.4
  return mul3(axisAngle(dy / len, dx / len, 0, angle), rot)
}

/** 把视图中心移动一个以 Å 给出的屏幕空间偏移 / Move the view centre by a screen-space offset given in Å. */
export function pan(view: View, dxA: number, dyA: number): [number, number, number] {
  const r = view.rot
  // rot 的各行是屏幕坐标轴在世界空间中的方向
  // rows of rot are the screen axes in world space
  return [
    view.center[0] - dxA * r[0]! - dyA * r[1]!,
    view.center[1] - dxA * r[3]! - dyA * r[4]!,
    view.center[2] - dxA * r[6]! - dyA * r[7]!,
  ]
}
