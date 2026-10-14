// "腔"图层：把所有腔部件合成一个网格，用自己的材质画——双面（漫游时从里面看）、逐顶点颜色（按来历着色）。
// 腔部件自己的网格这时不画，但它们在共享缓冲里的几何照旧用于拾取。跟着部件一起变形（静止位移 + 蒙皮）。
// The lumina layer: all lumen parts merged into one mesh with a material of its own — double-sided (seen
// from the inside in the fly-through) and with per-vertex colours (tinted by origin). The parts' own meshes
// are not drawn meanwhile, though their geometry in the shared buffers still serves picking. It deforms
// with the parts (rest-space displacement + skinning).

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute } from 'three/tsl'
import type { PartBuffers } from './batches.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

interface Range {
  start: number
  count: number
  /** 部件内的三角形索引（从 0 起）/ the part's triangles, indices local to the part */
  index: Uint32Array
}

export class LumenLayer {
  readonly mesh: Mesh
  private readonly material: MeshStandardNodeMaterial
  private readonly ranges = new Map<number, Range>()
  private readonly position: BufferAttribute
  private readonly normal: BufferAttribute
  private readonly color: BufferAttribute
  private readonly skinIndex: BufferAttribute
  private readonly skinWeight: BufferAttribute
  private readonly indexAttr: BufferAttribute
  private shown = ''

  /** `parts`：部件下标和它在共享缓冲里的数据 / `parts`: part indices with their slices of the shared buffers. */
  constructor(
    private readonly skinning: SkinningData,
    parts: readonly { part: number; buffers: PartBuffers }[],
  ) {
    let vertices = 0
    let indices = 0
    for (const p of parts) {
      vertices += p.buffers.position.length / 3
      indices += p.buffers.index.length
    }
    this.position = new BufferAttribute(new Float32Array(vertices * 3), 3)
    this.normal = new BufferAttribute(new Float32Array(vertices * 3), 3)
    this.color = new BufferAttribute(new Float32Array(vertices * 3), 3)
    this.skinIndex = new BufferAttribute(new Uint16Array(vertices * 4), 4, true)
    this.skinWeight = new BufferAttribute(new Uint8Array(vertices * 4), 4, true)
    this.indexAttr = new BufferAttribute(new Uint32Array(Math.max(3, indices)), 1)
    let vo = 0
    for (const p of parts) {
      const b = p.buffers
      const count = b.position.length / 3
      const index = new Uint32Array(b.index.length)
      for (let i = 0; i < index.length; i++) index[i] = b.index[i]! - b.indexBase
      this.ranges.set(p.part, { start: vo, count, index })
      vo += count
      this.setPositions(p.part, b.position, b.normal)
      this.setInfluences(p.part, b.skinIndex, b.skinWeight)
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', this.position)
    geometry.setAttribute('normal', this.normal)
    geometry.setAttribute('color', this.color)
    geometry.setAttribute('skinIndex', this.skinIndex)
    geometry.setAttribute('skinWeight', this.skinWeight)
    geometry.setIndex(this.indexAttr)
    geometry.setDrawRange(0, 0)
    this.material = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 })
    this.material.colorNode = attribute('color', 'vec3')
    // 双面：从外面看是腔的外表面，漫游时从里面看是内表面；背面的法线由渲染器翻转，头灯照样照得到
    // double-sided: the outside of the lumen from outside, its inside in the fly-through; the renderer flips back-face normals, so the headlight still lights them
    this.material.side = DoubleSide
    this.mesh = new Mesh(geometry, this.material)
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.setSkinning('off')
  }

  has(part: number): boolean {
    return this.ranges.has(part)
  }

  get parts(): number[] {
    return [...this.ranges.keys()]
  }

  setPositions(part: number, position: ArrayLike<number>, normal: ArrayLike<number>): void {
    const r = this.ranges.get(part)
    if (!r) return
    ;(this.position.array as Float32Array).set(position as Float32Array, r.start * 3)
    ;(this.normal.array as Float32Array).set(normal as Float32Array, r.start * 3)
    this.position.needsUpdate = true
    this.normal.needsUpdate = true
  }

  setInfluences(part: number, index: Uint16Array, weight: Uint8Array): void {
    const r = this.ranges.get(part)
    if (!r) return
    ;(this.skinIndex.array as Uint16Array).set(index, r.start * 4)
    ;(this.skinWeight.array as Uint8Array).set(weight, r.start * 4)
    this.skinIndex.needsUpdate = true
    this.skinWeight.needsUpdate = true
  }

  /** 整个部件一种颜色（数据给出逐顶点的来历之后，可以改成逐顶点）/ One colour for the whole part (per-vertex once the data ships per-vertex origin). */
  setColor(part: number, r: number, g: number, b: number): void {
    const range = this.ranges.get(part)
    if (!range) return
    const out = this.color.array as Float32Array
    const o = range.start * 3
    if (out[o] === r && out[o + 1] === g && out[o + 2] === b) return
    for (let i = 0; i < range.count; i++) {
      out[o + i * 3] = r
      out[o + i * 3 + 1] = g
      out[o + i * 3 + 2] = b
    }
    this.color.needsUpdate = true
  }

  /** 只画这些部件；空集合就把图层藏起来 / Draw only these parts; an empty set hides the layer. */
  setShown(parts: readonly number[]): void {
    const key = parts.join(',')
    if (key !== this.shown) {
      this.shown = key
      const out = this.indexAttr.array as Uint32Array
      let io = 0
      for (const p of parts) {
        const r = this.ranges.get(p)
        if (!r) continue
        for (let i = 0; i < r.index.length; i++) out[io + i] = r.index[i]! + r.start
        io += r.index.length
      }
      this.indexAttr.needsUpdate = true
      this.mesh.geometry.setDrawRange(0, io)
      this.mesh.visible = io > 0
    }
  }

  get visible(): boolean {
    return this.mesh.visible
  }

  setSkinning(mode: SkinningMode): void {
    this.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.material.positionNode
    this.material.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
