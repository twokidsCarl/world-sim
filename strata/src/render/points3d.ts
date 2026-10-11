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
// 每粒子 16 个浮点的标量表；着色用其中第 14 个（q̄₆）。
// A table of 16 floats per particle; colouring uses number 14 of each (q̄₆).
@group(0) @binding(2) var<storage, read> scalar: array<f32>;

// viridis 色图的多项式拟合（Matt Zucker，公有领域），与 render/points.ts 相同。
// Polynomial fit to the viridis colour map (Matt Zucker, public domain), as in render/points.ts.
fn viridis(t: f32) -> vec3f {
  let c0 = vec3f(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  let c1 = vec3f(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  let c2 = vec3f(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  let c3 = vec3f(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  let c4 = vec3f(6.228269936347081, 14.17993336680509, 56.69055260068105);
  let c5 = vec3f(4.776384997670288, -13.74514537774601, -65.35303263337234);
  let c6 = vec3f(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

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
  if (V.species > 1.5) {
    // 按 q̄₆ 着色：0 到 0.6 映到色图，second.w 是色图用到的上限。
    // Colour by q̄₆: 0 to 0.6 mapped onto the colour map; second.w is the top of the map in use.
    out.color = viridis(clamp(scalar[ii * 16u + 14u] / 0.6, 0.0, 1.0) * V.second.w);
  } else if (V.species > 0.5 && pos[ii].w > 0.5) {
    out.color = V.second.rgb;
  }
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
  private boundScalar: GPUBuffer | null = null
  private placeholder: GPUBuffer

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
    // 不按标量着色时绑定的占位缓冲。 / Placeholder bound when not colouring by a scalar.
    this.placeholder = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE })
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
    style: {
      radius?: number
      alpha?: number
      slab?: number
      second?: [number, number, number]
      /** 按这张表里每粒子的第 14 个浮点（q̄₆）着色；mapTop 是色图用到的上限。 / Colour by float 14 of each particle in this table (q̄₆); mapTop is the top of the colour map in use. */
      scalar?: { buffer: GPUBuffer; mapTop: number }
    } = {},
  ): void {
    const scalar = style.scalar?.buffer ?? this.placeholder
    if (this.bound !== pos || this.boundScalar !== scalar) {
      this.bound = pos
      this.boundScalar = scalar
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: pos } },
          { binding: 2, resource: { buffer: scalar } },
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
        style.scalar ? 2 : style.second ? 1 : 0,
        centre[0]!,
        centre[1]!,
        centre[2]!,
        0,
        ...(style.second ?? [0, 0, 0]),
        style.scalar?.mapTop ?? 1,
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
