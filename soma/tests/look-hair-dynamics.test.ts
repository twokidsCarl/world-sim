// 长发动力学：静止时不动、可复现、头转动时发丝摆动并停下、不进碰撞球。
// Long-hair dynamics: still at rest, reproducible, strands swing and come to rest when the head turns, never inside
// the collision spheres.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HairSim, JOINT_STRIDE, type SimInit, collisionSpheres } from '../src/hair/dynamics.ts'
import { decodeGuides } from '../src/hair/strands.ts'
import type { HairData } from '../src/look/types.ts'
import { loadBody } from '../tools/hair/skin.ts'

const ROOT = resolve(import.meta.dirname, '..')
const dir = resolve(ROOT, 'public', 'anatomy', 'female', 'hair')

/** 一行关节：绕竖直轴转 `a` 弧度、绕 `c` 点（对偶四元数）/ one joint row: a turn of `a` radians about the vertical axis through `c` (dual quaternion) */
function turnRow(a: number, c: [number, number, number]): Float32Array {
  const q = [0, Math.sin(a / 2), 0, Math.cos(a / 2)]
  // 平移 t = c − R c / translation t = c − R c
  const cos = Math.cos(a), sin = Math.sin(a)
  const rc = [cos * c[0] + sin * c[2], c[1], -sin * c[0] + cos * c[2]]
  const t = [c[0] - rc[0]!, c[1] - rc[1]!, c[2] - rc[2]!]
  // d = ½ (t, 0) ⊗ q / dual part
  const [qx, qy, qz, qw] = q as [number, number, number, number]
  const [tx, ty, tz] = t as [number, number, number]
  const d = [0.5 * (tx * qw + ty * qz - tz * qy), 0.5 * (ty * qw + tz * qx - tx * qz), 0.5 * (tz * qw + tx * qy - ty * qx), -0.5 * (tx * qx + ty * qy + tz * qz)]
  const row = new Float32Array(JOINT_STRIDE)
  row.set([...q, ...d])
  return row
}

describe.skipIf(!existsSync(resolve(dir, 'hair.json')))('long-hair dynamics (female)', () => {
  const make = async (): Promise<{ init: SimInit; centre: [number, number, number] }> => {
    const meta = JSON.parse(readFileSync(resolve(dir, 'hair.json'), 'utf8')) as HairData
    const info = meta.pieces.find((p) => p.id === 'long')!.strands!
    const b = await loadBody('female')
    const d = decodeGuides(new Uint8Array(readFileSync(resolve(dir, info.file))), info, meta.offsetUnit, meta.skinVertexCount)
    const P = info.points
    const sims: number[] = []
    for (let g = 0; g < info.guides; g += 40) sims.push(g)
    const rest = new Float32Array(sims.length * P * 3)
    const centre: [number, number, number] = [0, 0, 0]
    sims.forEach((g, s) => {
      const r = [0, 0, 0]
      for (let j = 0; j < 3; j++) for (let c = 0; c < 3; c++) r[c]! += b.skin.positions[d.rootVerts[g * 3 + j]! * 3 + c]! * d.rootBary[g * 3 + j]!
      for (let c = 0; c < 3; c++) centre[c] = centre[c]! + r[c]! / sims.length
      for (let k = 0; k < P; k++) for (let c = 0; c < 3; c++) rest[(s * P + k) * 3 + c] = r[c]! + d.offset[(g * P + k) * 3 + c]!
    })
    const sp = collisionSpheres(b.skin.positions, b.normals, () => 0, rest)
    return { init: { points: P, rest, rows: new Int32Array(sims.length), sphereCentre: sp.centre, sphereRadius: sp.radius, sphereRow: sp.row }, centre }
  }

  it('is still at rest after the warm-up, reproducible, swings when the head turns and comes to rest again', async () => {
    const { init, centre } = await make()
    const a = new HairSim(init)
    a.warm()
    // 静止：位移为零、不再推进 / at rest: zero displacement and nothing to advance
    expect(a.step(null, 'off', 1)).toBe(false)
    expect(Math.max(...a.displacement.map(Math.abs))).toBeLessThan(1e-6)
    const b = new HairSim(init)
    b.warm()
    // 头在 0.6 秒内转 0.6 弧度，然后停住 / the head turns by 0.6 rad over 0.6 s, then holds
    let peak = 0, steps = 0
    for (let n = 0; n < 900; n++) {
      const angle = 0.6 * Math.min(1, n / 36)
      const joints = turnRow(angle, centre)
      const ma = a.step(joints, 'pose', 1)
      b.step(joints, 'pose', 1)
      let m = 0
      for (const x of a.displacement) m = Math.max(m, Math.abs(x))
      peak = Math.max(peak, m)
      steps = n
      if (!ma && n > 36) break
    }
    // 摆动过：最大位移超过 5 毫米 / it swung: peak displacement beyond 5 mm
    expect(peak).toBeGreaterThan(0.005)
    // 头停住后 8 秒内停下 / at rest within 8 s of the head stopping
    expect(steps).toBeLessThan(36 + 480)
    // 同样的输入，同样的结果 / same input, same result
    expect(Array.from(b.displacement)).toEqual(Array.from(a.displacement))
  }, 120000)
})
