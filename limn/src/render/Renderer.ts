import { COMPOSITE_FS, EDGE_FS, QUAD_VS, SPHERE_FS, SPHERE_VS } from './shaders'
import type { Style } from './style'

/** One contiguous run of atoms, placed by one matrix. */
export interface Draw {
  start: number
  count: number
  /** column-major 4x4 */
  matrix: Float32Array
  /** added to each atom's chain index so every placed copy outlines separately */
  subunitBase: number
  molecule: number
  /** world position of the whole molecule's centre, for depth layers */
  center?: [number, number, number]
}

/** Atoms sharing one set of GPU buffers, drawn one or more times. */
export interface RenderItem {
  /** x, y, z, radius per atom */
  posr: Float32Array
  /** RGBA8 per atom */
  color: Uint8Array
  /** chain index, residue number (offset to be non-negative) per atom */
  ids: Uint32Array
  draws: Draw[]
  /** typical diameter of one chain in Å; lines between chains fade when this gets small on screen */
  subunitSize: number
}

export interface View {
  /** column-major 3x3, world to view; +z points at the viewer */
  rot: Float32Array
  center: [number, number, number]
  /** Å spanned by the image height */
  height: number
  /** atoms nearer than this view-space z are dropped; Infinity = no cut */
  clipFront: number
  /** view-space z where depth fading starts and ends; default: the scene's bounding sphere */
  fogSpan?: [number, number]
}

export interface Bounds {
  center: [number, number, number]
  radius: number
  /** x, y, z, r of every placed run, for framing a particular view */
  spheres: Float32Array
  subunitSize: number
}

interface Target {
  w: number
  h: number
  gbuf: WebGLFramebuffer
  color: WebGLTexture
  ids: WebGLTexture
  depth: WebGLTexture
  edgeFbo: WebGLFramebuffer
  edge: WebGLTexture
  outFbo: WebGLFramebuffer
  out: WebGLTexture
}

interface GpuItem {
  posr: WebGLBuffer
  color: WebGLBuffer
  ids: WebGLBuffer
  draws: Draw[]
  atoms: number
  /** this item's own bounds, before its placement */
  local: Bounds
  /** column-major 4x4 applied after the draw matrices */
  place: Float32Array
}

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

export class Renderer {
  readonly gl: WebGL2RenderingContext
  private sphere: WebGLProgram
  private edgeProg: WebGLProgram
  private compProg: WebGLProgram
  private quad: WebGLBuffer
  private vao: WebGLVertexArrayObject
  private quadVao: WebGLVertexArrayObject
  private items: GpuItem[] = []
  private target: Target | null = null
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  bounds: Bounds = { center: [0, 0, 0], radius: 1, spheres: new Float32Array(0), subunitSize: 30 }
  /** instanced spheres drawn in the last frame */
  lastAtoms = 0

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('这个浏览器不支持 WebGL2')
    this.gl = gl
    this.sphere = this.program(SPHERE_VS, SPHERE_FS)
    this.edgeProg = this.program(QUAD_VS, EDGE_FS)
    this.compProg = this.program(QUAD_VS, COMPOSITE_FS)

    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

