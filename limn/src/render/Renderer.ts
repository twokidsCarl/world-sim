import { CAPSULE_FS, CAPSULE_VS, COMPOSITE_FS, EDGE_FS, MESH_FS, MESH_VS, QUAD_VS, SMOOTH_FS, SPHERE_FS, SPHERE_VS } from './shaders'
import type { Style } from './style'
// 这个文件里 `t` 另有所指，所以换个名字 / `t` means something else in this file, hence the other name
import { t as tr } from '../i18n'

/**
 * 一段连续的原子，由实例表里连续的若干个实例各画一次。
 * One contiguous run of atoms, drawn once by each of a contiguous range of instances.
 */
export interface Draw {
  start: number
  count: number
  /** 实例表中的起始下标和个数 / first instance and how many */
  opStart: number
  opCount: number
}

/**
 * 实例表：每个实例是一个刚体变换，外加它所属分子的信息。
 * The instance table: one rigid transform per instance, plus what molecule it belongs to.
 */
export interface Instances {
  count: number
  /**
   * 每个实例 16 个数：3×4 矩阵的三行，然后是分子中心的世界坐标 xyz 和一个标志（1 = 有中心）。
   * 有中心的实例整体归入一个景深层，并在截面处整体保留或丢弃。
   * 16 floats each: the three rows of a 3x4 matrix, then the molecule's centre (xyz) and a
   * flag (1 = centre known). An instance with a centre takes one depth layer as a whole and
   * is kept or dropped whole at a cut.
   */
  data: Float32Array
  /**
   * 每个实例 2 个整数：加到链编号上的偏移（让每个拷贝单独描边）、分子编号。
   * 2 ints each: the offset added to chain indices (so every copy outlines separately), molecule id.
   */
  ids: Uint32Array
}

/** 单位变换的单个实例 / A single identity instance. */
export function identityInstances(molecule = 0): Instances {
  return { count: 1, data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]), ids: new Uint32Array([0, molecule]) }
}

/**
 * 共用一组 GPU 数据的原子，被画一次或多次。
 * Atoms sharing one set of GPU data, drawn one or more times.
 */
export interface RenderItem {
  /** 每个原子的 x、y、z、半径 / x, y, z, radius per atom */
  posr: Float32Array
  /** 每个原子一个 RGBA8 / RGBA8 per atom */
  color: Uint8Array
  /** 每个原子的链编号、残基编号（加了偏移以保证非负） / chain index, residue number (offset to be non-negative) per atom */
  ids: Uint32Array
  draws: Draw[]
  instances: Instances
  /**
   * 一条链的典型直径（Å）；它在屏幕上变小时，链间的线会淡出
   * typical diameter of one chain in Å; lines between chains fade when this gets small on screen
   */
  subunitSize: number
  /**
   * 胶囊：每段两个原子下标，把这两个球连成一段圆台（神经元的分支）。只按第一个实例画。
   * Capsules: two atom indices per segment, joining those two spheres into a round cone (the
   * branches of a neuron). Drawn for the first instance only.
   */
  segments?: Uint32Array
  /** 陪衬（示意的环境）：拖动时的快速绘制里不画，松手后才画 / decoration (a schematic environment): left out of the quick drawing while dragging, drawn once it settles */
  decor?: boolean
  /**
   * 三角网格：每个三角形三个原子下标，顶点就是这些原子的位置（密度图和细胞器的表面）。
   * 有网格时这一项的球不画，只用来取景和上色。只按第一个实例画。
   * A triangle mesh: three atom indices per triangle, the vertices being those atoms' positions
   * (the surface of a density map or an organelle). With a mesh the item's spheres are not drawn
   * and serve only for framing and colour. Drawn for the first instance only.
   */
  triangles?: Uint32Array
  /** 网格围着的是实心的东西：剖开时切口画成平的断面 / the mesh encloses something solid: a cut through it is drawn as a flat section */
  solid?: boolean
}

