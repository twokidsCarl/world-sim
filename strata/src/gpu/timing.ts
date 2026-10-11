// 用时间戳查询测量一个通道（pass）的 GPU 时间。缺少该特性时计时器不起作用，
// 只报告 null，因此调用方无需分支。
// GPU time of a pass, from timestamp queries. Where the feature is missing the timer is
// inert and reports null, so callers need no branches.

export class PassTimer {
  /**
   * 被计时通道的平滑后耗时，单位毫秒；得到第一个结果之前为 null。
   * Smoothed duration of the timed pass in milliseconds, or null before the first result.
   */
  ms: number | null = null
  private querySet: GPUQuerySet | null = null
  private resolveBuffer: GPUBuffer | null = null
  private readBuffer: GPUBuffer | null = null
  private pending = false
  private armed = false

  constructor(private device: GPUDevice) {
    if (!device.features.has('timestamp-query')) return
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 })
    this.resolveBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    this.readBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  }

  /**
   * 待计时通道的描述符。上一个结果仍在回读时，本次不计时。
   * Descriptor for the pass to time. Untimed while an earlier result is still being read.
   */
  descriptor(): GPUComputePassDescriptor {
    this.armed = this.querySet !== null && !this.pending
    return this.armed
      ? { timestampWrites: { querySet: this.querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : {}
  }

  /**
   * 在被计时的通道结束之后、编码器 finish 之前调用。
   * Call after the timed pass has ended, before the encoder is finished.
   */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.armed) return
    encoder.resolveQuerySet(this.querySet!, 0, 2, this.resolveBuffer!, 0)
    encoder.copyBufferToBuffer(this.resolveBuffer!, 0, this.readBuffer!, 0, 16)
  }

  /** 在编码器提交之后调用。 / Call after the encoder has been submitted. */
  collect(): void {
    if (!this.armed) return
    this.armed = false
    this.pending = true
    const buffer = this.readBuffer!
    void buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const [begin, end] = new BigUint64Array(buffer.getMappedRange())
        const ms = Number(end! - begin!) / 1e6
        buffer.unmap()
        // 驱动偶尔会重置时间戳，表现为时间间隔为负。
        // Timestamps are occasionally reset by the driver, which shows up as a negative span.
        if (ms >= 0) this.ms = this.ms === null ? ms : 0.9 * this.ms + 0.1 * ms
      })
      .catch(() => {})
      .finally(() => (this.pending = false))
  }

  destroy(): void {
    this.querySet?.destroy()
    this.resolveBuffer?.destroy()
    this.readBuffer?.destroy()
  }
}
