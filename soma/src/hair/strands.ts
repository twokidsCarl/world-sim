// 近景真发丝（WebGPU）：读引导发丝，每根插值出几根渲染发丝，画成始终朝向相机的细带子（宽度不小于一个像素，覆盖率按
// 真实宽度与像素宽度之比给，经 alpha-to-coverage 变成多重采样的覆盖）。着色与发片相同（Karis 的三瓣），自遮挡取构建时
// 算好的沿外法线的不透明度。根钉在皮肤上的方式与发片相同；根的位置放在一张小数据纹理里，体型、表情变了只更新它。
// Close-up real strands (WebGPU): the guide strands are read and each yields a few interpolated render strands, drawn
// as thin camera-facing ribbons (at least a pixel wide, with coverage given by the ratio of true to pixel width, which
// alpha-to-coverage turns into multisample coverage). Shading is the cards' (Karis's three lobes); self-occlusion is the
// opacity along the outward normal computed at build time. Roots are pinned to the skin as for the cards; root positions
// live in a small data texture, and only that is updated when shape or expression changes.

import { BufferAttribute, BufferGeometry, DataTexture, FloatType, NearestFilter, RGBAFormat, type MeshStandardNodeMaterial } from 'three/webgpu'
import { Fn, attribute, cameraPosition, cameraProjectionMatrix, clamp, cross, float, int, ivec2, length, max, mix, modelWorldMatrixInverse, normalLocal, normalViewGeometry, normalize, positionGeometry, positionLocal, screenSize, smoothstep, textureLoad, uniform, varyingProperty, vec4 } from 'three/tsl'
import type { HairStrandsInfo } from '../look/types.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import { type HairLook, type HairMaterialOptions, fibreColour, hairMaterial } from './material.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const pad = (n: number): number => (n + 3) & ~3
/** 根位置纹理的宽度 / width of the root-position texture */
const ROOT_COLS = 256

export interface DecodedGuides {
  info: HairStrandsInfo
  rootVerts: Uint32Array
  rootBary: Float32Array
  /** 相对根的点（米），G × P × 3 / points relative to the root (m), G × P × 3 */
  offset: Float32Array
  occlusion: Float32Array
  layer: Float32Array
}

export function strandBytes(info: HairStrandsInfo): number {
  const G = info.guides, P = info.points
  return G * 12 + pad(G * 4) + pad(G * P * 6) + pad(G * P) + pad(G)
}

export function decodeGuides(bin: Uint8Array, info: HairStrandsInfo, offsetUnit: number, skinVertexCount: number): DecodedGuides {
  if (bin.byteLength !== strandBytes(info)) throw new Error(`${info.file} has ${bin.byteLength} bytes, hair.json implies ${strandBytes(info)}`)
  const G = info.guides, P = info.points
  const copy = bin.slice()
  let o = 0
  const rootVerts = new Uint32Array(copy.buffer, o, G * 3)
  o += G * 12
  const bary = new Uint16Array(copy.buffer, o, G * 2)
  o += pad(G * 4)
  const off = new Int16Array(copy.buffer, o, G * P * 3)
  o += pad(G * P * 6)
  const occ = new Uint8Array(copy.buffer, o, G * P)
  o += pad(G * P)
  const lay = new Uint8Array(copy.buffer, o, G)
  for (const v of rootVerts) if (v >= skinVertexCount) throw new Error(`${info.file}: root vertex ${v} is beyond the skin`)
  const rootBary = new Float32Array(G * 3)
  for (let g = 0; g < G; g++) {
    const w1 = bary[g * 2]! / 65535, w2 = bary[g * 2 + 1]! / 65535
    rootBary.set([Math.max(0, 1 - w1 - w2), w1, w2], g * 3)
  }
  return { info, rootVerts, rootBary, offset: Float32Array.from(off, (x) => x * offsetUnit), occlusion: Float32Array.from(occ, (x) => x / 255), layer: Float32Array.from(lay, (x) => x / 255) }
}

/** 可复现的随机数 / reproducible random numbers */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface StrandGeometry {
  geometry: BufferGeometry
  strands: number
  /** 每个引导发丝对应的渲染发丝的皮肤影响取自哪个皮肤顶点 / skin vertex whose influences each guide's render strands take */
  dominant: Uint32Array
}

