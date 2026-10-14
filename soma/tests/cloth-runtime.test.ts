// 运行时布料模拟的检查：worker 的消息检查、同样输入逐位相同、姿势变化后落定、不进皮肤。
// Checks of the runtime cloth simulation: the worker's message checks, bit-identical results for the same input, settling
// after a pose change, staying out of the skin.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshCollider, type Closest } from '../src/cloth/collider.ts'
import { ClothEngine } from '../src/cloth/engine.ts'
import { decodeCloth, type ClothData, type LoadedCloth } from '../src/cloth/load.ts'
import { ClothCore, checkRequest, type Reply } from '../src/cloth/protocol.ts'
import type { Rig } from '../src/anatomy/types.ts'
import { standardPostures } from '../tools/rig/postures.ts'
import { buriedVertices } from '../tools/cloth/buried.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'

const ROOT = join(import.meta.dirname, '..', 'public', 'anatomy', 'male')
const SKIN = 'FJ2810'
const have = existsSync(join(ROOT, 'cloth', 'pants.json'))

async function body(): Promise<{ joints: Rig['joints']; skinBin: Uint8Array; index: Uint32Array; rest: Float32Array; guard: Uint32Array }> {
  const skin = (await readGlbParts(join(ROOT, 'integumentary.glb'), new Set([SKIN]))).get(SKIN)!
  const rig = JSON.parse(readFileSync(join(ROOT, 'rig.json'), 'utf8')) as Rig
  const bin = new Uint8Array(readFileSync(join(ROOT, 'rig.bin')))
  const b = rig.bindings.find((x) => x.part === SKIN)!
  const n = skin.positions.length / 3
  const guard = Uint32Array.from((JSON.parse(readFileSync(join(ROOT, 'cloth', 'index.json'), 'utf8')) as { guard: { vertices: number[] } }).guard.vertices)
  return { joints: rig.joints, skinBin: bin.slice(b.offset!, b.offset! + n * 12), index: skin.indices, rest: skin.positions, guard }
}

function garment(id: string): LoadedCloth {
  const data = JSON.parse(readFileSync(join(ROOT, 'cloth', `${id}.json`), 'utf8')) as ClothData
  const bin = readFileSync(join(ROOT, 'cloth', `${id}.bin`))
  return decodeCloth(data, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength))
}

function lerpPose(a: Record<string, number[]>, b: Record<string, number[]>, t: number): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? [], y = b[k] ?? []
    out[k] = Array.from({ length: Math.max(x.length, y.length) }, (_, i) => (x[i] ?? 0) + ((y[i] ?? 0) - (x[i] ?? 0)) * t)
  }
  return out
}

describe('cloth worker protocol', () => {
  it('names the field and what it must be when a message is wrong', () => {
    expect(() => checkRequest(null)).toThrow(/object with a "type"/)
    expect(() => checkRequest({ type: 'jump' })).toThrow(/expected init, rest, wear or step/)
    expect(() => checkRequest({ type: 'step' })).toThrow(/step\.seq/)
    expect(() => checkRequest({ type: 'step', seq: 1, pose: { pose: { knee_L: [Number.NaN] }, scales: null } })).toThrow(/step\.pose\.pose\.knee_L/)
    expect(() => checkRequest({ type: 'init', body: { joints: [{}], rest: new Float32Array(6), skinBin: new Uint8Array(3), index: new Uint32Array(3) } })).toThrow(/12 bytes per skin vertex \(24\)/)
    expect(() => checkRequest({ type: 'wear', garments: [{ data: { garment: 'cape' } }] })).toThrow(/unknown garment/)
    // 核心把错误作为一条回复送回，不抛出 / the core sends errors back as a reply instead of throwing
    expect(new ClothCore().handle({ type: 'step', seq: 0 })).toEqual([{ type: 'error', message: 'cloth worker: send init before rest or step' }])
  })
})

describe.skipIf(!have)('runtime cloth simulation (male body)', () => {
  it('gives bit-identical results for the same message sequence', async () => {
    const b = await body()
    const pose = standardPostures(b.joints).find((p) => p.id === 'knee90')!.pose
    const run = (): Reply[] => {
      const core = new ClothCore()
      const out: Reply[] = []
      out.push(...core.handle({ type: 'init', body: b }))
      core.handle({ type: 'wear', garments: [garment('pants')] })
      for (let f = 0; f < 6; f++) out.push(...core.handle({ type: 'step', seq: f, pose: { pose: lerpPose({}, pose, (f + 1) / 6), scales: null } }))
      for (let f = 6; f < 10; f++) out.push(...core.handle({ type: 'step', seq: f }))
      return out
    }
    const a = run(), c = run()
    expect(a.length).toBe(c.length)
    for (let k = 0; k < a.length; k++) {
      const x = a[k]!, y = c[k]!
      expect(x.type).toBe(y.type)
      if (x.type === 'frame' && y.type === 'frame') {
        expect(x.maxSpeed).toBe(y.maxSpeed)
        expect(Buffer.from(x.garments[0]!.positions.buffer).equals(Buffer.from(y.garments[0]!.positions.buffer))).toBe(true)
      }
    }
  }, 120_000)

  it('follows rest → squat (one jump) → rest, settles and leaves the trousers outside the skin', async () => {
    const b = await body()
    const e = new ClothEngine(b)
    e.setGarments([garment('pants')])
    const squat = standardPostures(b.joints).find((p) => p.id === 'squat')!.pose
    // 夹在皮肤褶里（两块皮相距不到 15 mm）的地方不算：那里布无处可去 / pinches (two stretches of skin under 15 mm apart) are left out: cloth has nowhere to go there
    const pinch = buriedVertices(b.rest, b.index, 0.015)
    const settle = (): number => {
      for (let f = 0; f < 240; f++) if (e.step().movingShare < 0.01) return f
      return -1
    }
    // 一帧就跳到深蹲（worker 慢的那一帧里显示已经走完了动作）：分几帧追上，之后不再落后
    // jump to the squat in one frame (the display finished the motion during one slow worker frame): it catches up over
    // a few frames and is not behind afterwards
    let behind = 0
    while (e.step(behind ? undefined : { pose: squat, scales: null }).behind) behind++
    expect(behind).toBeGreaterThan(2)
    expect(behind).toBeLessThan(30)
    // 深蹲时外生殖器夹在两腿之间，那里有少数顶点一直抖（客户端 4 秒后停算）：只要求动着的顶点不到 5 %
    // in the squat the genitalia are caught between the thighs and a few vertices there keep trembling (the client stops
    // after 4 s): only fewer than 5 % of the vertices may still move
    let share = 1
    for (let f = 0; f < 240; f++) share = e.step().movingShare
    expect(share).toBeLessThan(0.05)
    for (let f = 0; f < 12; f++) e.step({ pose: lerpPose(squat, {}, (f + 1) / 12), scales: null })
    const back = settle()
    expect(back).toBeGreaterThanOrEqual(0)
    expect(back).toBeLessThan(200)
    const col = new MeshCollider(b.rest, b.index, 0.02, 0.03)
    const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
    const x = e.worldPositions('pants')!
    let deepest = 0
    for (let i = 0; i < x.length / 3; i++) {
      if (!col.closest(x[i * 3]!, x[i * 3 + 1]!, x[i * 3 + 2]!, c)) continue
      if ([0, 1, 2].some((q) => pinch[b.index[c.tri * 3 + q]!])) continue
      deepest = Math.max(deepest, -c.signed)
    }
    expect(deepest).toBeLessThanOrEqual(0.001)
  }, 300_000)
})