    this.quadVao = gl.createVertexArray()!
    gl.bindVertexArray(this.quadVao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    for (const loc of [1, 2, 3]) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    // an empty stage is paper, not a black hole
    gl.clearColor(1, 1, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl
    const p = gl.createProgram()!
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s))
      gl.attachShader(p, s)
    }
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p))
    this.uniforms.set(p, new Map())
    return p
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const m = this.uniforms.get(p)!
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name))
    return m.get(name)!
  }

  setScene(items: RenderItem[]): void {
    const gl = this.gl
    for (const it of this.items) {
      gl.deleteBuffer(it.posr)
      gl.deleteBuffer(it.color)
      gl.deleteBuffer(it.ids)
    }
    this.items = items.map((it) => {
      const mk = (data: ArrayBufferView) => {
        const b = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, b)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
        return b
      }
      return { posr: mk(it.posr), color: mk(it.color), ids: mk(it.ids), draws: it.draws, atoms: it.posr.length / 4, local: sceneBounds([it]), place: IDENTITY4 }
    })
    this.bounds = this.placedBounds()
  }

  /** Bounds of item `i` on its own, ignoring where it is placed. */
  localBounds(i: number): Bounds | undefined {
    return this.items[i]?.local
  }

  /** Move whole items rigidly (one matrix per item) without re-uploading atoms. */
  setPlacements(mats: Float32Array[]): void {
    this.items.forEach((it, i) => (it.place = mats[i] ?? IDENTITY4))
    this.bounds = this.placedBounds()
  }

  private placedBounds(): Bounds {
    const all: number[] = []
    let subunitSize = Infinity
    for (const it of this.items) {
      const s = it.local.spheres, m = it.place
      subunitSize = Math.min(subunitSize, it.local.subunitSize)
      for (let k = 0; k < s.length; k += 4) {
        all.push(
          m[0]! * s[k]! + m[4]! * s[k + 1]! + m[8]! * s[k + 2]! + m[12]!,
          m[1]! * s[k]! + m[5]! * s[k + 1]! + m[9]! * s[k + 2]! + m[13]!,
          m[2]! * s[k]! + m[6]! * s[k + 1]! + m[10]! * s[k + 2]! + m[14]!,
          s[k + 3]!,
        )
      }
    }
    if (all.length === 0) return { center: [0, 0, 0], radius: 1, spheres: new Float32Array(0), subunitSize: 30 }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < all.length; k += 4)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, all[k + a]! - all[k + 3]!)
        hi[a] = Math.max(hi[a]!, all[k + a]! + all[k + 3]!)
      }
    const center: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
    let radius = 0
    for (let k = 0; k < all.length; k += 4) radius = Math.max(radius, Math.hypot(all[k]! - center[0], all[k + 1]! - center[1], all[k + 2]! - center[2]) + all[k + 3]!)
    return { center, radius, spheres: new Float32Array(all), subunitSize }
  }

  setColors(item: number, color: Uint8Array): void {
    const it = this.items[item]
    if (!it) return
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, it.color)
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, color)
  }

  private ensureTarget(w: number, h: number): Target {
    const gl = this.gl
    const t = this.target
    if (t && t.w === w && t.h === h) return t
    if (t) {
      for (const tex of [t.color, t.ids, t.depth, t.edge, t.out]) gl.deleteTexture(tex)
      for (const f of [t.gbuf, t.edgeFbo, t.outFbo]) gl.deleteFramebuffer(f)
    }
    const tex = (internal: number) => {
      const x = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, x)
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return x
    }
    const fbo = (attach: [number, WebGLTexture][]) => {
      const f = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, f)
      for (const [a, x] of attach) gl.framebufferTexture2D(gl.FRAMEBUFFER, a, gl.TEXTURE_2D, x, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`无法创建 ${w}×${h} 的渲染目标`)
      return f
    }
    const color = tex(gl.RGBA8), ids = tex(gl.RGBA32UI), depth = tex(gl.DEPTH_COMPONENT32F), edge = tex(gl.RGBA8), out = tex(gl.RGBA8)
    const gbuf = fbo([[gl.COLOR_ATTACHMENT0, color], [gl.COLOR_ATTACHMENT1, ids], [gl.DEPTH_ATTACHMENT, depth]])
    const edgeFbo = fbo([[gl.COLOR_ATTACHMENT0, edge]])
    const outFbo = fbo([[gl.COLOR_ATTACHMENT0, out]])
    this.target = { w, h, gbuf, color, ids, depth, edgeFbo, edge, outFbo, out }
    return this.target
  }

  /** Largest supersampling factor (2 or 1) whose buffers fit this output size. */
  supersample(w: number, h: number): number {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number
    return w * 2 <= Math.min(max, 8192) && h * 2 <= Math.min(max, 8192) && w * h * 4 <= 40_000_000 ? 2 : 1
  }

  /** Render at w×h internal pixels into the composite buffer. */
  private renderInternal(view: View, style: Style, w: number, h: number, fast: boolean): Target {
    const gl = this.gl
    const t = this.ensureTarget(w, h)
    const b = this.bounds
    const pxPerA = h / view.height

    // View-space z of the scene's bounding sphere gives the depth range.
    const dx = b.center[0] - view.center[0], dy = b.center[1] - view.center[1], dz = b.center[2] - view.center[2]
    const zc = view.rot[2]! * dx + view.rot[5]! * dy + view.rot[8]! * dz
    const zFront = Math.min(zc + b.radius + 3, Number.isFinite(view.clipFront) ? view.clipFront + 3 : Infinity)
    const zBack = zc - b.radius - 3

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.gbuf)
    gl.viewport(0, 0, w, h)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    gl.disable(gl.BLEND)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.depthMask(true)
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
    gl.clearBufferuiv(gl.COLOR, 1, new Uint32Array(4))
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0)

    const p = this.sphere
    gl.useProgram(p)
    gl.uniformMatrix3fv(this.u(p, 'u_rot'), false, view.rot)
    gl.uniform3fv(this.u(p, 'u_center'), view.center)
    gl.uniform2f(this.u(p, 'u_toClip'), (2 * pxPerA) / w, (2 * pxPerA) / h)
    gl.uniform2f(this.u(p, 'u_z'), zFront, zBack)
    gl.uniform1f(this.u(p, 'u_clipFront'), Number.isFinite(view.clipFront) ? view.clipFront : 1e30)
    gl.uniform1f(this.u(p, 'u_radiusScale'), style.radiusScale)
    gl.uniform1i(this.u(p, 'u_outlineByMolecule'), style.outlineBy === 'molecule' ? 1 : 0)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    let atoms = 0
    const layers = style.fog.layers
    const span = view.fogSpan ?? [Math.min(zc + b.radius, zFront), zc - b.radius]
    const r = view.rot, vc = view.center
    gl.uniform1f(this.u(p, 'u_keep'), 1)
    for (const it of this.items) {
      gl.uniformMatrix4fv(this.u(p, 'u_place'), false, it.place)
      for (const d of it.draws) {
        if (d.count <= 0) continue
        gl.bindBuffer(gl.ARRAY_BUFFER, it.posr)
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, d.start * 16)
        gl.bindBuffer(gl.ARRAY_BUFFER, it.color)
        gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 4, d.start * 4)
        gl.bindBuffer(gl.ARRAY_BUFFER, it.ids)
        gl.vertexAttribIPointer(3, 2, gl.UNSIGNED_INT, 8, d.start * 8)
        gl.uniformMatrix4fv(this.u(p, 'u_model'), false, d.matrix)
        gl.uniform1ui(this.u(p, 'u_subunitBase'), d.subunitBase)
        gl.uniform1ui(this.u(p, 'u_molecule'), d.molecule)
        if (layers > 0 && d.center) {
          // the whole molecule takes the tone of the layer its centre is in
          const z = r[2]! * (d.center[0] - vc[0]) + r[5]! * (d.center[1] - vc[1]) + r[8]! * (d.center[2] - vc[2])
          const t = Math.min(0.999, Math.max(0, (span[0] - z) / Math.max(span[0] - span[1], 1e-3)))
          const step = layers === 1 ? 0 : Math.floor(t * layers) / (layers - 1)
          gl.uniform1f(this.u(p, 'u_keep'), style.fog.front + (style.fog.back - style.fog.front) * step)
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.count)
        atoms += d.count
      }
    }
    this.lastAtoms = atoms

    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(this.quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    const bind = (prog: WebGLProgram, unit: number, name: string, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(this.u(prog, name), unit)
    }

    // The pen is Illustrate's one-pixel kernel step on a 1500 px image.
    const pen = Math.max(1, (Math.max(w, h) / 1500) * style.lineWidth)
    // Illustrate's shadow reaches 50 px at 12 px/Å. Larger subjects are drawn
    // at smaller scales, so by default the reach follows the view instead.
    const reach = style.shadow.radius > 0 ? style.shadow.radius : Math.max(50 / 12, view.height * 0.045)
    // A depth step only reads as an edge if it is large next to one pen width;
    // at virus scale this leaves the silhouette and the big relief.
    const diffMax = Math.max(style.contour.diffMax, (24 * pen) / pxPerA)
    // Lines between chains need room: they fade out as a chain shrinks from
    // 40 to 12 pen widths across, which is what Goodsell does by hand.
    const subunitPens = (b.subunitSize * pxPerA) / pen
    // (lines between whole molecules, in a landscape, never fade)
    const subunitFade = style.outlineBy === 'molecule' ? 1 : Math.min(1, Math.max(0, (subunitPens - 12) / 28))

    const e = this.edgeProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.edgeFbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0])
    gl.useProgram(e)
    bind(e, 0, 'u_depth', t.depth)
    bind(e, 1, 'u_ids', t.ids)
    gl.uniform2f(this.u(e, 'u_z'), zFront, zBack)
    gl.uniform1f(this.u(e, 'u_pen'), pen)
    gl.uniform1f(this.u(e, 'u_pxPerA'), pxPerA)
    gl.uniform4f(this.u(e, 'u_contour'), style.contour.low, style.contour.high, style.contour.diffMin, diffMax)
    gl.uniform3f(this.u(e, 'u_subunit'), style.subunit.low, style.subunit.high, subunitFade)
    gl.uniform3f(this.u(e, 'u_residue'), style.residue.low, style.residue.high, style.residue.diff)
    gl.uniform4f(this.u(e, 'u_shadow'), style.shadow.strength, style.shadow.cone, style.shadow.floor, reach)
    gl.uniform1i(this.u(e, 'u_shadowN'), fast ? 5 : 10)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    const c = this.compProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.outFbo)
    gl.useProgram(c)
    bind(c, 0, 'u_color', t.color)
    bind(c, 1, 'u_edge', t.edge)
    bind(c, 2, 'u_depth', t.depth)
    gl.uniform2f(this.u(c, 'u_z'), zFront, zBack)
    if (view.fogSpan) gl.uniform2f(this.u(c, 'u_zSpan'), view.fogSpan[0], view.fogSpan[1])
    else gl.uniform2f(this.u(c, 'u_zSpan'), Math.min(zc + b.radius, zFront), zc - b.radius)
    gl.uniform3fv(this.u(c, 'u_bg'), style.background)
    gl.uniform3fv(this.u(c, 'u_fog'), style.fog.color)
    gl.uniform2f(this.u(c, 'u_fogAmt'), style.fog.front, style.fog.back)
    gl.uniform3fv(this.u(c, 'u_ink'), style.ink)
    gl.uniform1f(this.u(c, 'u_grain'), style.grain)
    gl.uniform1i(this.u(c, 'u_layered'), layers > 0 ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    return t
  }

  /** Draw to the canvas at its current pixel size. */
  render(view: View, style: Style, fast = false): void {
    const gl = this.gl
    const cw = this.canvas.width, ch = this.canvas.height
    if (cw === 0 || ch === 0) return
    const ss = fast ? 1 : this.supersample(cw, ch)
    const t = this.renderInternal(view, style, cw * ss, ch * ss, fast)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.outFbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.LINEAR)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Render off-screen at w×h and return top-down RGBA pixels. */
  renderPixels(view: View, style: Style, w: number, h: number): Uint8ClampedArray {
    const gl = this.gl
    const ss = this.supersample(w, h)
    const t = this.renderInternal(view, style, w * ss, h * ss, false)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.outFbo)
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(tex)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    return out
  }
}

