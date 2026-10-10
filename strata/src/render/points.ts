// Instanced discs drawn straight from the simulation's buffers.

const SHADER = /* wgsl */ `
struct View {
  box: vec4f,     // xy = box lengths, w = top of the colour-map range in use
  color: vec4f,
  radius: vec2f,   // disc radius in NDC, per axis
  edge: f32,       // antialiasing width as a fraction of the radius
  mode: f32,       // 0 = single colour, 1 = colour by |ψ6|, 2 = colour by species
}

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> aux: array<vec4f>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}

// Polynomial fit to the viridis colour map (Matt Zucker, public domain).
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

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  let corners = array<vec2f, 6>(
    vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let uv = corners[vi];
  let p = pos[ii].xy / V.box.xy;
  var out: Out;
  out.clip = vec4f(p.x * 2 - 1 + uv.x * V.radius.x, 1 - p.y * 2 + uv.y * V.radius.y, 0, 1);
  out.uv = uv;
  out.color = V.color.rgb;
  if (V.mode > 1.5) {
    if (pos[ii].w > 0.5) { out.color = vec3f(0.902, 0.624, 0.0); }
  } else if (V.mode > 0.5) {
    out.color = viridis(clamp(length(aux[ii].yz), 0, 1) * V.box.w);
  }
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let a = 1 - smoothstep(1 - V.edge, 1, length(in.uv));
  return vec4f(in.color, 1) * a;
}
`

/** The same fit as the shader, for Canvas2D rendering. Returns 0..1 RGB. */
export function viridis(t: number): [number, number, number] {
  const c = [
    [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
    [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
    [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    [6.228269936347081, 14.17993336680509, 56.69055260068105],
    [4.776384997670288, -13.74514537774601, -65.35303263337234],
    [-5.435455855934631, 4.645852612178535, 26.3124352495832],
  ]
  const out: [number, number, number] = [0, 0, 0]
  for (let ch = 0; ch < 3; ch++) {
    let v = 0
    for (let k = 6; k >= 0; k--) v = v * t + c[k]![ch]!
    out[ch] = Math.min(1, Math.max(0, v))
  }
  return out
}

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

  /** color is straight RGB in 0..1; size is the target in device pixels; mode 1 colours by |ψ6|, mode 2 by species. */
  draw(
    view: GPUTextureView,
    buffers: { pos: GPUBuffer; aux: GPUBuffer },
    n: number,
    box: ArrayLike<number>,
    color: [number, number, number],
    size: [number, number],
    mode: number,
    mapTop = 1,
  ): void {
    if (this.bound !== buffers.pos) {
      this.bound = buffers.pos
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: { buffer: buffers.pos } },
          { binding: 2, resource: { buffer: buffers.aux } },
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
      new Float32Array([box[0]!, box[1]!, 1, mapTop, ...color, 1, rx, ry, Math.min(1, 1.5 / radiusPx), mode]),
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

/**
 * Top of the viridis range to use over the given background. Its brightest yellow has
 * almost no contrast against a light page, so the range stops short of it there.
 */
export function mapTopFor(paper: string): number {
  const [r, g, b] = parseHex(paper)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 0.85 : 1
}

/** Okabe–Ito orange, for species B. */
export const SPECIES_B = '#e69f00'

/** Parse #rgb or #rrggbb into straight RGB in 0..1. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const v = parseInt(h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}
