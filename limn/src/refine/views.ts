import { axisAngle, mul3, type Mat3 } from '../render/camera'
import type { Bounds } from '../render/Renderer'

/** Principal axes of the scene, longest first, as rows of a rotation. */
export function principalFrame(b: Bounds): Mat3 {
  const s = b.spheres
  const n = s.length / 4
  if (n < 3) return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < s.length; i += 4) {
    mx += s[i]!
    my += s[i + 1]!
    mz += s[i + 2]!
  }
  mx /= n
  my /= n
  mz /= n
  const c = [0, 0, 0, 0, 0, 0] // xx xy xz yy yz zz
  for (let i = 0; i < s.length; i += 4) {
    const x = s[i]! - mx, y = s[i + 1]! - my, z = s[i + 2]! - mz
    c[0]! += x * x; c[1]! += x * y; c[2]! += x * z; c[3]! += y * y; c[4]! += y * z; c[5]! += z * z
  }
  // Jacobi eigen-decomposition of the 3x3 covariance
  const a = [[c[0]!, c[1]!, c[2]!], [c[1]!, c[3]!, c[4]!], [c[2]!, c[4]!, c[5]!]]
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 24; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p]![q]!) < 1e-9) continue
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!)
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!, akq = a[k]![q]!
        a[k]![p] = cs * akp - sn * akq
        a[k]![q] = sn * akp + cs * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!, aqk = a[q]![k]!
        a[p]![k] = cs * apk - sn * aqk
        a[q]![k] = sn * apk + cs * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!, vkq = v[k]![q]!
        v[k]![p] = cs * vkp - sn * vkq
        v[k]![q] = sn * vkp + cs * vkq
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j]![j]! - a[i]![i]!)
  const e = order.map((i) => [v[0]![i]!, v[1]![i]!, v[2]![i]!])
  // screen x = middle axis, y = longest axis (tall subjects stand upright), z = shortest
  const y = e[0]!, x = e[1]!
  const z = [x[1]! * y[2]! - x[2]! * y[1]!, x[2]! * y[0]! - x[0]! * y[2]!, x[0]! * y[1]! - x[1]! * y[0]!]
  return new Float32Array([x[0]!, y[0]!, z[0]!, x[1]!, y[1]!, z[1]!, x[2]!, y[2]!, z[2]!])
}

/** Twelve candidate viewing directions built on the principal axes. */
export function candidateViews(b: Bounds): Mat3[] {
  const base = principalFrame(b)
  const rad = Math.PI / 180
  const ry = (d: number) => axisAngle(0, 1, 0, d * rad), rx = (d: number) => axisAngle(1, 0, 0, d * rad)
  const out: Mat3[] = []
  for (const d of [0, 90, 180, 270]) out.push(mul3(ry(d), base)) // around the long axis
  for (const d of [45, 135, 225, 315]) out.push(mul3(rx(22), mul3(ry(d), base))) // three-quarter views
  out.push(mul3(rx(90), base), mul3(rx(-90), base)) // down the long axis, both ends
  out.push(mul3(rx(55), base), mul3(rx(-55), mul3(ry(90), base)))
  return out
}
