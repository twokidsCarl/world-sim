// Bodies in 3D, drawn as small translucent discs after a rotation about the vertical axis.

const SHADER = /* wgsl */ `
struct View {
  color: vec4f,
  radius: vec2f,   // disc radius in NDC, per axis
  scale: vec2f,    // NDC per world unit, per axis
  angle: f32,
  alpha: f32,
  centre: vec4f,   // world point drawn at the middle of the view
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
  let p = pos[ii].xyz - V.centre.xyz;
  let x = p.x * cos(V.angle) + p.z * sin(V.angle);
  var out: Out;
  out.clip = vec4f(x * V.scale.x + uv.x * V.radius.x, p.y * V.scale.y + uv.y * V.radius.y, 0, 1);
  out.uv = uv;
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = (1 - smoothstep(0.5, 1, length(in.uv))) * V.alpha;
  return vec4f(V.color.rgb, 1) * a;
}
`

export class Points3dRenderer {
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
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
    })
    this.uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  /** `extent` is the half-width of the view in world units about `centre`; size is the target in device pixels. */
  draw(
    view: GPUTextureView,
    pos: GPUBuffer,
    n: number,
    extent: number,
    centre: ArrayLike<number>,
    angle: number,
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
    const radiusPx = 2.5
    const aspect = size[0] / size[1]
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        ...color,
        1,
        (2 * radiusPx) / size[0],
        (2 * radiusPx) / size[1],
        1 / extent / aspect,
        1 / extent,
        angle,
        0.55,
        0,
        0,
        centre[0]!,
        centre[1]!,
        centre[2]!,
        0,
      ]),
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
