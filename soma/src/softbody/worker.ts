// 软组织物理的 Web Worker 外壳：收消息、检查（protocol.ts 的 checkRequest），交给 engine.ts，回传结果。
// 体位分段走（每段约 250 ms），段与段之间让出线程，所以暂停、取消和新的请求能插进来；按压一次算完（有界，几秒到几十秒）。
// The Web Worker shell of the soft-tissue physics: receives messages, checks them (checkRequest of protocol.ts), hands
// them to engine.ts and posts the results. A posture runs in slices (about 250 ms each) and yields between them, so
// pause, cancel and new requests get in; a press runs in one go (bounded: seconds to tens of seconds).

import { SoftEngine, type PostureJob } from './engine.ts'
import { type Reply, type Request, checkRequest } from './protocol.ts'

const engine = new SoftEngine()
let job: PostureJob | null = null
let paused = false
let scheduled = false

const post = (r: Reply): void => {
  const transfer: Transferable[] = []
  if (r.type === 'posture-done') transfer.push(r.offsets.buffer, ...r.parts.map((p) => p.offsets.buffer))
  if (r.type === 'press-done') transfer.push(r.dent.vertices.buffer, r.dent.offsets.buffer)
  ;(self as unknown as Worker).postMessage(r, transfer)
}

function pump(): void {
  scheduled = false
  if (!job || paused) return
  const j = job
  let r: Reply
  try {
    r = j.step(250)
  } catch (err) {
    job = null
    post({ type: 'error', id: j.id, message: err instanceof Error ? err.message : String(err) })
    return
  }
  if (job !== j) return
  post(r)
  if (r.type === 'posture-done') job = null
  else schedule()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  setTimeout(pump, 0)
}

self.onmessage = (ev: MessageEvent): void => {
  let m: Request
  try {
    m = checkRequest(ev.data)
  } catch (err) {
    const id = typeof (ev.data as { id?: unknown })?.id === 'number' ? (ev.data as { id: number }).id : -1
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
    return
  }
  const id = 'id' in m ? m.id : -1
  try {
    switch (m.type) {
      case 'init':
        engine.init(m.body)
        job = null
        post({ type: 'ready', insideMs: engine.insideMs })
        return
      case 'meshes':
        engine.addMeshes(m.meshes)
        return
      case 'press':
        post(engine.press(m.id, m.site, m.probe, m.target, post))
        return
      case 'posture':
        job = engine.startPosture(m.id, m.posture)
        schedule()
        return
      case 'pause':
        paused = m.paused
        if (!paused) schedule()
        return
      case 'cancel':
        if (job?.id === m.id) job = null
        return
    }
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}