export interface View {
  /** 列主序 3x3，世界到视图；+z 指向观察者 / column-major 3x3, world to view; +z points at the viewer */
  rot: Float32Array
  center: [number, number, number]
  /** 图像高度所跨的 Å 数 / Å spanned by the image height */
  height: number
  /** 视图空间 z 比这更靠前的原子被丢弃；Infinity = 不截 / atoms nearer than this view-space z are dropped; Infinity = no cut */
  clipFront: number
  /**
   * 切片的背面：视图空间 z 比这更靠后的丢弃。缺省不设（画到最远处）。
   * Goodsell 的画都是一片切片：切面这一层和后面一两层，从不画整个物体的后半个内壁。
   * The back of the slab: what lies farther back than this view-space z is dropped. Absent by
   * default (everything is drawn, to the far end). Goodsell's paintings are all slabs: the cut
   * layer and a layer or two behind it, never the far inner wall of the whole object.
   */
  clipBack?: number
  /**
   * 景深淡出开始和结束处的视图空间 z；默认取场景的包围球
   * view-space z where depth fading starts and ends; default: the scene's bounding sphere
   */
  fogSpan?: [number, number]
  /** 画面内容在视线方向上的半厚度（Å），由取景算出 / half the subject's extent along the view direction in Å, set by framing */
  halfDepth?: number
}

export interface Bounds {
  center: [number, number, number]
  radius: number
  /** 每段已放置原子的 x、y、z、r，用于给特定视角取景 / x, y, z, r of every placed run, for framing a particular view */
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
  /** 平滑之后的一套缓冲；不平滑时不用 / the buffers after smoothing; unused without it */
  gbuf2: WebGLFramebuffer
  color2: WebGLTexture
  ids2: WebGLTexture
  depth2: WebGLTexture
  edgeFbo: WebGLFramebuffer
  edge: WebGLTexture
  outFbo: WebGLFramebuffer
  out: WebGLTexture
}

interface GpuItem {
  posr: WebGLTexture
  color: WebGLTexture
  ids: WebGLTexture
  inst: WebGLTexture
  instIds: WebGLTexture
  draws: Draw[]
  atoms: number
  /** 该项自身的包围范围，未经摆放 / this item's own bounds, before its placement */
  local: Bounds
  /** 列主序 4x4，在绘制矩阵之后施加 / column-major 4x4 applied after the draw matrices */
  place: Float32Array
  seg: WebGLTexture | null
  decor: boolean
  segCount: number
  tri: WebGLBuffer | null
  triCount: number
  solid: boolean
}

const IDENTITY4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

