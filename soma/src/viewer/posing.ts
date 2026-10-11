// 摆姿势的运行时状态：当前关节变换、着色器数据，以及摆姿势后做拾取所需的逐部件几何缓存。
// Runtime state of posing: current joint transforms, the shader data, and the per-part posed
// geometry cache that picking needs.
//
// 拾取的做法：GPU 上的顶点是变形后的，而 BVH 建在静止几何上。这里在需要时（射线的粗筛命中某个
// 部件时）用 CPU 参考实现把该部件的顶点算到当前姿势，并在其上建一棵 BVH，按姿势版本缓存。
// 刚体和蒙皮部件走同一条路，体型缩放和肌肉体积修正也就自然包含在内。
// How picking works: vertices are deformed on the GPU while BVHs are built on rest geometry.
// On demand (when a ray's broad phase reaches a part) the CPU reference poses that part's
// vertices and a BVH is built on them, cached per pose version. Rigid and skinned parts take
// the same route, so shape scales and the muscle correction are included for free.

import { BufferAttribute, BufferGeometry } from 'three/webgpu'
import { MeshBVH } from 'three-mesh-bvh'
import { Poser, type JointFrames } from '../../tools/rig/pose.ts'
import { jointFrames, packJoints, packMuscles, partJoints, posedBox, type LoadedRig, type Pose, type Scales } from '../anatomy/rig.ts'
import type { PartBuffers } from './batches.ts'

type Box = [number, number, number, number, number, number]

interface PosedPart {
  version: number
  positions: Float32Array
  bvh: MeshBVH | null
}

export class PoseRuntime {
  frames: JointFrames
  private poser: Poser
  /** 每次姿势或体型变化加一 / Bumped on every change of pose or shape. */
  version = 0
  pose: Pose = {}
  scales: Scales | null = null
  private jointData: Float32Array | undefined
  private muscleData: Float32Array | undefined
  private readonly joints = new Map<number, number[]>()
  private readonly localIndex = new Map<number, Uint32Array>()
  private readonly posed = new Map<number, PosedPart>()
  private readonly boxes = new Map<number, { version: number; box: Box; exact: boolean }>()

  constructor(
    readonly rig: LoadedRig,
    /** 部件索引 → 部件 id 与其缓冲；没有几何时为 null / Part index → its id and buffers; null without geometry. */
    private readonly buffers: (part: number) => { id: string; buffers: PartBuffers } | null,
  ) {
    this.frames = jointFrames(rig.rig.joints, {})
    this.poser = new Poser(rig.rig, rig.bin, {})
  }

  /** 设定显示的姿势；返回要写入着色器纹理的数据 / Set the displayed pose; returns the data for the shader textures. */
  set(pose: Pose, scales: Scales | null): { joints: Float32Array; muscles: Float32Array } {
    this.pose = pose
    this.scales = scales
    this.frames = jointFrames(this.rig.rig.joints, pose, scales ?? undefined)
    this.poser = new Poser(this.rig.rig, this.rig.bin, pose, scales ?? undefined)
    this.version++
    this.jointData = packJoints(this.frames, this.jointData)
    this.muscleData = packMuscles(this.rig, this.frames, this.muscleData)
    // 旧版本的缓存整体丢弃，免得内存随姿势变化累积
    // drop caches of older versions wholesale so memory does not grow with every pose
    this.posed.clear()
    return { joints: this.jointData, muscles: this.muscleData }
  }

  private jointsOf(part: number, id: string, vertexCount: number): number[] {
    let j = this.joints.get(part)
    if (!j) this.joints.set(part, (j = partJoints(this.rig, id, vertexCount)))
    return j
  }

  /**
   * 摆姿势后的包围盒（粗筛、取景用）：该部件的变形顶点已算出时是精确的，否则是近似的。
   * Posed bounding box (broad phase, framing): exact once the part's posed vertices exist,
   * approximate before that.
   */
  box(part: number, restBox: ArrayLike<number>): Box {
    const hit = this.boxes.get(part)
    const posed = this.posed.get(part)
    if (hit && hit.version === this.version && (hit.exact || !posed)) return hit.box
    if (posed) {
      const p = posed.positions
      const box: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let i = 0; i < p.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = p[i + c]!
          if (v < box[c]!) box[c] = v
          if (v > box[c + 3]!) box[c + 3] = v
        }
      }
      if (p.length === 0) box.fill(0)
      this.boxes.set(part, { version: this.version, box, exact: true })
      return box
    }
    const b = this.buffers(part)
    const box: Box = b
      ? posedBox(restBox, this.jointsOf(part, b.id, b.buffers.position.length / 3), this.frames.xfs)
      : [restBox[0]!, restBox[1]!, restBox[2]!, restBox[3]!, restBox[4]!, restBox[5]!]
    this.boxes.set(part, { version: this.version, box, exact: false })
    return box
  }

  /** 该部件的变形顶点是否已缓存 / Whether the part's posed vertices are cached. */
  has(part: number): boolean {
    return this.posed.has(part)
  }

  /** 部件在当前姿势下的顶点（CPU 参考实现，tapered 体积修正）/ A part's vertices in the current pose (CPU reference, tapered volume correction). */
  positions(part: number): Float32Array | null {
    const hit = this.posed.get(part)
    if (hit) return hit.positions
    const b = this.buffers(part)
    if (!b) return null
    const positions = this.poser.part(b.id, b.buffers.position, 'dqs', { mode: 'tapered' })
    this.posed.set(part, { version: this.version, positions, bvh: null })
    return positions
  }

  /** 建在当前姿势几何上的 BVH（三角形顺序与静止几何相同）/ A BVH on the posed geometry (same triangle order as at rest). */
  bvh(part: number): MeshBVH | null {
    const positions = this.positions(part)
    const entry = this.posed.get(part)
    const b = this.buffers(part)
    if (!positions || !entry || !b) return null
    if (entry.bvh) return entry.bvh
    let index = this.localIndex.get(part)
    if (!index) {
      const src = b.buffers.index
      index = new Uint32Array(src.length)
      for (let i = 0; i < src.length; i++) index[i] = src[i]! - b.buffers.indexBase
      this.localIndex.set(part, index)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.setIndex(new BufferAttribute(index, 1))
    entry.bvh = new MeshBVH(g, { indirect: true })
    return entry.bvh
  }
}
