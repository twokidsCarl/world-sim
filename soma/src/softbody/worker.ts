// 软组织物理的 Web Worker 外壳：收消息、检查（protocol.ts 的 checkRequest），交给 engine.ts，回传结果。
// 体位分段走（每段约 250 ms），段与段之间让出线程，所以暂停、取消和新的请求能插进来；按压一次算完（有界，几秒到几十秒）。
// 有 WebGPU 时求解在 GPU 上（src/softbody/gpu/），否则在这个 worker 的 CPU 上；init 里的 gpu: false 强制用 CPU。
// The Web Worker shell of the soft-tissue physics: receives messages, checks them (checkRequest of protocol.ts), hands
// them to engine.ts and posts the results. A posture runs in slices (about 250 ms each) and yields between them, so
// pause, cancel and new requests get in; a press runs in one go (bounded: seconds to tens of seconds). With WebGPU the
// solve runs on the GPU (src/softbody/gpu/), otherwise on this worker's CPU; gpu: false in init forces the CPU.

import { SoftEngine, type PostureJob } from './engine.ts'
import { gpuDevice, gpuUnavailableReason, warmGpu } from './gpu/gpu.ts'
import { type Reply, type Request, checkRequest } from './protocol.ts'

const engine = new SoftEngine()
let job: PostureJob | null = null
let paused = false
let scheduled = false
/** 这个 worker 用不用 GPU：init 时定（请求允许且有 WebGPU 设备）/ whether this worker uses the GPU: decided at init (allowed by the request and a WebGPU device present) */
let useGpu = false

const post = (r: Reply): void => {
  const transfer: Transferable[] = []
  if (r.type === 'posture-done') transfer.push(r.offsets.buffer, ...r.parts.map((p) => p.offsets.buffer))
  if (r.type === 'press-done') transfer.push(r.dent.vertices.buffer, r.dent.offsets.buffer)
  ;(self as unknown as Worker).postMessage(r, transfer)
}

async function pump(): Promise<void> {
  scheduled = false
  if (!job || paused) return
  const j = job
  let r: Reply
  try {
    r = await j.step(250)
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
  setTimeout(() => void pump(), 0)
}

self.onmessage = async (ev: MessageEvent): Promise<void> => {
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
        const device = m.gpu !== false ? await gpuDevice() : null
        useGpu = !!device
        if (device) warmGpu(device)
        post({ type: 'ready', insideMs: engine.insideMs, backend: useGpu ? 'gpu' : 'cpu', ...(useGpu || m.gpu === false ? {} : { gpuReason: gpuUnavailableReason() ?? '' }) })
        return
      case 'meshes':
        engine.addMeshes(m.meshes)
        return
      case 'press':
        post(useGpu ? await engine.pressGpu(m.id, m.site, m.probe, m.target, post) : engine.press(m.id, m.site, m.probe, m.target, post))
        return
      case 'posture':
        job = useGpu ? await engine.startPostureGpu(m.id, m.posture) : engine.startPosture(m.id, m.posture)
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