export class Renderer {
  readonly gl: WebGL2RenderingContext
  private sphere: WebGLProgram
  private capsule: WebGLProgram
  private mesh: WebGLProgram
  private smoothProg: WebGLProgram
  private meshVao: WebGLVertexArrayObject
  /** 上一帧画出的线段数和三角形数 / segments and triangles drawn in the last frame */
  lastSegments = 0
  lastTriangles = 0
  private edgeProg: WebGLProgram
  private compProg: WebGLProgram
  private quad: WebGLBuffer
  private vao: WebGLVertexArrayObject
  private quadVao: WebGLVertexArrayObject
  private items: GpuItem[] = []
  private target: Target | null = null
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  bounds: Bounds = { center: [0, 0, 0], radius: 1, spheres: new Float32Array(0), subunitSize: 30 }
  /** 上一帧画出的实例化球数 / instanced spheres drawn in the last frame */
  lastAtoms = 0
  /** 数据纹理的宽度 / width of the data textures */
  private texW = 4096

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null
    if (!gl) throw new Error(tr('error.webgl2'))
    this.gl = gl
    this.sphere = this.program(SPHERE_VS, SPHERE_FS)
    this.capsule = this.program(CAPSULE_VS, CAPSULE_FS)
    this.mesh = this.program(MESH_VS, MESH_FS)
    this.smoothProg = this.program(QUAD_VS, SMOOTH_FS)
    this.meshVao = gl.createVertexArray()!
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
    gl.bindVertexArray(null)
    this.texW = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)
    // 空舞台是白纸，不是黑洞 / an empty stage is paper, not a black hole
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
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(tr('error.shaderCompile', { log: gl.getShaderInfoLog(s) ?? '' }))
      gl.attachShader(p, s)
    }
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(tr('error.shaderLink', { log: gl.getProgramInfoLog(p) ?? '' }))
    this.uniforms.set(p, new Map())
    return p
  }

  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const m = this.uniforms.get(p)!
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name))
    return m.get(name)!
  }

  /**
   * 把一维数组放进宽度固定的二维纹理（不足一行的补零）。
   * Store a flat array in a fixed-width 2D texture, padding the last row.
   */
  private dataTexture(internal: number, format: number, type: number, data: Float32Array | Uint8Array | Uint32Array, perTexel: number): WebGLTexture {
    const gl = this.gl
    const w = this.texW
    const h = Math.max(1, Math.ceil(data.length / perTexel / w))
    let full = data
    if (data.length !== w * h * perTexel) {
      full = new (data.constructor as new (n: number) => Float32Array | Uint8Array | Uint32Array)(w * h * perTexel)
      full.set(data)
    }
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, full)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private indexBuffer(indices: Uint32Array): WebGLBuffer {
    const gl = this.gl
    const b = gl.createBuffer()!
    gl.bindVertexArray(this.meshVao)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    return b
  }

  setScene(items: RenderItem[]): void {
    const gl = this.gl
    for (const it of this.items) {
      for (const t of [it.posr, it.color, it.ids, it.inst, it.instIds, it.seg]) if (t) gl.deleteTexture(t)
      if (it.tri) gl.deleteBuffer(it.tri)
    }
    this.items = items.map((it) => {
      // 原子和实例各有两张纹理：浮点数据一张，整数编号一张（RG 两个分量）
      // atoms and instances each get two textures: one of floats, one of integer ids (two channels, RG)
      return {
        posr: this.dataTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT, it.posr, 4),
        color: this.dataTexture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, it.color, 4),
        ids: this.dataTexture(gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, it.ids, 2),
        inst: this.dataTexture(gl.RGBA32F, gl.RGBA, gl.FLOAT, it.instances.data, 4),
        instIds: this.dataTexture(gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, it.instances.ids, 2),
        draws: it.draws,
        atoms: it.posr.length / 4,
        local: sceneBounds([it]),
        place: IDENTITY4,
        seg: it.segments?.length ? this.dataTexture(gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT, it.segments, 2) : null,
        segCount: (it.segments?.length ?? 0) / 2,
        tri: it.triangles?.length ? this.indexBuffer(it.triangles) : null,
        triCount: it.triangles?.length ?? 0,
        solid: !!it.solid,
        decor: !!it.decor,
      }
    })
    this.bounds = this.placedBounds()
  }

  /** 第 `i` 项自身的包围范围，不考虑它被放在哪里 / Bounds of item `i` on its own, ignoring where it is placed. */
  localBounds(i: number): Bounds | undefined {
    return this.items[i]?.local
  }

  /** 整体刚性移动各项（每项一个矩阵），不重新上传原子 / Move whole items rigidly (one matrix per item) without re-uploading atoms. */
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
    if (!it || color.length !== it.atoms * 4) return
    const gl = this.gl
    const w = this.texW
    const rows = Math.floor(it.atoms / w)
    gl.bindTexture(gl.TEXTURE_2D, it.color)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (rows > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, color.subarray(0, rows * w * 4))
    const rest = it.atoms - rows * w
    if (rest > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rows, rest, 1, gl.RGBA, gl.UNSIGNED_BYTE, color.subarray(rows * w * 4))
  }

  private ensureTarget(w: number, h: number): Target {
    const gl = this.gl
    const t = this.target
    if (t && t.w === w && t.h === h) return t
    if (t) {
      for (const tex of [t.color, t.ids, t.depth, t.color2, t.ids2, t.depth2, t.edge, t.out]) gl.deleteTexture(tex)
      for (const f of [t.gbuf, t.gbuf2, t.edgeFbo, t.outFbo]) gl.deleteFramebuffer(f)
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
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error(tr('error.renderTarget', { w, h }))
      return f
    }
    const color = tex(gl.RGBA8), ids = tex(gl.RGBA32UI), depth = tex(gl.DEPTH_COMPONENT32F), edge = tex(gl.RGBA8), out = tex(gl.RGBA8)
    const gbuf = fbo([[gl.COLOR_ATTACHMENT0, color], [gl.COLOR_ATTACHMENT1, ids], [gl.DEPTH_ATTACHMENT, depth]])
    const color2 = tex(gl.RGBA8), ids2 = tex(gl.RGBA32UI), depth2 = tex(gl.DEPTH_COMPONENT32F)
    const gbuf2 = fbo([[gl.COLOR_ATTACHMENT0, color2], [gl.COLOR_ATTACHMENT1, ids2], [gl.DEPTH_ATTACHMENT, depth2]])
    const edgeFbo = fbo([[gl.COLOR_ATTACHMENT0, edge]])
    const outFbo = fbo([[gl.COLOR_ATTACHMENT0, out]])
    this.target = { w, h, gbuf, color, ids, depth, gbuf2, color2, ids2, depth2, edgeFbo, edge, outFbo, out }
    return this.target
  }

  /** 缓冲区能容纳该输出尺寸的最大超采样倍数（2 或 1） / Largest supersampling factor (2 or 1) whose buffers fit this output size. */
  supersample(w: number, h: number): number {
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number
    return w * 2 <= Math.min(max, 8192) && h * 2 <= Math.min(max, 8192) && w * h * 4 <= 40_000_000 ? 2 : 1
  }

  /** 以 w×h 的内部像素渲染到合成缓冲 / Render at w×h internal pixels into the composite buffer. */
  private renderInternal(view: View, style: Style, w: number, h: number, fast: boolean): Target {
    const gl = this.gl
    const t = this.ensureTarget(w, h)
    const b = this.bounds
    const pxPerA = h / view.height

    // 场景包围球在视图空间的 z 给出深度范围。
    // View-space z of the scene's bounding sphere gives the depth range.
    const dx = b.center[0] - view.center[0], dy = b.center[1] - view.center[1], dz = b.center[2] - view.center[2]
    const zc = view.rot[2]! * dx + view.rot[5]! * dy + view.rot[8]! * dz
    // 平滑的探针半径：在画面上是固定的几个像素，所以离得越远抹得越多；换成 Å 后设个上限
    // the probe radius for smoothing: a fixed few pixels on screen, so the farther away the more is wiped; capped once converted to Å
    const probe = (style.smooth ?? 0) > 0 ? Math.min(style.smoothMax ?? 14, ((style.smooth ?? 0) * Math.max(1, Math.max(w, h) / 1500)) / pxPerA) : 0
    const zFront = Math.min(zc + b.radius + 3 + probe, Number.isFinite(view.clipFront) ? view.clipFront + 3 + probe : Infinity)
    const zBack = zc - b.radius - 3 - probe

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

    const layers = style.fog.layers
    const span = view.fogSpan ?? [Math.min(zc + b.radius, zFront), zc - b.radius]
    const names = ['u_posr', 'u_color', 'u_ids', 'u_inst', 'u_instIds']
    // 三种图元共用的取景参数 / the framing shared by the three kinds of primitive
    const common = (p: WebGLProgram) => {
      gl.useProgram(p)
      gl.uniformMatrix3fv(this.u(p, 'u_rot'), false, view.rot)
      gl.uniform3fv(this.u(p, 'u_center'), view.center)
      gl.uniform2f(this.u(p, 'u_toClip'), (2 * pxPerA) / w, (2 * pxPerA) / h)
      gl.uniform2f(this.u(p, 'u_z'), zFront, zBack)
      gl.uniform1f(this.u(p, 'u_clipFront'), Number.isFinite(view.clipFront) ? view.clipFront : 1e30)
      gl.uniform1f(this.u(p, 'u_clipBack'), view.clipBack ?? -1e30)
      gl.uniform1f(this.u(p, 'u_radiusScale'), style.radiusScale)
      gl.uniform1f(this.u(p, 'u_minRadius'), (style.minRadius * Math.max(1, (Math.max(w, h) / 1500) * style.lineWidth)) / pxPerA)
      gl.uniform1f(this.u(p, 'u_inflate'), probe)
      gl.uniform1i(this.u(p, 'u_outlineByMolecule'), style.outlineBy === 'molecule' ? 1 : 0)
      gl.uniform1i(this.u(p, 'u_w'), this.texW)
      names.forEach((n, i) => gl.uniform1i(this.u(p, n), i))
    }
    const bindItem = (p: WebGLProgram, it: GpuItem) => {
      ;[it.posr, it.color, it.ids, it.inst, it.instIds].forEach((t, i) => {
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(gl.TEXTURE_2D, t)
      })
      gl.uniformMatrix4fv(this.u(p, 'u_place'), false, it.place)
    }

    const p = this.sphere
    common(p)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    let atoms = 0
    gl.uniform3f(this.u(p, 'u_layer'), layers, span[0], span[1])
    gl.uniform2f(this.u(p, 'u_fogKeep'), style.fog.front, style.fog.back)
    for (const it of this.items) {
      // 有网格的项，球只用来取景 / an item with a mesh keeps its spheres for framing only
      if (it.tri) continue
      // 拖动时陪衬不画：几百万个环境里的球会把拖动拖慢，而且转来转去它看上去都一样，挡住了对象本身的转动
      // decoration is skipped while dragging: millions of environment spheres slow the drag, and since it looks the same from every side it hides the subject's own turning
      if (!drawnNow(it, fast)) continue
      bindItem(p, it)
      for (const d of it.draws) {
        if (d.count <= 0 || d.opCount <= 0) continue
        // 一次绘制的实例数上限是 2^31；超过就按实例分批
        // one call can draw at most 2^31 instances; split by instance beyond that
        const per = Math.max(1, Math.floor(2_000_000_000 / d.count))
        for (let o = 0; o < d.opCount; o += per) {
          const n = Math.min(per, d.opCount - o)
          gl.uniform3i(this.u(p, 'u_run'), d.start, d.count, d.opStart + o)
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.count * n)
          atoms += d.count * n
        }
      }
    }

    let segments = 0
    if (this.items.some((it) => it.seg)) {
      const c = this.capsule
      common(c)
      // 线（核酸、长链）的切片深一倍半，和成节的纤维一样：线是长长的一股，从前面的分子后面穿过去，不被切成一小段一小段
      // lines (nucleic acid, long chains) get a slab two and a half times as deep, as pieced fibres do: a strand runs long and passes behind the molecules in front and is not cut into short pieces
      if (view.clipBack !== undefined && Number.isFinite(view.clipFront)) gl.uniform1f(this.u(c, 'u_clipBack'), view.clipBack - (view.clipFront - view.clipBack) * 1.5)
      gl.uniform1i(this.u(c, 'u_seg'), 5)
      gl.uniform3f(this.u(c, 'u_layer'), layers, span[0], span[1])
      gl.uniform2f(this.u(c, 'u_fogKeep'), style.fog.front, style.fog.back)
      for (const it of this.items) {
        if (!it.seg || !drawnNow(it, fast)) continue
        bindItem(c, it)
        gl.activeTexture(gl.TEXTURE5)
        gl.bindTexture(gl.TEXTURE_2D, it.seg)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, it.segCount)
        segments += it.segCount
      }
    }
    this.lastSegments = segments

    let triangles = 0
    if (this.items.some((it) => it.tri)) {
      const m = this.mesh
      common(m)
      gl.bindVertexArray(this.meshVao)
      for (const it of this.items) {
        if (!it.tri) continue
        bindItem(m, it)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, it.tri)
        gl.uniform1i(this.u(m, 'u_solid'), it.solid ? 1 : 0)
        gl.drawElements(gl.TRIANGLES, it.triCount, gl.UNSIGNED_INT, 0)
        triangles += it.triCount / 3
      }
    }
    this.lastTriangles = triangles
    this.lastAtoms = atoms

    gl.disable(gl.DEPTH_TEST)
    gl.bindVertexArray(this.quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    const bind = (prog: WebGLProgram, unit: number, name: string, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(this.u(prog, name), unit)
    }

    // 笔宽取 Illustrate 在 1500 px 图像上一个像素的卷积核步长。
    // The pen is Illustrate's one-pixel kernel step on a 1500 px image.
    const pen = Math.max(1, (Math.max(w, h) / 1500) * style.lineWidth)
    // Illustrate 的阴影在 12 px/Å 时延伸 50 px。更大的对象以更小的比例绘制，
    // 所以默认让延伸范围跟随视图。
    // Illustrate's shadow reaches 50 px at 12 px/Å. Larger subjects are drawn
    // at smaller scales, so by default the reach follows the view instead.
    const reach = style.shadow.radius > 0 ? style.shadow.radius : Math.max(50 / 12, view.height * 0.045)
    // 深度台阶要比一个笔宽大得多才读得出是一条边；
    // 在病毒尺度下，这样只留下外轮廓和大的起伏。
    // A depth step only reads as an edge if it is large next to one pen width;
    // at virus scale this leaves the silhouette and the big relief.
    const diffMax = Math.max(style.contour.diffMax, (24 * pen) / pxPerA)
    // 链间的线需要空间：链的宽度从 40 个笔宽缩到 12 个笔宽时线逐渐淡出，
    // Goodsell 手绘时就是这么做的。
    // Lines between chains need room: they fade out as a chain shrinks from
    // 40 to 12 pen widths across, which is what Goodsell does by hand.
    const subunitPens = (b.subunitSize * pxPerA) / pen
    // （全景里整个分子之间的线从不淡出）
    // (lines between whole molecules, in a landscape, never fade)
    const subunitFade = style.outlineBy === 'molecule' ? 1 : Math.min(1, Math.max(0, (subunitPens - 12) / 28))

    // 平滑：把第一套缓冲腐蚀进第二套，后面的描边和合成读第二套
    // smoothing: the first set of buffers is eroded into the second, which the edge and composite passes then read
    let G = { color: t.color, ids: t.ids, depth: t.depth }
    if (probe > 0) {
      const sm = this.smoothProg
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.gbuf2)
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.ALWAYS)
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
      gl.clearBufferuiv(gl.COLOR, 1, new Uint32Array(4))
      gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0)
      gl.useProgram(sm)
      bind(sm, 0, 'u_depth', t.depth)
      bind(sm, 1, 'u_color', t.color)
      bind(sm, 2, 'u_ids', t.ids)
      gl.uniform2f(this.u(sm, 'u_z'), zFront, zBack)
      gl.uniform1f(this.u(sm, 'u_probe'), probe)
      gl.uniform1f(this.u(sm, 'u_pxPerA'), pxPerA)
      gl.uniform1i(this.u(sm, 'u_rings'), fast ? 2 : 6)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      gl.depthFunc(gl.LESS)
      gl.disable(gl.DEPTH_TEST)
      G = { color: t.color2, ids: t.ids2, depth: t.depth2 }
    }

    const e = this.edgeProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.edgeFbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0])
    gl.useProgram(e)
    bind(e, 0, 'u_depth', G.depth)
    bind(e, 1, 'u_ids', G.ids)
    gl.uniform2f(this.u(e, 'u_z'), zFront, zBack)
    gl.uniform1f(this.u(e, 'u_pen'), pen)
    gl.uniform1f(this.u(e, 'u_pxPerA'), pxPerA)
    gl.uniform4f(this.u(e, 'u_contour'), style.contour.low, style.contour.high, style.contour.diffMin, diffMax)
    gl.uniform3f(this.u(e, 'u_subunit'), style.subunit.low, style.subunit.high, subunitFade)
    gl.uniform3f(this.u(e, 'u_residue'), style.residue.low, style.residue.high, style.residue.diff)
    gl.uniform4f(this.u(e, 'u_shadow'), style.shadow.strength, style.shadow.cone, style.shadow.floor, reach)
    gl.uniform1i(this.u(e, 'u_shadowN'), fast ? 5 : 10)
    const capped = this.items.some((it) => it.tri && it.solid) && Number.isFinite(view.clipFront)
    gl.uniform2f(this.u(e, 'u_cap'), capped ? 1 : 0, capped ? view.clipFront : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    const c = this.compProg
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.outFbo)
    gl.useProgram(c)
    bind(c, 0, 'u_color', G.color)
    bind(c, 1, 'u_edge', t.edge)
    bind(c, 2, 'u_depth', G.depth)
    bind(c, 3, 'u_ids', G.ids)
    gl.uniform2f(this.u(c, 'u_cap'), capped ? 1 : 0, capped ? view.clipFront : 0)
    gl.uniform2f(this.u(c, 'u_z'), zFront, zBack)
    if (view.fogSpan) gl.uniform2f(this.u(c, 'u_zSpan'), view.fogSpan[0], view.fogSpan[1])
    else gl.uniform2f(this.u(c, 'u_zSpan'), Math.min(zc + b.radius, zFront), zc - b.radius)
    gl.uniform3fv(this.u(c, 'u_bg'), style.background)
    gl.uniform3fv(this.u(c, 'u_fog'), style.fog.color)
    gl.uniform2f(this.u(c, 'u_fogAmt'), style.fog.front, style.fog.back)
    gl.uniform3fv(this.u(c, 'u_ink'), style.ink)
    gl.uniform1f(this.u(c, 'u_grain'), style.grain)
    gl.uniform1i(this.u(c, 'u_layered'), layers > 0 ? 1 : 0)
    gl.uniform3f(this.u(c, 'u_inkTint'), style.inkTint ?? 0, style.inkShade ?? 0.35, pen)
    gl.uniform1f(this.u(c, 'u_fogShade'), style.fog.shade ?? 0)
    // 膜厚约 40 Å；带子比 62 Å 宽的地方不算侧面 / a membrane is about 40 Å thick; a band wider than 62 Å is not counted as edge-on
    gl.uniform3f(this.u(c, 'u_mid'), style.membraneMidline ?? 0, 62 * pxPerA, Math.max(6, 22 * pxPerA))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
    return t
  }

  /** 按画布当前的像素尺寸画到画布上 / Draw to the canvas at its current pixel size. */
  render(view: View, style: Style, fast = false): void {
    const gl = this.gl
    const cw = this.canvas.width, ch = this.canvas.height
    if (cw === 0 || ch === 0) return
    // 拖动时，几百万个球以上的场景用一半的分辨率画：拖的时候看的是转动，不是细节，松手后马上补画完整的
    // while dragging, a scene of several million spheres or more is drawn at half resolution: what matters during a drag is the turning, not the detail, and the full picture follows on release
    const ss = fast ? (this.lastAtoms > 4_000_000 ? 0.5 : 1) : this.supersample(cw, ch)
    const t = this.renderInternal(view, style, Math.max(1, Math.round(cw * ss)), Math.max(1, Math.round(ch * ss)), fast)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.outFbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, cw, ch, gl.COLOR_BUFFER_BIT, gl.LINEAR)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** 离屏渲染 w×h，返回自上而下的 RGBA 像素 / Render off-screen at w×h and return top-down RGBA pixels. */
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

