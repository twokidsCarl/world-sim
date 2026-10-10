// Draws square lattices of 0/1 cells from storage buffers, each into its own viewport.

const SHADER = /* wgsl */ `
struct View {
  up: vec4f,
  size: u32,
}

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> cells: array<u32>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> Out {
  let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3))[vi];
  var out: Out;
  out.clip = vec4f(p, 0, 1);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let c = min(vec2u(in.uv * f32(V.size)), vec2u(V.size - 1));
  return V.up * f32(cells[c.y * V.size + c.x]);
}
`

export interface LatticeView {
  buffer: GPUBuffer
  size: number
  /** Viewport in device pixels: x, y, width, height. */
  rect: [number, number, number, number]
}

export class LatticeRenderer {
  private pipeline: GPURenderPipeline
  private cache = new Map<GPUBuffer, { uniform: GPUBuffer; group: GPUBindGroup }>()

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ code: SHADER })
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    })
  }

  /** `encoder` may already hold compute passes that prepare the buffers. Up-cells get `color`. */
  draw(encoder: GPUCommandEncoder, view: GPUTextureView, lattices: LatticeView[], color: [number, number, number]): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    pass.setPipeline(this.pipeline)
    for (const l of lattices) {
      let entry = this.cache.get(l.buffer)
      if (!entry) {
        const uniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        const group = this.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: { buffer: l.buffer } },
          ],
        })
        this.cache.set(l.buffer, (entry = { uniform, group }))
      }
      const data = new ArrayBuffer(32)
      new Float32Array(data, 0, 4).set([...color, 1])
      new Uint32Array(data, 16, 1)[0] = l.size
      this.device.queue.writeBuffer(entry.uniform, 0, data)
      pass.setViewport(...l.rect, 0, 1)
      pass.setBindGroup(0, entry.group)
      pass.draw(3)
    }
    pass.end()
  }
}
