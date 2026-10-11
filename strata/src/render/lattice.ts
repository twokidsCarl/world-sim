// 从存储缓冲区绘制正方晶格，每个晶格画在各自的视口中。格子取 0/1 时用一种颜色画出取 1 的格子；
// 取多种离散状态时按调色板着色。
// Draws square lattices from storage buffers, each into its own viewport. With 0/1 cells
// the 1-cells get one colour; with several discrete states the cells are coloured from a palette.

import { STATE_COLOURS } from './palette'

const SHADER = /* wgsl */ `
struct View {
  up: vec4f,
  size: u32,
  offset: u32,   // 这张方格在缓冲里的起始下标 / index in the buffer where this lattice starts
  palette: u32,  // 1 = 按调色板给状态着色 / 1 = colour the states from the palette
}

const PALETTE = array<vec3f, 8>(${STATE_COLOURS.map(([r, g, b]) => `vec3f(${r / 255}, ${g / 255}, ${b / 255})`).join(', ')});

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
  let v = cells[V.offset + c.y * V.size + c.x];
  if (V.palette == 1u) { return vec4f(PALETTE[min(v, 7u)], 1); }
  return V.up * f32(v);
}
`

export interface LatticeView {
  buffer: GPUBuffer
  size: number
  /** 方格在缓冲里的起始下标（三维晶格的一个截面）；默认 0。 / Index where the lattice starts in the buffer (a slice of a 3D lattice); 0 by default. */
  offset?: number
  /** 以设备像素计的视口：x、y、宽、高。 / Viewport in device pixels: x, y, width, height. */
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

  /**
   * `encoder` 中可以已经含有准备这些缓冲区的计算通道。取值为 1 的格子用 `color` 着色。
   * `encoder` may already hold compute passes that prepare the buffers. Up-cells get `color`.
   * `palette` 为真时改按调色板给各状态着色。 / With `palette` set, the states are coloured from the palette instead.
   */
  draw(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    lattices: LatticeView[],
    color: [number, number, number],
    palette = false,
  ): void {
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
      new Uint32Array(data, 16, 3).set([l.size, l.offset ?? 0, Number(palette)])
      this.device.queue.writeBuffer(entry.uniform, 0, data)
      pass.setViewport(...l.rect, 0, 1)
      pass.setBindGroup(0, entry.group)
      pass.draw(3)
    }
    pass.end()
  }
}
