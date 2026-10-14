// 屏幕空间的可分离次表面散射（只在 WebGPU、只在写实外观显示时）：按 Jimenez 等 2015《Separable Subsurface Scattering》
// （Computer Graphics Forum 34(6)）的做法重写，没有搬它的代码。
// Screen-space separable subsurface scattering (WebGPU only, only while the lifelike look shows): reimplemented
// after Jimenez et al. 2015, "Separable Subsurface Scattering" (Computer Graphics Forum 34(6)); none of its code is copied.
//
// 做法 / How
//   · 场景照常画进一个多目标的离屏缓冲：output 是完整的颜色；sss 只有皮肤写，是皮肤的漫反射（直射 + 环境），alpha = 1；
//     别的材质写 0，半透明的覆盖层按材质的混合方式保留下面的值。多重采样解析后它是"预乘"的（rgb 乘了皮肤覆盖率）。
//     镜面不在里面，所以不会被模糊。
//     The scene is drawn as usual into an off-screen multiple-render-target buffer: `output` is the full colour;
//     `sss` is written by skin only and holds the skin's diffuse light (direct + ambient) with alpha = 1; other
//     materials write 0, and translucent overlays keep the value beneath through the material's blending. After the
//     multisample resolve it is "premultiplied" (rgb times skin coverage). Specular is not in it, so it is never blurred.
//   · 对 sss 做两遍一维模糊（先横后竖），核由 d'Eon 等 2007 的皮肤剖面（六个高斯之和，毫米）算出，按深度换成屏幕上的步长；
//     邻点深度差超过它离中心的距离时退回中心值（沿表面走，不越过轮廓）；按覆盖率做归一化卷积，头发边上不出彩边。
//     `sss` is blurred in two 1-D passes (horizontal, then vertical) with a kernel from the skin profile of d'Eon
//     et al. 2007 (a sum of six Gaussians, mm), turned into a screen step by depth; a neighbour whose depth differs
//     by more than its distance from the centre falls back to the centre value (the blur follows the surface and
//     does not cross silhouettes); the convolution is normalised by coverage, so hair edges get no coloured fringe.
//   · 合成：颜色 + 覆盖率 × (模糊后的漫反射 − 原来的漫反射)。色调映射和色彩空间由 three 的 RenderPipeline 在最后做。
//     Composite: colour + coverage × (blurred diffuse − original diffuse). Tone mapping and colour space are applied
//     last by three's RenderPipeline.