/**
 * 插值出渲染发丝。每根引导发丝出 `children` 根：根在与第一段垂直的平面里随机偏开（半径 `spread`），偏移量向梢按 `clump` 收拢，
 * 再加一点随机游走；长度各差 0–15%。顶点成对（左右），着色器里按相机方向展开。
 * Interpolate the render strands. Each guide yields `children`: roots offset at random in the plane normal to the first
 * segment (radius `spread`), the offset gathering towards the tip by `clump`, plus a little random walk; lengths vary by
 * 0–15 %. Vertices come in pairs (left, right) and are spread towards the camera in the shader.
 */
export function buildStrands(d0: DecodedGuides, seed = 1, subdivide = 1): StrandGeometry {
  const d = subdivide > 1 ? smoothGuides(d0, subdivide) : d0
  const info = { ...d.info, points: subdivide > 1 ? (d0.info.points - 1) * subdivide + 1 : d0.info.points }
  const G = info.guides, P = info.points, K = info.children
  const S = G * K
  const V = S * P * 2
  const position = new Float32Array(V * 3)
  const tangent = new Float32Array(V * 3)
  const side = new Float32Array(V)
  const root = new Float32Array(V)
  const along = new Float32Array(V)
  const id = new Float32Array(V)
  const occ = new Float32Array(V)
  const layer = new Float32Array(V)
  const r = rng(seed)
  const pts = new Float32Array(P * 3)
  for (let g = 0; g < G; g++) {
    const o = g * P * 3
    // 第一段的方向和与之垂直的两个方向 / the first segment's direction and two directions normal to it
    let tx = d.offset[o + 3]! - d.offset[o]!, ty = d.offset[o + 4]! - d.offset[o + 1]!, tz = d.offset[o + 5]! - d.offset[o + 2]!
    const tl = Math.hypot(tx, ty, tz) || 1
    tx /= tl, ty /= tl, tz /= tl
    let ax = Math.abs(ty) < 0.9 ? 0 : 1, ay = Math.abs(ty) < 0.9 ? 1 : 0, az = 0
    const dt = ax * tx + ay * ty + az * tz
    ax -= dt * tx, ay -= dt * ty, az -= dt * tz
    const al = Math.hypot(ax, ay, az) || 1
    ax /= al, ay /= al, az /= al
    const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax
    for (let c = 0; c < K; c++) {
      const s = g * K + c
      const ang = r() * 2 * Math.PI, rad = info.spread * Math.sqrt(r())
      const ox = (Math.cos(ang) * ax + Math.sin(ang) * bx) * rad, oy = (Math.cos(ang) * ay + Math.sin(ang) * by) * rad, oz = (Math.cos(ang) * az + Math.sin(ang) * bz) * rad
      const lenScale = 0.85 + 0.15 * r()
      const strandId = r()
      let wx = 0, wy = 0, wz = 0
      for (let k = 0; k < P; k++) {
        // 沿引导发丝按缩短后的参数取点 / sample the guide at the shortened parameter
        const u = (k / (P - 1)) * lenScale * (P - 1)
        const k0 = Math.min(P - 2, Math.floor(u)), f = u - k0
        const i0 = o + k0 * 3, i1 = i0 + 3
        const sAlong = k / (P - 1)
        const shrink = 1 - info.clump * sAlong
        wx += (r() - 0.5) * info.spread * 0.15
        wy += (r() - 0.5) * info.spread * 0.15
        wz += (r() - 0.5) * info.spread * 0.15
        pts[k * 3] = d.offset[i0]! * (1 - f) + d.offset[i1]! * f + ox * shrink + wx * sAlong
        pts[k * 3 + 1] = d.offset[i0 + 1]! * (1 - f) + d.offset[i1 + 1]! * f + oy * shrink + wy * sAlong
        pts[k * 3 + 2] = d.offset[i0 + 2]! * (1 - f) + d.offset[i1 + 2]! * f + oz * shrink + wz * sAlong
      }
      for (let k = 0; k < P; k++) {
        const a = Math.max(0, k - 1), b = Math.min(P - 1, k + 1)
        let ux = pts[b * 3]! - pts[a * 3]!, uy = pts[b * 3 + 1]! - pts[a * 3 + 1]!, uz = pts[b * 3 + 2]! - pts[a * 3 + 2]!
        const ul = Math.hypot(ux, uy, uz) || 1
        ux /= ul, uy /= ul, uz /= ul
        for (let e = 0; e < 2; e++) {
          const v = (s * P + k) * 2 + e
          position.set([pts[k * 3]!, pts[k * 3 + 1]!, pts[k * 3 + 2]!], v * 3)
          tangent.set([ux, uy, uz], v * 3)
          side[v] = e === 0 ? -1 : 1
          root[v] = g
          along[v] = k / (P - 1)
          id[v] = strandId
          occ[v] = d.occlusion[g * P + k]!
          layer[v] = d.layer[g]!
        }
      }
    }
  }
  const index = new Uint32Array(S * (P - 1) * 6)
  let n = 0
  for (let s = 0; s < S; s++) {
    for (let k = 0; k + 1 < P; k++) {
      const a = (s * P + k) * 2
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], n)
      n += 6
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  // "法线"属性里放发丝走向：蒙皮按法线旋转它 / the "normal" attribute holds the strand direction: skinning rotates it like a normal
  geometry.setAttribute('normal', new BufferAttribute(tangent, 3))
  // 合成两个属性（WebGPU 每个管线最多 8 个顶点缓冲）：aRef = (边, 引导发丝, 模拟发丝)，aStrand = (根→梢, 随机数, 自遮挡, 层)
  // packed into two attributes (WebGPU allows at most 8 vertex buffers per pipeline): aRef = (side, guide, simulated strand), aStrand = (root → tip, random, occlusion, layer)
  const ref = new Float32Array(V * 3), strand = new Float32Array(V * 4)
  for (let v = 0; v < V; v++) {
    ref[v * 3] = side[v]!
    ref[v * 3 + 1] = root[v]!
    strand.set([along[v]!, id[v]!, occ[v]!, layer[v]!], v * 4)
  }
  geometry.setAttribute('aRef', new BufferAttribute(ref, 3))
  geometry.setAttribute('aStrand', new BufferAttribute(strand, 4))
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(V * 4), 4, true))
  geometry.setAttribute('skinWeight', new BufferAttribute(new Uint8Array(V * 4), 4, true))
  geometry.setIndex(new BufferAttribute(index, 1))
  const dominant = new Uint32Array(G)
  for (let g = 0; g < G; g++) {
    let best = 0
    for (let k = 1; k < 3; k++) if (d.rootBary[g * 3 + k]! > d.rootBary[g * 3 + best]!) best = k
    dominant[g] = d.rootVerts[g * 3 + best]!
  }
  return { geometry, strands: S, dominant }
}