/** Bounding sphere of everything drawn, from each run's box under its matrix. */
export function sceneBounds(items: RenderItem[]): Bounds {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const it of items) {
    const boxes = new Map<string, number[]>()
    for (const d of it.draws) {
      const key = d.start + ':' + d.count
      let box = boxes.get(key)
      if (!box) {
        box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
        for (let i = d.start; i < d.start + d.count; i++) {
          const r = it.posr[i * 4 + 3]!
          for (let k = 0; k < 3; k++) {
            const v = it.posr[i * 4 + k]!
            if (v - r < box[k]!) box[k] = v - r
            if (v + r > box[k + 3]!) box[k + 3] = v + r
          }
        }
        boxes.set(key, box)
      }
      const m = d.matrix
      for (let c = 0; c < 8; c++) {
        const x = box[c & 1 ? 3 : 0]!, y = box[c & 2 ? 4 : 1]!, z = box[c & 4 ? 5 : 2]!
        for (let k = 0; k < 3; k++) {
          const v = m[k]! * x + m[4 + k]! * y + m[8 + k]! * z + m[12 + k]!
          if (v < lo[k]!) lo[k] = v
          if (v > hi[k]!) hi[k] = v
        }
      }
    }
  }
  if (!Number.isFinite(lo[0]!)) return { center: [0, 0, 0], radius: 1, spheres: new Float32Array(0), subunitSize: 30 }
  const center: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]

  let radius = 0
  const placed: number[] = []
  for (const it of items) {
    // Atoms that follow each other in a chain are near each other, so
    // spheres around short stretches hug the shape closely.
    const CHUNK = 64
    const chunks = new Map<string, number[]>()
    for (const d of it.draws) {
      const key = d.start + ':' + d.count
      let s = chunks.get(key)
      if (!s) {
        s = []
        // Split any stretch whose sphere is loose: small molecules listed one
        // after another in the file can be far apart.
        const stack: [number, number][] = []
        for (let a = d.start; a < d.start + d.count; a += CHUNK) stack.push([a, Math.min(a + CHUNK, d.start + d.count)])
        while (stack.length) {
          const [a, end] = stack.pop()!
          let cx = 0, cy = 0, cz = 0
          for (let i = a; i < end; i++) {
            cx += it.posr[i * 4]!
            cy += it.posr[i * 4 + 1]!
            cz += it.posr[i * 4 + 2]!
          }
          cx /= end - a
          cy /= end - a
          cz /= end - a
          let r = 0
          for (let i = a; i < end; i++) {
            r = Math.max(r, Math.hypot(it.posr[i * 4]! - cx, it.posr[i * 4 + 1]! - cy, it.posr[i * 4 + 2]! - cz) + it.posr[i * 4 + 3]!)
          }
          if (r > 8 && end - a > 4) {
            const mid = (a + end) >> 1
            stack.push([a, mid], [mid, end])
          } else s.push(cx, cy, cz, r)
        }
        chunks.set(key, s)
      }
      const m = d.matrix
      for (let k = 0; k < s.length; k += 4) {
        const x = m[0]! * s[k]! + m[4]! * s[k + 1]! + m[8]! * s[k + 2]! + m[12]!
        const y = m[1]! * s[k]! + m[5]! * s[k + 1]! + m[9]! * s[k + 2]! + m[13]!
        const z = m[2]! * s[k]! + m[6]! * s[k + 1]! + m[10]! * s[k + 2]! + m[14]!
        radius = Math.max(radius, Math.hypot(x - center[0], y - center[1], z - center[2]) + s[k + 3]!)
        placed.push(x, y, z, s[k + 3]!)
      }
    }
  }
  const subunitSize = Math.min(...items.map((it) => it.subunitSize))
  return { center, radius, spheres: new Float32Array(placed), subunitSize }
}
