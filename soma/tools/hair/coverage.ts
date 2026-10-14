// 遮盖率检查（不用渲染）：在头皮上取点，从几个视角往相机方向射线，穿过发片时按贴图集的覆盖率累计不透明度。
// 按着色器的做法近似：贴图在常用的观看距离下约缩小到 1.2 级多级纹理（这里用 5×5 纹素的盒平均代替），覆盖率按级数补偿，
// 再经 alpha-to-coverage 的阈值（0.2 起）变成每层的不透明度。分缝两侧 4 毫米和发际线的渐变带不计。
// A coverage check (no rendering): points are taken on the scalp, rays are cast from them towards the camera for a few
// views, and opacity accumulates through the cards by the atlas coverage. It mimics the shader: at the usual viewing
// distance the atlas is minified to about mip level 1.2 (approximated by a 5 × 5 texel box average), coverage is boosted by
// the level, and alpha-to-coverage's threshold (from 0.2) turns it into each layer's opacity. 4 mm either side of the part
// and the hairline ramp are not counted.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { type HeadFrame, fromHeadDir, toHead } from './frame.ts'
import { type Surface, type V3, add, dot, norm, scale } from './geom.ts'
import { type Root, scatter } from './sample.ts'
import type { Scalp } from './scalp.ts'
import type { BodyData } from './skin.ts'
import { PART, type ScalpStyle, WHORL_Z } from './strands.ts'
import { decodeLod, placeVertices } from '../../src/hair/cards.ts'
import type { HairLod } from '../../src/look/types.ts'

/** 视角：从头指向相机（头部坐标）/ views: from the head towards the camera (head coordinates) */
export const VIEWS: Record<string, V3> = {
  front: [0, 0.25, 1],
  threeQuarterL: [0.7, 0.3, 0.65],
  threeQuarterR: [-0.7, 0.3, 0.65],
  sideL: [1, 0.15, 0],
  sideR: [-1, 0.15, 0],
  top: [0, 1, 0.1],
  back: [0, 0.25, -1],
}

export interface AtlasSampler {
  /** 覆盖率（0–1），u、v 为贴图坐标（v 向下）/ coverage (0–1) at atlas coordinates u, v (v down) */
  coverage(u: number, v: number): number
  /** 根→梢位置（0–1）/ root → tip position (0–1) */
  rootTip(u: number, v: number): number
}

export function atlasSampler(cov: ArrayLike<number>, s: ArrayLike<number>, size: number, scaleTo = 1): AtlasSampler {
  const R = 2
  const at = (u: number, v: number): [number, number] => [Math.min(size - 1, Math.max(0, Math.floor(u * size))), Math.min(size - 1, Math.max(0, Math.floor(v * size)))]
  return {
    coverage(u, v) {
      const [x, y] = at(u, v)
      let sum = 0, n = 0
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = Math.min(size - 1, Math.max(0, x + dx)), yy = Math.min(size - 1, Math.max(0, y + dy))
          sum += cov[yy * size + xx]! / scaleTo
          n++
        }
      }
      return sum / n
    },
    rootTip(u, v) {
      const [x, y] = at(u, v)
      const c = cov[y * size + x]! / scaleTo
      return c > 0.01 ? Math.min(1, s[y * size + x]! / scaleTo / c) : 1
    },
  }
}

export interface CardMesh {
  positions: Float32Array
  uv: Float32Array
  index: Uint32Array
}

export interface CoverageResult {
  /** 每个视角被遮住的头皮点的比例 / per view, the share of scalp points covered */
  views: Record<string, number>
  /** 所有视角合计 / all views together */
  all: number
  samples: number
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 发片网格的射线检测器 / a ray tester for the card mesh */
export class CardRays {
  private readonly bvh: MeshBVH
  constructor(
    mesh: CardMesh,
    private readonly atlas: AtlasSampler,
    /** 根端淡入、发梢淡出（与材质一致）/ root fade-in and tip fade-out (as the material) */
    private readonly rootFade: number,
    private readonly tipFade = 0,
  ) {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    g.setAttribute('uv', new BufferAttribute(mesh.uv, 2))
    g.setIndex(new BufferAttribute(mesh.index.slice(), 1))
    this.bvh = new MeshBVH(g)
  }

