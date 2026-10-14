// 布料 worker 的消息格式与检查，以及 worker 的核心（不依赖 Worker 环境，测试直接调用）。
// The cloth worker's message format and checks, and the worker's core (independent of the Worker environment; the
// tests call it directly).
//
// 主线程 → worker / main thread → worker
//   init  人体：关节、皮肤的蒙皮影响（rig.bin 里皮肤那一段）、皮肤三角形、静止位置
//         the body: joints, the skin's influences (its slice of rig.bin), the skin triangles, the rest positions
//   rest  皮肤静止位置变了（体型）/ the skin's rest positions changed (shape)
//   wear  穿着的衣服（完整列表，顺序不限）/ the garments worn (the full list, any order)
//   step  推进一帧；带 pose 时这一帧到达这个姿势 / advance one frame; with `pose`, this frame reaches that pose
// worker → 主线程 / worker → main thread
//   ready、frame（每件衣服的位置和法线，可转移的缓冲）、error
//   ready, frame (each garment's positions and normals, transferable buffers), error
// 同样的消息序列得到逐位相同的结果：worker 只在收到 step 时推进，不看时钟。
// The same message sequence gives bit-identical results: the worker only advances on a step and never reads a clock.

import type { Pose, Scales } from '../../tools/rig/pose.ts'
import type { Joint } from '../anatomy/types.ts'
import { ClothEngine, type FrameResult, type GarmentOut } from './engine.ts'
import { GARMENTS, type GarmentId } from './garments.ts'
import type { ClothData, LoadedCloth } from './load.ts'

export interface BodyMsg {
  joints: Joint[]
  skinBin: Uint8Array
  index: Uint32Array
  rest: Float32Array
  /** 做反向检查的皮肤顶点（见 EngineBody.guard）/ skin vertices given the reverse check (see EngineBody.guard) */
  guard?: Uint32Array
}

/** 一件衣服：解码后的数组（结构化克隆）/ One garment: its decoded arrays (structured clone). */
export type GarmentMsg = LoadedCloth

export type Request =
  | { type: 'init'; body: BodyMsg }
  | { type: 'rest'; rest: Float32Array }
  | { type: 'wear'; garments: GarmentMsg[] }
  | { type: 'step'; seq: number; pose?: { pose: Pose; scales: Scales | null } }

export type GarmentFrame = GarmentOut

export type Reply =
  | { type: 'ready' }
  | ({ type: 'frame'; seq: number; garments: GarmentFrame[] } & FrameResult)
  | { type: 'error'; message: string }

const fail = (msg: string): never => {
  throw new Error(`cloth worker: ${msg}`)
}

function isTyped(v: unknown, C: { new (...a: never[]): unknown }): boolean {
  return v instanceof C
}

/** 检查一条请求；不合格时抛出说明哪个字段、要什么 / Check a request; throws naming the field and what it must be. */
export function checkRequest(m: unknown): Request {
  if (!m || typeof m !== 'object') fail('a message must be an object with a "type"')
  const r = m as Record<string, unknown>
  switch (r.type) {
    case 'init': {
      const b = r.body as Record<string, unknown> | undefined
      if (!b || typeof b !== 'object') fail('init.body is required')
      if (!Array.isArray(b!.joints) || b!.joints.length === 0) fail('init.body.joints must be a non-empty array of joints')
      if (!isTyped(b!.rest, Float32Array) || (b!.rest as Float32Array).length % 3) fail('init.body.rest must be a Float32Array of xyz triples')
      const n = (b!.rest as Float32Array).length / 3
      if (!isTyped(b!.skinBin, Uint8Array) || (b!.skinBin as Uint8Array).length !== n * 12) fail(`init.body.skinBin must be a Uint8Array of 12 bytes per skin vertex (${n * 12})`)
      if (!isTyped(b!.index, Uint32Array) || (b!.index as Uint32Array).length % 3) fail('init.body.index must be a Uint32Array of triangles')
      for (const v of b!.index as Uint32Array) if (v >= n) fail(`init.body.index refers to vertex ${v}, the skin has ${n}`)
      if (b!.guard !== undefined && (!isTyped(b!.guard, Uint32Array) || (b!.guard as Uint32Array).some((v) => v >= n))) fail(`init.body.guard must be a Uint32Array of skin vertex indices below ${n}`)
      return r as Request
    }
    case 'rest':
      if (!isTyped(r.rest, Float32Array)) fail('rest.rest must be a Float32Array')
      return r as Request
    case 'wear': {
      if (!Array.isArray(r.garments)) fail('wear.garments must be an array (empty to wear nothing)')
      for (const g of r.garments as GarmentMsg[]) {
        if (!g || !g.data || !(GARMENTS as readonly string[]).includes(g.data.garment)) fail(`wear.garments: unknown garment; expected one of ${GARMENTS.join(', ')}`)
        if (!isTyped(g.position, Float32Array) || g.position.length !== g.data.vertexCount * 3) fail(`wear.garments[${g.data.garment}].position must hold vertexCount × 3 floats`)
      }
      return r as Request
    }
    case 'step':
      if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) fail('step.seq must be a number')
      if (r.pose !== undefined) {
        const p = r.pose as Record<string, unknown>
        if (!p || typeof p.pose !== 'object' || p.pose === null) fail('step.pose.pose must be an object of joint id → angles')
        for (const [k, v] of Object.entries(p.pose as object)) if (!Array.isArray(v) || v.some((a) => typeof a !== 'number' || !Number.isFinite(a))) fail(`step.pose.pose.${k} must be an array of finite angles (radians)`)
        if (p.scales !== null && p.scales !== undefined && typeof p.scales !== 'object') fail('step.pose.scales must be an object or null')
      }
      return r as Request
  }
  return fail(`unknown message type "${String(r.type)}"; expected init, rest, wear or step`)
}

/** worker 的核心：持有引擎，处理一条请求，返回要发回的消息 / The worker's core: holds the engine, handles one request and returns the replies. */
export class ClothCore {
  private engine: ClothEngine | null = null
  private worn = new Map<GarmentId, LoadedCloth>()

  handle(raw: unknown): Reply[] {
    let m: Request
    try {
      m = checkRequest(raw)
    } catch (err) {
      return [{ type: 'error', message: err instanceof Error ? err.message : String(err) }]
    }
    try {
      switch (m.type) {
        case 'init':
          this.engine = new ClothEngine(m.body)
          if (this.worn.size) this.engine.setGarments([...this.worn.values()])
          return [{ type: 'ready' }]
        case 'rest':
          this.need().setRest(m.rest)
          return []
        case 'wear': {
          const next = new Map<GarmentId, LoadedCloth>()
          // 已穿着的同一件衣服保留它的模拟状态 / a garment already worn keeps its simulation state
          for (const g of m.garments) next.set(g.data.garment, this.worn.get(g.data.garment) ?? g)
          this.worn = next
          this.engine?.setGarments([...next.values()])
          return []
        }
        case 'step': {
          const e = this.need()
          const r = e.step(m.pose)
          return [{ type: 'frame', seq: m.seq, ...r, garments: e.garments() }]
        }
      }
    } catch (err) {
      return [{ type: 'error', message: err instanceof Error ? err.message : String(err) }]
    }
    return []
  }

  private need(): ClothEngine {
    if (!this.engine) fail('send init before rest or step')
    return this.engine!
  }

  /** 检查用 / For checks. */
  get current(): ClothEngine | null {
    return this.engine
  }
}

export type { ClothData }
