// 体表图图层：打开体表图时，皮肤改由这一张独立的网格绘制。
// Skin map layer: while a skin map is on, the skin is drawn by this separate mesh.
//
// 颜色如何保持"平"：数据是每个顶点一个区域索引。若把颜色放在共享顶点上，三角形内部会
// 在两个区域的颜色之间渐变。这里把皮肤展开成不共享顶点的网格（每个三角形三个独立顶点），
// 三个顶点都写入该三角形的区域颜色（三顶点中占多数的区域），所以区域边界沿三角形的边、
// 没有混色；法线仍用原来的逐顶点法线，光照保持平滑。两种渲染后端做法相同，不依赖
// flat 插值或 provoking vertex。
// How the colour stays flat: the data is one region index per vertex. With shared vertices the
// colour would blend across a triangle between two regions. The skin is therefore expanded
// to an unshared-vertex mesh (three own vertices per triangle) and all three get the colour
// of the triangle's region (the majority of its three vertices), so boundaries follow triangle
// edges with no blending; normals are still the original per-vertex normals, so shading stays
// smooth. Identical on both backends, with no reliance on flat interpolation or the provoking vertex.

import { BufferAttribute, BufferGeometry, Color, DoubleSide, FrontSide, Mesh, MeshStandardNodeMaterial } from 'three/webgpu'
import { attribute, diffuseColor, frontFacing, output, select, vec4 } from 'three/tsl'
import { SKIN_UNASSIGNED, triangleRegions, type LoadedSkinMap } from '../anatomy/skinmaps.ts'

/** 皮肤部件烘焙后的几何（世界坐标，顶点顺序与 GLB 解码顺序一致）。 */
/** A skin part's baked geometry (world space, vertices in GLB decode order). */
export interface SkinGeometry {
  position: Float32Array
  normal: Float32Array
  index: Uint32Array
}

export interface SkinLayerState {
  map: LoadedSkinMap
  /** 高亮的区域；为空表示全部正常显示 / Highlighted regions; empty = all shown normally. */
  selected: readonly number[]
  hover: number | null
  /** 半透明：未选中的区域几乎透明，选中的保持可见 / See-through: unselected regions nearly clear. */
  seeThrough: boolean
}

const UNASSIGNED_COLOR = new Color('#8d99a6')
const DIM_TOWARDS = new Color('#59616b')

export class SkinLayer {
  readonly mesh: Mesh
  private readonly opaque: MeshStandardNodeMaterial
  private readonly clear: MeshStandardNodeMaterial
  private readonly color: BufferAttribute
  private readonly triangleCount: number
  private regions: Uint8Array | null = null
  private regionsOf: LoadedSkinMap | null = null
  private capped = false

  constructor(private readonly source: SkinGeometry) {
    const tris = Math.floor(source.index.length / 3)
    this.triangleCount = tris
    const position = new Float32Array(tris * 9)
    const normal = new Float32Array(tris * 9)
    for (let i = 0; i < tris * 3; i++) {
      const v = source.index[i]! * 3
      position[i * 3] = source.position[v]!
      position[i * 3 + 1] = source.position[v + 1]!
      position[i * 3 + 2] = source.position[v + 2]!
      normal[i * 3] = source.normal[v]!
      normal[i * 3 + 1] = source.normal[v + 1]!
      normal[i * 3 + 2] = source.normal[v + 2]!
    }
    this.color = new BufferAttribute(new Float32Array(tris * 12), 4)
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(position, 3))
    geometry.setAttribute('normal', new BufferAttribute(normal, 3))
    geometry.setAttribute('color', this.color)
    geometry.computeBoundingSphere()

    const rgba = attribute('color', 'vec4')
    this.opaque = new MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 })
    this.opaque.colorNode = rgba
    // 剖切时背面写成纯色，切口看起来是实心的（与其他部件一致）
    // with a section on, back faces are written flat so the cut reads as filled (as for other parts)
    this.opaque.outputNode = select(frontFacing, output, vec4(diffuseColor.rgb.mul(0.72), output.a))
    this.clear = new MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 })
    this.clear.colorNode = rgba
    this.clear.transparent = true
    this.clear.depthWrite = false

    this.mesh = new Mesh(geometry, this.opaque)
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.renderOrder = 1
  }

  /** 区域索引对应的三角形是否与体表图顶点数一致 / Whether a map fits this skin mesh. */
  fits(vertexCount: number): boolean {
    return vertexCount * 3 === this.source.position.length
  }

  /** 命中三角形所属的区域；无体表图时为 null / Region of a hit triangle; null without a map. */
  regionOfFace(faceIndex: number): number | null {
    const r = this.regions?.[faceIndex]
    return r === undefined || r === SKIN_UNASSIGNED ? null : r
  }

  /** 按状态重写每个三角形的颜色；null 表示隐藏图层 / Repaint from state; null hides the layer. */
  update(state: SkinLayerState | null): void {
    if (!state) {
      this.mesh.visible = false
      return
    }
    const { map, selected, hover, seeThrough } = state
    if (this.regionsOf !== map) {
      this.regions = triangleRegions(this.source.index, map.data)
      this.regionsOf = map
    }
    const regions = this.regions!
    const palette = map.regions.map((r) => new Color(r.color))
    const isSelected = new Uint8Array(map.regions.length)
    for (const r of selected) if (r < isSelected.length) isSelected[r] = 1
    const anySelected = selected.length > 0
    const out = this.color.array as Float32Array
    const c = new Color()
    for (let t = 0; t < this.triangleCount; t++) {
      const r = regions[t]!
      const known = r !== SKIN_UNASSIGNED
      c.copy(known ? palette[r]! : UNASSIGNED_COLOR)
      const on = known && isSelected[r] === 1
      let alpha = 1
      if (seeThrough) alpha = on ? 0.5 : 0.07
      // 有选中区域时，其余区域压暗以突出选中的
      // with a selection, the other regions are dimmed so the selected ones stand out
      if (anySelected && !on) c.lerp(DIM_TOWARDS, 0.78)
      if (known && r === hover) c.lerp(WHITE, 0.3)
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * 4
        out[o] = c.r
        out[o + 1] = c.g
        out[o + 2] = c.b
        out[o + 3] = alpha
      }
    }
    this.color.needsUpdate = true
    const material = seeThrough ? this.clear : this.opaque
    if (this.mesh.material !== material) this.mesh.material = material
    this.mesh.visible = true
  }

  setOffset(x: number, y: number, z: number): void {
    this.mesh.matrix.makeTranslation(x, y, z)
    this.mesh.matrixWorldNeedsUpdate = true
  }

  setCapped(on: boolean): void {
    if (this.capped === on) return
    this.capped = on
    this.opaque.side = on ? DoubleSide : FrontSide
    this.opaque.needsUpdate = true
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.opaque.dispose()
    this.clear.dispose()
  }
}

const WHITE = new Color(0xffffff)