/**
 * 引导发丝用 Catmull–Rom 细分（每段分成 n 段）：发片的点距对波纹来说太稀，直接连线会折成锯齿。
 * Catmull–Rom subdivision of the guides (each segment into n): the shipped point spacing is too coarse for the waves,
 * and straight segments would fold them into a zigzag.
 */
export function smoothGuides(d: DecodedGuides, n: number): DecodedGuides {
  const G = d.info.guides, P = d.info.points, Q = (P - 1) * n + 1
  const offset = new Float32Array(G * Q * 3), occlusion = new Float32Array(G * Q)
  for (let g = 0; g < G; g++) {
    const at = (k: number, c: number): number => d.offset[(g * P + Math.max(0, Math.min(P - 1, k))) * 3 + c]!
    for (let k = 0; k < P - 1; k++) {
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t, q = g * Q + k * n + j
        for (let c = 0; c < 3; c++) {
          const p0 = at(k - 1, c), p1 = at(k, c), p2 = at(k + 1, c), p3 = at(k + 2, c)
          offset[q * 3 + c] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
        }
        occlusion[q] = d.occlusion[g * P + k]! * (1 - t) + d.occlusion[g * P + k + 1]! * t
      }
    }
    for (let c = 0; c < 3; c++) offset[(g * Q + Q - 1) * 3 + c] = at(P - 1, c)
    occlusion[g * Q + Q - 1] = d.occlusion[g * P + P - 1]!
  }
  return { ...d, info: { ...d.info, points: Q }, offset, occlusion }
}

