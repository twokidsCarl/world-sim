// 三维中的天体，绕竖直轴旋转后画成半透明的小圆盘。
// Bodies in 3D, drawn as small translucent discs after a rotation about the vertical axis.

const SHADER = /* wgsl */ `
struct View {
  color: vec4f,
  radius: vec2f,   // 圆盘半径（NDC），逐轴 / disc radius in NDC, per axis
  scale: vec2f,    // 每个世界单位对应的 NDC，逐轴 / NDC per world unit, per axis
  angle: f32,
  alpha: f32,
  // 可见薄层沿视线方向的半厚度；0 表示全部显示
  // half-thickness of the visible slab along the line of sight; 0 shows everything
  slab: f32,
  species: f32,    // 1：w 为 1 的天体用第二种颜色绘制 / 1: bodies whose w is 1 are drawn in the second colour
  centre: vec4f,   // 画在视图中心的世界坐标点 / world point drawn at the middle of the view
  second: vec4f,
}

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let uv = corners[vi];
  let p = pos[ii].xyz - V.centre.xyz;
  let x = p.x * cos(V.angle) + p.z * sin(V.angle);
  let depth = p.z * cos(V.angle) - p.x * sin(V.angle);
  var out: Out;
  out.clip = vec4f(x * V.scale.x + uv.x * V.radius.x, p.y * V.scale.y + uv.y * V.radius.y, 0, 1);
  // 在薄层之外：把圆盘塌缩掉，什么也不画。
  // Outside the slab: collapse the disc so nothing is drawn.
  if (V.slab > 0 && abs(depth) > V.slab) { out.clip = vec4f(2, 2, 0, 1); }
  out.uv = uv;
  out.color = V.color.rgb;
  if (V.species > 0.5 && pos[ii].w > 0.5) { out.color = V.second.rgb; }
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = (1 - smoothstep(0.5, 1, length(in.uv))) * V.alpha;
  return vec4f(in.color, 1) * a;
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
    this.uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  }

  /**
   * `extent` 是视图以 `centre` 为中心的半宽（世界单位）；size 是以设备像素计的
   * 目标尺寸。默认圆盘直径 2.5 px 且半透明，适合质点；`style` 可切换为
   * 世界单位的半径、薄层或按组分着色。
   * `extent` is the half-width of the view in world units about `centre`; size is the
   * target in device pixels. By default discs are 2.5 px across and translucent, which
   * suits point masses; `style` switches to a radius in world units, a slab, or species colours.
   */
  draw(
    view: GPUTextureView,
    pos: GPUBuffer,
    n: number,
    extent: number,
    centre: ArrayLike<number>,
    angle: number,
    color: [number, number, number],
    size: [number, number],
    style: { radius?: number; alpha?: number; slab?: number; second?: [number, number, number] } = {},
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
    const aspect = size[0] / size[1]
    const sx = 1 / extent / aspect
    const sy = 1 / extent
    // 半径以世界单位给定，但不小于 0.75 个设备像素。
    // A world-space radius, but never under 0.75 device pixels.
    const rx = style.radius ? Math.max(style.radius * sx, 1.5 / size[0]) : 5 / size[0]
    const ry = style.radius ? Math.max(style.radius * sy, 1.5 / size[1]) : 5 / size[1]
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      new Float32Array([
        ...color,
        1,
        rx,
        ry,
        sx,
        sy,
        angle,
        style.alpha ?? 0.55,
        style.slab ?? 0,
        style.second ? 1 : 0,
        centre[0]!,
        centre[1]!,
        centre[2]!,
        0,
        ...(style.second ?? [0, 0, 0]),
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
