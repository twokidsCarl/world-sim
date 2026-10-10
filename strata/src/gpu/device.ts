export interface GpuContext {
  device: GPUDevice
  format: GPUTextureFormat
}

let pending: Promise<GpuContext | null> | null = null

/** Request the shared device once; resolves to null where WebGPU is unavailable. */
export function getGpu(): Promise<GpuContext | null> {
  pending ??= (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null
    const device = await adapter.requestDevice()
    return { device, format: navigator.gpu.getPreferredCanvasFormat() }
  })()
  return pending
}