import { BlendMode, Color, MaterialBlending, type PerspectiveCamera, RenderPipeline, type Scene, Vector2, type WebGPURenderer } from 'three/webgpu'
import { Fn, abs, clamp, float, max, mrt, output, pass, perspectiveDepthToViewZ, rtt, select, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { skinSss } from './skinLighting.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** d'Eon 等 2007 的皮肤剖面：[方差 mm², R, G, B]（与 tools/look/preintegrated.ts 相同）/ the skin profile of d'Eon et al. 2007: [variance mm², R, G, B] (as in tools/look/preintegrated.ts) */
const PROFILE: [number, number, number, number][] = [
  [0.0064, 0.233, 0.455, 0.649],
  [0.0484, 0.1, 0.336, 0.344],
  [0.187, 0.118, 0.198, 0.0],
  [0.567, 0.113, 0.007, 0.007],
  [1.99, 0.358, 0.004, 0.0],
  [7.41, 0.078, 0.0, 0.0],
]

/** 一维核：taps 个采样，偏移（毫米）向中心加密，权重按通道归一 / the 1-D kernel: `taps` samples, offsets (mm) denser towards the centre, weights normalised per channel */
export function sssKernel(taps = 17, rangeMm = 6): { mm: number; w: [number, number, number] }[] {
  const half = (taps - 1) / 2
  const offs: number[] = []
  for (let i = 0; i < taps; i++) {
    const o = (i - half) / half // −1…1
    offs.push(Math.sign(o) * o * o * rangeMm)
  }
  const g1 = (x: number, v: number): number => Math.exp(-(x * x) / (2 * v)) / Math.sqrt(2 * Math.PI * v)
  const out = offs.map((mm, i) => {
    const lo = i > 0 ? (offs[i - 1]! + mm) / 2 : mm - (offs[1]! - offs[0]!) / 2
    const hi = i < taps - 1 ? (offs[i + 1]! + mm) / 2 : mm + (offs[taps - 1]! - offs[taps - 2]!) / 2
    const w: [number, number, number] = [0, 0, 0]
    // 每个高斯在这个格子里的面积（中点法，细分 8 段）/ each Gaussian's area over this cell (midpoint rule, 8 sub-steps)
    for (let c = 0; c < 3; c++) {
      let s = 0
      for (let k = 0; k < 8; k++) {
        const x = lo + ((k + 0.5) / 8) * (hi - lo)
        for (const g of PROFILE) s += g[c + 1]! * g1(x, g[0])
      }
      w[c] = (s * (hi - lo)) / 8
    }
    return { mm, w }
  })
  for (let c = 0; c < 3; c++) {
    const sum = out.reduce((a, t) => a + t.w[c]!, 0)
    for (const t of out) t.w[c] = t.w[c]! / sum
  }
  return out
}

export class SkinSSS {
  private pipeline: RenderPipeline | null = null
  private on = false
  /** 投影矩阵的 (P00, P11) / 2：深度 z 处每米对应的屏幕坐标是它们除以 z / (P00, P11) / 2 of the projection: screen units per metre at depth z are these over z */
  private readonly proj = uniform(new Vector2(1, 1))
  /** 散射宽度的总倍数（1 = 剖面原样）/ overall scatter-width scale (1 = the profile as it is) */
  readonly strength = uniform(1)
  /** 场景相机的近、远裁剪面：在全屏四边形里 cameraNear / cameraFar 指的是四边形自己的相机，所以另传
   * the scene camera's near and far planes: inside a full-screen quad cameraNear / cameraFar refer to the quad's own camera, so they are passed separately */
  private readonly near = uniform(0.005)
  private readonly far = uniform(60)

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
  ) {}

  /** 只有 WebGPU 后端才做 / only on the WebGPU backend */
  get supported(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.renderer.backend as any)?.isWebGPUBackend === true
  }

  get active(): boolean {
    return this.on
  }

  /** 打开或关上；返回是否有变化 / Switch on or off; returns whether anything changed. */
  setActive(on: boolean): boolean {
    const v = on && this.supported
    if (v === this.on) return false
    this.on = v
    return true
  }

  /** 开着就画这一帧并返回 true；关着返回 false，由调用者照常画 / Draw this frame and return true when on; false when off, and the caller draws as usual. */
  render(): boolean {
    if (!this.on) return false
    if (!this.pipeline) this.pipeline = this.build()
    const p = this.camera.projectionMatrix.elements
    this.proj.value.set(p[0]! / 2, p[5]! / 2)
    this.near.value = this.camera.near
    this.far.value = this.camera.far
    this.pipeline.render()
    return true
  }

  private build(): RenderPipeline {
    const scenePass: N = pass(this.scene, this.camera)
    // sss 目标要按材质的混合方式写：半透明的覆盖层（如头皮底色）在这里输出 (0, 0, 0, 0)，混合后保留下面皮肤的值；
    // three 默认对额外目标不混合，那样它会把皮肤的值抹成 0，在覆盖层边上留下一道线。清屏值是 0（不是背景色）。
    // the sss target must be written with the material's blending: translucent overlays (such as the scalp tint) output
    // (0, 0, 0, 0) here and blending keeps the skin's value underneath; three's default for extra targets is no
    // blending, which wiped the skin's value to 0 and left a line at the overlay's edge. It clears to 0 (not the background colour).
    const targets: N = mrt({ output, sss: skinSss })
    targets.setBlendMode('sss', new BlendMode(MaterialBlending))
    targets.setClearColor('sss', new Color(0, 0, 0), 0)
    scenePass.setMRT(targets)
    const color: N = scenePass.getTextureNode('output')
    // sss 是"预乘"的：多重采样解析后 rgb = 漫反射 × 皮肤覆盖率，a = 覆盖率（头发、睫毛边上的像素只有一部分是皮肤）
    // sss is "premultiplied": after the multisample resolve rgb = diffuse × skin coverage and a = coverage (pixels at the edges of hair and lashes are only partly skin)
    const sss: N = scenePass.getTextureNode('sss')
    const depthTex: N = scenePass.getTextureNode('depth')
    const depthAt = (at: N): N => (perspectiveDepthToViewZ as N)(depthTex.sample(at).r, this.near, this.far).negate()
    const kernel = sssKernel()
    const proj = this.proj
    const EPS = 1e-3
    // 归一化卷积：Σ w·rgb / Σ w·a，按通道；结果再乘回中心的覆盖率，仍是预乘的
    // normalised convolution: Σ w·rgb / Σ w·a per channel; the result is multiplied back by the centre's coverage, so it stays premultiplied
    const blur = (src: N, dir: [number, number]): N =>
      Fn(() => {
        const at: N = uv()
        const c: N = src.sample(at)
        const zM: N = depthAt(at)
        const step: N = (vec2 as N)(proj.x.mul(dir[0]), proj.y.mul(dir[1])).div(zM).mul(0.001).mul(this.strength)
        const num: N = vec3(0).toVar()
        const den: N = vec3(0).toVar()
        for (const k of kernel) {
          const w: N = (vec3 as N)(...k.w)
          if (k.mm === 0) {
            num.addAssign(c.rgb.mul(w))
            den.addAssign(w.mul(c.a))
            continue
          }
          const o: N = at.add(step.mul(k.mm))
          const s: N = src.sample(o)
          // 深度差大于离中心的距离、或邻点不是皮肤，就退回中心值 / fall back to the centre when the depth step exceeds the distance from the centre, or the neighbour is not skin
          const dz: N = abs(depthAt(o).sub(zM))
          const f: N = clamp(dz.sub(Math.abs(k.mm) * 0.001).div(0.002), 0, 1)
          const back: N = select(s.a.greaterThan(EPS), f, float(1))
          num.addAssign(s.rgb.mul(float(1).sub(back)).add(c.rgb.mul(back)).mul(w))
          den.addAssign(w.mul(s.a.mul(float(1).sub(back)).add(c.a.mul(back))))
        }
        const d: N = num.div(max(den, vec3(EPS)))
        return vec4(select(c.a.greaterThan(EPS), d.mul(c.a), vec3(0)), c.a)
      })()
    // 横向一遍画进中间纹理；竖向一遍按纹理本身取样（rtt 节点被克隆时会另起一张 1×1 的目标，所以不能直接对它 .sample）
    // the horizontal pass renders into an intermediate texture; the vertical pass samples that texture itself (cloning an rtt node makes a new 1×1 target, so it cannot be .sample()d directly)
    const h: N = rtt(blur(sss, [1, 0]))
    const v: N = blur(texture(h.value), [0, 1])
    // 合成：颜色 + 覆盖率 × (模糊后的漫反射 − 原来的漫反射)，都先除掉覆盖率 / composite: colour + coverage × (blurred diffuse − original diffuse), each divided by coverage first
    const cov: N = sss.a
    const delta: N = v.rgb.div(max(v.a, EPS)).sub(sss.rgb.div(max(cov, EPS))).mul(cov)
    // h 本身也要进图，它的 updateBefore 才会每帧画中间纹理 / h itself must be in the graph so its updateBefore renders the intermediate texture every frame
    const composite: N = vec4(color.rgb.add(select(cov.greaterThan(EPS), delta, vec3(0))).add(h.rgb.mul(0)), color.a)
    return new RenderPipeline(this.renderer, composite)
  }

  dispose(): void {
    this.pipeline?.dispose()
    this.pipeline = null
  }
}
