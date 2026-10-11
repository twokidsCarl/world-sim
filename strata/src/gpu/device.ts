export interface GpuContext {
  device: GPUDevice
  format: GPUTextureFormat
}

let pending: Promise<GpuContext | null> | null = null

/**
 * 只请求一次共享设备；WebGPU 不可用时解析为 null。
 * Request the shared device once; resolves to null where WebGPU is unavailable.
 */
export function getGpu(): Promise<GpuContext | null> {
  pending ??= (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null
    // 有了时间戳查询，性能读数才能报告每个通道真实的 GPU 时间。
    // Timestamp queries let the performance readout report true GPU time per pass.
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('timestamp-query') ? ['timestamp-query'] : []
    const device = await adapter.requestDevice({ requiredFeatures })
    return { device, format: navigator.gpu.getPreferredCanvasFormat() }
  })()
  return pending
}
