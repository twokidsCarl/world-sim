// 主视图给软组织物理提供的几样东西（与 src/pain/stim.ts 的 StimHost 同一种做法）：视图在构造时注册，
// src/softbody/client.ts 取用。单独一个小模块，视图不必引入物理的代码。
// What the main viewer provides to the soft-tissue physics (the same arrangement as StimHost in src/pain/stim.ts): the
// viewer registers at construction and src/softbody/client.ts uses it. A small module of its own, so the viewer need
// not import the physics code.

import type { SystemId } from '../anatomy/types.ts'
import type { DentPatchData } from '../viewer/dentPatch.ts'

export interface SoftHost {
  /** 主皮肤：部件 id、静止位置（默认体型）、完整的三角形（含口腔袋）/ the main skin: part id, rest positions (default shape), all triangles (oral pouch included) */
  skin(): { part: string; positions: Float32Array; indices: Uint32Array } | null
  /** 部件的原始静止几何；没加载时为 null / a part's original rest geometry; null when not loaded */
  restGeometry(partId: string): { positions: Float32Array; indices: Uint32Array } | null
  /**
   * 主皮肤在蒙皮之前的位移（米，按顶点）；null 清除。`dent`：按压凹陷的细分显示网格（皮肤不透明时代替它盖住的那几个三角形）。
   * The main skin's displacement before skinning (metres, per vertex); null clears. `dent`: the subdivided display mesh
   * of a press's dent (standing in for the triangles it covers while the skin is opaque). `parts`: the same kind of
   * displacement for other parts (by part id; the other skin pieces and the subcutaneous fat).
   */
  setSkinOffset(offset: Float32Array | null, dent?: DentPatchData | null, parts?: ReadonlyMap<string, Float32Array> | null): void
  /** 主皮肤按位移着色：每个顶点 rgba（0–1），null 关闭 / colours the main skin by displacement: rgba (0–1) per vertex; null turns it off */
  setSkinColors(rgba: Float32Array | null): void
  /** 按需加载系统（只加载几何，不改显示）/ loads systems on demand (geometry only; the display is unchanged) */
  request(systems: SystemId[]): Promise<void>
}

let host: SoftHost | null = null
let waiters: ((h: SoftHost) => void)[] = []

export function registerSoftHost(h: SoftHost | null): void {
  host = h
  if (h) {
    for (const w of waiters) w(h)
    waiters = []
  }
}

/** 视图是单独加载的代码块：等它一会儿 / The viewer is a separately loaded chunk: wait for it a while. */
export function whenSoftHost(timeoutMs = 30000): Promise<SoftHost> {
  if (host) return Promise.resolve(host)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('视图还没有准备好 / the viewer is not ready')), timeoutMs)
    waiters.push((h) => {
      clearTimeout(timer)
      resolve(h)
    })
  })
}

export function softHost(): SoftHost | null {
  return host
}