/** 实例 o 的列主序 4x4 / instance o as a column-major 4x4 */
export function instanceMatrix(inst: Instances, o: number): Float32Array {
  const d = inst.data, k = o * 16
  return new Float32Array([d[k]!, d[k + 4]!, d[k + 8]!, 0, d[k + 1]!, d[k + 5]!, d[k + 9]!, 0, d[k + 2]!, d[k + 6]!, d[k + 10]!, 0, d[k + 3]!, d[k + 7]!, d[k + 11]!, 1])
}

/**
 * 画出来的全部内容的包围球，以及贴合形状的一组小球（用于取景）。
 * Bounding sphere of everything drawn, plus a set of small spheres that hug the shape (for framing).
 */
/** 这一项这一帧画不画：拖动时的快速绘制不画陪衬 / whether an item is drawn this frame: the quick drawing while dragging leaves out decoration */
export function drawnNow(it: { decor?: boolean }, fast: boolean): boolean {
  return !(fast && it.decor)
}

export function sceneBounds(items: RenderItem[]): Bounds {
  let radius = 0
  const placed: number[] = []
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const it of items) {
    // 实例很多时，每个实例只用一个球，否则小球数量会爆炸
    // with very many instances, one sphere per instance keeps the list small
    const instanced = it.draws.reduce((s, d) => s + d.count * d.opCount, 0)
    const CHUNK = instanced > 20_000_000 ? Infinity : 64
    const data = it.instances.data
    for (const d of it.draws) {
      const s: number[] = []
      // 链上相邻的原子在空间上也相邻，所以短片段的包围球贴得很紧；松的片段再对半分
      // atoms that follow each other in a chain are near each other, so spheres around
      // short stretches hug the shape; a loose stretch is split in half again
      const stack: [number, number][] = []
      if (CHUNK === Infinity) stack.push([d.start, d.start + d.count])
      else for (let a = d.start; a < d.start + d.count; a += CHUNK) stack.push([a, Math.min(a + CHUNK, d.start + d.count)])
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
        for (let i = a; i < end; i++) r = Math.max(r, Math.hypot(it.posr[i * 4]! - cx, it.posr[i * 4 + 1]! - cy, it.posr[i * 4 + 2]! - cz) + it.posr[i * 4 + 3]!)
        if (CHUNK !== Infinity && r > 8 && end - a > 1) {
          const mid = (a + end) >> 1
          stack.push([a, mid], [mid, end])
        } else s.push(cx, cy, cz, r)
      }
      for (let o = d.opStart; o < d.opStart + d.opCount; o++) {
        const m = o * 16
        for (let k = 0; k < s.length; k += 4) {
          const x = data[m]! * s[k]! + data[m + 1]! * s[k + 1]! + data[m + 2]! * s[k + 2]! + data[m + 3]!
          const y = data[m + 4]! * s[k]! + data[m + 5]! * s[k + 1]! + data[m + 6]! * s[k + 2]! + data[m + 7]!
          const z = data[m + 8]! * s[k]! + data[m + 9]! * s[k + 1]! + data[m + 10]! * s[k + 2]! + data[m + 11]!
          const r = s[k + 3]!
          placed.push(x, y, z, r)
          if (x - r < lo[0]!) lo[0] = x - r
          if (y - r < lo[1]!) lo[1] = y - r
          if (z - r < lo[2]!) lo[2] = z - r
          if (x + r > hi[0]!) hi[0] = x + r
          if (y + r > hi[1]!) hi[1] = y + r
          if (z + r > hi[2]!) hi[2] = z + r
        }
      }
    }
  }
  if (placed.length === 0) return { center: [0, 0, 0], radius: 1, spheres: new Float32Array(0), subunitSize: 30 }
  const center: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
  for (let k = 0; k < placed.length; k += 4) radius = Math.max(radius, Math.hypot(placed[k]! - center[0], placed[k + 1]! - center[1], placed[k + 2]! - center[2]) + placed[k + 3]!)
  const subunitSize = Math.min(...items.map((it) => it.subunitSize))
  return { center, radius, spheres: new Float32Array(placed), subunitSize }
}
