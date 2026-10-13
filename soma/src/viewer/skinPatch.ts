// 贴在皮肤上的一块覆盖网格：皮肤的全部或一部分顶点，自己的一份几何，跟着皮肤一起变形（静止位移 + 蒙皮）。
// 皱纹细节层（只有面部）和疼痛分布层（整张皮肤）都用它；材质由使用者给。
// An overlay mesh lying on the skin: all or some of the skin's vertices in a geometry of its own
// that deforms with the skin (rest-space displacement + skinning). The wrinkle detail layer (face
// only) and the pain map layer (whole skin) both use it; the owner supplies the material.

import { BufferAttribute, BufferGeometry, Mesh, type Material } from 'three/webgpu'
import type { SkinGeometry } from './skinLayer.ts'

export class SkinPatch {
  readonly mesh: Mesh
  /** 覆盖网格的顶点 → 皮肤顶点 / Patch vertex → skin vertex. */
  readonly vertices: Uint32Array
  readonly triangleCount: number
  private readonly position: BufferAttribute
  private readonly normal: BufferAttribute
  private readonly skinIndex: BufferAttribute
  private readonly skinWeight: BufferAttribute

  /**
   * `subset`：要包含的皮肤顶点（升序）；null 为全部。只保留三个顶点都在其中的三角形。
   * `triangles`：改为直接给出三角形（展平的皮肤顶点下标），顶点就是它们用到的那些。
   * `subset`: the skin vertices to include (ascending); null = all. Only triangles with all three vertices inside are kept.
   * `triangles`: give the triangles directly instead (flat skin vertex indices); the vertices are the ones they use.
   */
  constructor(source: SkinGeometry, subset: Uint32Array | null, material: Material, triangles?: ArrayLike<number>) {
    const total = source.position.length / 3
    const index = triangles ?? source.index
    const vertices = triangles ? Uint32Array.from(new Set(Array.from(triangles))).sort() : (subset ?? Uint32Array.from({ length: total }, (_, i) => i))
    this.vertices = vertices
    const local = new Int32Array(total).fill(-1)
    vertices.forEach((v, i) => (local[v] = i))
    const kept: number[] = []
    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = local[index[t]!]!, b = local[index[t + 1]!]!, c = local[index[t + 2]!]!
      if (a >= 0 && b >= 0 && c >= 0) kept.push(a, b, c)
    }
    this.triangleCount = kept.length / 3
    const n = vertices.length
    this.position = new BufferAttribute(new Float32Array(n * 3), 3)
    this.normal = new BufferAttribute(new Float32Array(n * 3), 3)
    this.skinIndex = new BufferAttribute(new Uint16Array(n * 4), 4, true)
    this.skinWeight = new BufferAttribute(new Uint8Array(n * 4), 4, true)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', this.position)
    geometry.setAttribute('normal', this.normal)
    geometry.setAttribute('skinIndex', this.skinIndex)
    geometry.setAttribute('skinWeight', this.skinWeight)
    geometry.setIndex(new BufferAttribute(Uint32Array.from(kept), 1))
    this.mesh = new Mesh(geometry, material)
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.setPositions(source.position, source.normal)
  }

  /** 加一个逐顶点属性；`perSkinVertex` 按皮肤顶点顺序给出 / Add a per-vertex attribute given in skin-vertex order. */
  setAttribute(name: string, perSkinVertex: ArrayLike<number>, itemSize: number): BufferAttribute {
    let a = this.mesh.geometry.getAttribute(name) as BufferAttribute | undefined
    if (!a) {
      a = new BufferAttribute(new Float32Array(this.vertices.length * itemSize), itemSize)
      this.mesh.geometry.setAttribute(name, a)
    }
    const out = a.array as Float32Array
    this.vertices.forEach((v, i) => {
      for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = perSkinVertex[v * itemSize + k]!
    })
    a.needsUpdate = true
    return a
  }

  /** 皮肤的静止位置（和法线）变了：按皮肤顶点顺序给出 / The skin's rest positions (and normals) changed: given in skin-vertex order. */
  setPositions(position: ArrayLike<number>, normal: ArrayLike<number>): void {
    const p = this.position.array as Float32Array, q = this.normal.array as Float32Array
    this.vertices.forEach((v, i) => {
      p[i * 3] = position[v * 3]!
      p[i * 3 + 1] = position[v * 3 + 1]!
      p[i * 3 + 2] = position[v * 3 + 2]!
      q[i * 3] = normal[v * 3]!
      q[i * 3 + 1] = normal[v * 3 + 1]!
      q[i * 3 + 2] = normal[v * 3 + 2]!
    })
    this.position.needsUpdate = true
    this.normal.needsUpdate = true
  }

  /** 皮肤部件的逐顶点影响（按皮肤顶点顺序）/ The skin part's per-vertex influences (in skin-vertex order). */
  setInfluences(index: Uint16Array, weight: Uint8Array): void {
    const di = this.skinIndex.array as Uint16Array, dw = this.skinWeight.array as Uint8Array
    this.vertices.forEach((v, i) => {
      for (let k = 0; k < 4; k++) {
        di[i * 4 + k] = index[v * 4 + k]!
        dw[i * 4 + k] = weight[v * 4 + k]!
      }
    })
    this.skinIndex.needsUpdate = true
    this.skinWeight.needsUpdate = true
  }

  setOffset(x: number, y: number, z: number): void {
    this.mesh.matrix.makeTranslation(x, y, z)
    this.mesh.matrixWorldNeedsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
  }
}
