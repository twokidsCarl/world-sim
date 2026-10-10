// Instanced discs drawn straight from the simulation's position buffer.

const SHADER = /* wgsl */ `
struct View {
  box: vec4f,
  color: vec4f,
  radius: vec2f,   // disc radius in NDC, per axis
  edge: f32,       // antialiasing width as a fraction of the radius
  pad: f32,
}

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let uv = corners[vi];
  let p = pos[ii].xy / V.box.xy;
  var out: Out;
  out.clip = vec4f(p.x * 2 - 1 + uv.x * V.radius.x, 1 - p.y * 2 + uv.y * V.radius.y, 0, 1);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = 1 - smoothstep(1 - V.edge, 1, length(in.uv));
  return V.color * a;
}
`

export class PointsRenderer {
  private pipeline: GPURenderPipeline
  private uniform: GPUBuffer
  private group: GPUBindGroup | null = null
  private bound: GPUBuffer | null = null

  constructor(
    private device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({ code: SHADER })
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            // Premultiplied alpha over a transparent canvas.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
    })
    this.uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  /** color is straight RGB in 0..1; size is the target in device pixels. */
  draw(
    view: GPUTextureView,
    pos: GPUBuffer,
    n: number,
    box: ArrayLike<number>,
    color: [number, number, number],
    size: [number, number],
  ): void {
    if (this.bound !== pos) {
      this.bound = pos
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: pos } },
        ],
      })
    }
    // Radius 0.45 σ, but never under 0.75 device pixels so dilute systems stay visible.
    const rx = Math.max(0.45 / box[0]!, 0.75 / size[0]) * 2
    const ry = Math.max(0.45 / box[1]!, 0.75 / size[1]) * 2
    const radiusPx = (rx * size[0]) / 2
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([box[0]!, box[1]!, 1, 0, ...color, 1, rx, ry, Math.min(1, 1.5 / radiusPx), 0]),
    )
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.group!)
    pass.draw(6, n)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }
}

/** Parse #rgb or #rrggbb into straight RGB in 0..1. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const v = parseInt(h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}