  /** 从 p 沿 d 穿过各层发片累计的不透明度 / opacity accumulated through the card layers from p along d */
  opacity(p: V3, d: V3): number {
    const hits = this.bvh.raycast(new Ray(new Vector3(...p), new Vector3(...d)), DoubleSide, 0, 0.6)
    let t = 1
    for (const h of hits) {
      if (!h.uv) continue
      const u = h.uv.x, v = h.uv.y
      // 多级纹理约 1.2 级：覆盖率 × (1 + 0.35·1.2)，根端淡入，再过 alpha-to-coverage 的阈值
      // mip level about 1.2: coverage × (1 + 0.35·1.2), the root fade-in, then the alpha-to-coverage threshold
      let a = Math.min(1, this.atlas.coverage(u, v) * 1.42)
      const st = this.atlas.rootTip(u, v)
      if (this.rootFade > 0) a *= smooth(0, this.rootFade, st)
      a *= 1 - smooth(0.8, 1, st) * this.tipFade
      const eff = smooth(0.1, 0.45, a)
      t *= 1 - eff
      if (t < 0.01) break
    }
    return 1 - t
  }
}

/**
 * 头皮点在各视角下是否被遮住（不透明度 ≥ 0.9）。`exclude` 为真的点不计（分缝、发际线渐变带）；朝向偏离视线太多或被身体
 * 别处挡住的点也不计。
 * Whether scalp points are covered (opacity ≥ 0.9) per view. Points for which `exclude` is true are not counted (the part,
 * the hairline ramp); nor are points turned too far from the view or hidden by the body elsewhere.
 */
export function scalpCoverage(f: HeadFrame, skin: Surface, rays: CardRays, points: Root[], exclude: (p: V3) => boolean): CoverageResult & { perPoint: Map<string, number[]> } {
  const views: Record<string, number> = {}
  let hit = 0, total = 0
  const perPoint = new Map<string, number[]>()
  for (const [name, dirHead] of Object.entries(VIEWS)) {
    const d = norm(fromHeadDir(f, dirHead))
    let h = 0, n = 0
    const values: number[] = []
    for (const r of points) {
      if (exclude(r.p) || dot(r.n, d) < 0.3) {
        values.push(-1)
        continue
      }
      const o = add(r.p, scale(r.n, 0.0004))
      if (isFinite(skin.ray(o, d, 0.6))) {
        values.push(-1)
        continue
      }
      const op = rays.opacity(o, d)
      values.push(op)
      n++
      if (op >= 0.9) h++
    }
    perPoint.set(name, values)
    views[name] = n ? h / n : 1
    hit += h
    total += n
  }
  return { views, all: total ? hit / total : 1, samples: points.length, perPoint }
}

/** 分缝两侧这么宽不计（米）/ this far either side of the part is not counted (m) */
export const PART_HALF_WIDTH = 0.004

export function nearPart(f: HeadFrame, p: V3, partX: number, whorlZ: number): boolean {
  const l = toHead(f, p)
  return l[2] > whorlZ && Math.abs(l[0] - partX) < PART_HALF_WIDTH && l[1] > 0.03
}

/** 每种发型的淡入淡出（与 src/hair/layer.ts 的材质参数一致）/ per-style fades (as the material parameters in src/hair/layer.ts) */
export const FADES: Record<ScalpStyle, { root: number; tip: number }> = { short: { root: 0.12, tip: 0.8 }, long: { root: 0.015, tip: 0.6 } }

/**
 * 一种发型的遮盖率：用发布的发片（第 0 层）和贴图集（RGBA 字节），在头皮上每平方厘米取 3 个点。
 * Coverage of one style: from the shipped cards (level 0) and atlas (RGBA bytes), 3 points per cm² of scalp.
 */
export function styleCoverage(b: BodyData, f: HeadFrame, skin: Surface, scalp: Scalp, style: ScalpStyle, bin: Uint8Array, lod: HairLod, offsetUnit: number, rgba: Uint8Array, size: number): CoverageResult {
  const n = size * size
  const cov = new Float32Array(n), s = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    cov[i] = rgba[i * 4]! / 255
    s[i] = rgba[i * 4 + 1]! / 255
  }
  const d = decodeLod(bin, lod, offsetUnit, b.skin.positions.length / 3)
  const pos = new Float32Array(d.offset.length)
  placeVertices(d, b.skin.positions, pos)
  const rays = new CardRays({ positions: pos, uv: d.uv, index: d.index }, atlasSampler(cov, s, size), FADES[style].root, FADES[style].tip)
  const pts = scatter(b.skin.positions, b.normals, scalp.triangles, (p) => (scalp.density(p) > 0 ? 3e4 : 0), 5)
  const { views, all, samples } = scalpCoverage(f, skin, rays, pts, (p) => scalp.aboveHairline(p) < 0.006 || nearPart(f, p, PART[style], WHORL_Z))
  return { views, all, samples }
}