/** 根位置纹理（每个引导发丝一个纹素）/ the root-position texture (one texel per guide) */
export function rootTexture(guides: number): DataTexture {
  const rows = Math.max(1, Math.ceil(guides / ROOT_COLS))
  const t = new DataTexture(new Float32Array(ROOT_COLS * rows * 4), ROOT_COLS, rows, RGBAFormat, FloatType)
  t.minFilter = t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

/** 按皮肤当前的静止位置写根的位置 / write the root positions from the skin's current rest positions */
export function placeRoots(d: DecodedGuides, skin: ArrayLike<number>, tex: DataTexture): void {
  const out = tex.image.data as Float32Array
  for (let g = 0; g < d.info.guides; g++) {
    let x = 0, y = 0, z = 0
    for (let k = 0; k < 3; k++) {
      const v = d.rootVerts[g * 3 + k]! * 3, w = d.rootBary[g * 3 + k]!
      x += skin[v]! * w
      y += skin[v + 1]! * w
      z += skin[v + 2]! * w
    }
    out[g * 4] = x
    out[g * 4 + 1] = y
    out[g * 4 + 2] = z
  }
  tex.needsUpdate = true
}

/**
 * 发丝材质。`width` = 画出来的宽度（米，纤维直径 × 每根渲染发丝代表的根数）。
 * The strand material. `width` = the drawn width (m: fibre diameter × hairs per render strand).
 */
export function makeStrandMaterial(look: HairLook, o: HairMaterialOptions, roots: DataTexture, width: number): { material: MeshStandardNodeMaterial; setSkinning: (skinning: SkinningData, mode: SkinningMode, disp?: ((along: N, sim: N) => N) | null) => void } {
  const ref: N = attribute('aRef', 'vec3')
  const st: N = attribute('aStrand', 'vec4')
  const along: N = st.x
  const id: N = st.y
  const occ: N = st.z
  const layer: N = st.w
  const w0 = uniform(width)
  const T: N = normalize(normalViewGeometry).toVar('strandTangent')
  const { C, albedo } = fibreColour(look, o, id, float(0.5))
  // 自遮挡（构建时算的）、层、发根 / self-occlusion (from the build), layer, root
  const ao: N = mix(float(1), float(0.3), occ)
    .mul(mix(float(1 - o.layerShadow), float(1), layer))
    .mul(mix(float(1 - o.rootShadow), float(1), smoothstep(0, 0.1, along)))
  const m = hairMaterial(T, C, albedo, ao, id, o)
  // 覆盖率在顶点着色器里算好传下来 / coverage is computed in the vertex shader and passed down
  const coverage: N = varyingProperty('float', 'vStrandCoverage')
  const setSkinning = (skinning: SkinningData, mode: SkinningMode, disp: ((along: N, sim: N) => N) | null = null): void => {
    const skinned: N = positionNodeFor(skinning, mode, false)
    const out = Fn(() => {
      // 根的位置 + 相对根的点，再交给蒙皮 / root position + the point relative to it, then handed to skinning
      const g: N = int(ref.y)
      const rootPos: N = textureLoad(roots, (ivec2 as N)(g.mod(ROOT_COLS), g.div(ROOT_COLS))).xyz
      // 动力学的位移（静止空间）加在蒙皮之前 / the dynamics displacement (rest space) is added before skinning
      const base: N = rootPos.add(positionGeometry)
      ;(positionLocal as N).assign(disp ? base.add(disp(along, ref.z)) : base)
      const p: N = (skinned as N).toVar()
      // 朝相机展开；宽度不小于一个像素 / spread towards the camera; at least a pixel wide
      const cam: N = (modelWorldMatrixInverse as N).mul((vec4 as N)(cameraPosition, 1)).xyz
      const toCam: N = cam.sub(p)
      const dist: N = length(toCam)
      const t: N = normalize(normalLocal)
      const sideDir: N = normalize(cross(t, toCam))
      const pixel: N = dist.mul(2).div(max((cameraProjectionMatrix as N).element(1).y.mul(screenSize.y), 1))
      // 梢最后 20% 变细 / the last 20 % tapers
      const taper: N = float(1).sub(smoothstep(0.8, 1, along).mul(0.8))
      const wTrue: N = w0.mul(taper)
      const w: N = max(wTrue, pixel)
      coverage.assign(clamp(wTrue.div(w), 0, 1))
      return p.add(sideDir.mul(ref.x.mul(w.mul(0.5))))
    })()
    m.positionNode = out
    m.opacityNode = coverage as N
    m.needsUpdate = true
  }
  return { material: m, setSkinning }
}
