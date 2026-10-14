// 布料模拟的 Web Worker 外壳：每条消息交给 ClothCore（protocol.ts），回传结果；位置和法线以可转移的缓冲送回。
// The Web Worker shell of the cloth simulation: every message goes to ClothCore (protocol.ts) and the replies are
// posted back; positions and normals travel as transferable buffers.

import { ClothCore, type Reply } from './protocol.ts'

const core = new ClothCore()

self.onmessage = (ev: MessageEvent): void => {
  for (const r of core.handle(ev.data)) {
    const transfer: Transferable[] = r.type === 'frame' ? r.garments.flatMap((g) => [g.positions.buffer, g.normals.buffer]) : []
    ;(self as unknown as Worker).postMessage(r satisfies Reply, transfer)
  }
}
