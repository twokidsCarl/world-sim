// 写实模式的毛发层：头发（短或长）、眉毛、睫毛的发片。数据只在写实外观显示时才去取；每块发片按相机距离换细节层次。
// 它像别的覆盖层一样经 Viewer.addFollower 跟随皮肤：每张发片的根按重心坐标钉在皮肤三角形上，体型、表情、软组织偏移都跟着；
// 蒙皮的影响照抄根所在三角形里权重最大的皮肤顶点，所以摆姿势时整张发片随头（或那块皮肤）刚性地走。
// The lifelike-mode hair layer: cards for scalp hair (short or long), eyebrows and eyelashes. The data are fetched only
// once the lifelike look shows; each piece switches level of detail by camera distance.
// Like the other overlays it follows the skin through Viewer.addFollower: each card's root is pinned to a skin triangle
// by barycentric weights, so shape, expression and soft-tissue offsets carry it along; skinning influences are copied
// from the root triangle's highest-weight skin vertex, so in a pose the whole card moves rigidly with the head (or that
// patch of skin).

import { BufferAttribute, BufferGeometry, Group, LinearFilter, LinearMipmapLinearFilter, LOD, Mesh, NoColorSpace, Texture, Vector3, type MeshLambertNodeMaterial, type MeshStandardNodeMaterial } from 'three/webgpu'
import type { HairData, HairPieceId, HairStyle } from '../look/types.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import { type DecodedLod, decodeLod, dominantVertex, placeVertices } from './cards.ts'
import type { HairColour } from './colour.ts'
import { loadAtlasImage, loadHairData, loadPiece, loadScalp } from './load.ts'
import { HairLook, makeHairMaterial, makeScalpTintMaterial, type HairMaterialOptions } from './material.ts'
import { SkinPatch } from '../viewer/skinPatch.ts'
import type { SkinGeometry } from '../viewer/skinLayer.ts'

type MaterialKind = 'short' | 'long' | 'brow' | 'lash'
const KIND_OF: Record<HairPieceId, MaterialKind> = { short: 'short', long: 'long', brows: 'brow', lashes: 'lash' }
/** 材质参数（都是假设，按观感定）/ material parameters (all assumed, set by eye) */
const MATERIAL: Record<MaterialKind, HairMaterialOptions> = {
  // 根端淡入按发片长度的比例：短发约 5 毫米，长发约 6 毫米 / the root fade is a fraction of the card length: about 5 mm for short hair, 6 mm for long
  short: { roughness: 0.32, scatter: 0.8, rootShadow: 0.25, pigment: 1, rootFade: 0.12, tipFade: 0.8 },
  long: { roughness: 0.32, scatter: 0.8, rootShadow: 0.4, pigment: 1, rootFade: 0.015, tipFade: 0.6 },
  brow: { roughness: 0.4, scatter: 0.6, rootShadow: 0.2, pigment: 1.2, rootFade: 0, tipFade: 0 },
  lash: { roughness: 0.35, scatter: 0.5, rootShadow: 0, pigment: 1.6, rootFade: 0, tipFade: 0 },
}

interface Piece {
  id: HairPieceId
  lod: LOD
  levels: { d: DecodedLod; geometry: BufferGeometry; mesh: Mesh }[]
}

export interface HairSettings {
  show: boolean
  /** null = 这副人体的默认 / null = this body's default */
  style: HairStyle | null
  colour: HairColour
}

export class HairLayer {
  /** 跟随皮肤的接口（Viewer.addFollower 用）/ the follower interface (used by Viewer.addFollower) */
  readonly patch: {
    mesh: Group
    setPositions: (position: ArrayLike<number>, normal: ArrayLike<number>) => void
    setInfluences: (index: Uint16Array, weight: Uint8Array) => void
    setOffset: (x: number, y: number, z: number) => void
  }
  readonly look = new HairLook()
  private readonly group = new Group()
  private data: HairData | null = null
  private dataLoad: Promise<HairData | null> | null = null
  private atlas: { a: Texture; b: Texture } | null = null
  private atlasLoad: Promise<void> | null = null
  private readonly pieces = new Map<HairPieceId, Piece>()
  private readonly loading = new Set<HairPieceId>()
  private readonly materials = new Map<MaterialKind, MeshStandardNodeMaterial>()
  /** 头皮底色（跟着皮肤的一块覆盖网格）/ the scalp tint (an overlay patch following the skin) */
  private tint: { patch: SkinPatch; material: MeshLambertNodeMaterial } | null = null
  private skinPos: ArrayLike<number> | null = null
  private skinNormal: ArrayLike<number> | null = null
  private influence: { index: Uint16Array; weight: Uint8Array } | null = null
  private mode: SkinningMode = 'off'
  private settings: HairSettings = { show: false, style: null, colour: 'darkbrown' }
  private failed = false
  private disposed = false

  constructor(
    /** 这副人体的 hair/ 目录的地址 / the address of this body's hair/ directory */
    private readonly base: string,
    /** 皮肤的静止几何（头皮底色用它建覆盖网格）/ the skin's rest geometry (the scalp tint builds its patch from it) */
    private readonly skin: SkinGeometry,
    private readonly skinning: SkinningData,
    /** 有东西变了（数据到了、可见性变了）：要重画，被藏的外壳也可能变了 / something changed (data arrived, visibility changed): redraw; the hidden shells may have changed too */
    private readonly onChange: () => void,
  ) {
    this.group.name = 'lifelike-hair'
    this.group.matrixAutoUpdate = false
    this.group.visible = false
    this.patch = {
      mesh: this.group,
      setPositions: (p, n) => {
        this.skinPos = p
        this.skinNormal = n
        this.placeTint()
        for (const piece of this.pieces.values()) for (const l of piece.levels) this.place(l)
      },
      setInfluences: (index, weight) => {
        this.influence = { index, weight }
        this.tint?.patch.setInfluences(index, weight)
        for (const piece of this.pieces.values()) for (const l of piece.levels) this.influence_(l)
      },
      setOffset: (x, y, z) => {
        this.group.matrix.makeTranslation(x, y, z)
        this.group.matrixWorldNeedsUpdate = true
      },
    }
  }

  /** 这副人体的默认发型（数据到了以后才知道）/ this body's default style (known once the data arrive) */
  get defaultStyle(): Exclude<HairStyle, 'none'> | null {
    return this.data?.defaultStyle ?? null
  }

  /** 毛发正在替代的外壳部件（写实模式下要藏起来）/ the shell parts the hair currently replaces (to be hidden in lifelike mode) */
  /** 实际的发型：没指定就用默认；数据还没到为 null / the effective style: the default when none is given; null before the data arrive */
  private style(): HairStyle | null {
    return this.settings.style ?? this.data?.defaultStyle ?? null
  }

  covers(): string[] {
    if (!this.settings.show || !this.data) return []
    const [hairShell, browShell] = this.data.hides
    const out: string[] = []
    const style = this.style()
    if (hairShell && style && (style === 'none' || this.pieces.has(style))) out.push(hairShell)
    if (browShell && this.pieces.has('brows')) out.push(browShell)
    return out
  }

  /** 统计（验证用）/ statistics (verification) */
  info(): { show: boolean; style: HairStyle | null; colour: HairColour; pieces: Record<string, { level: number; cards: number[]; triangles: number[] }>; covers: string[]; failed: boolean } {
    const pieces: Record<string, { level: number; cards: number[]; triangles: number[] }> = {}
    for (const p of this.pieces.values()) {
      pieces[p.id] = { level: p.lod.getCurrentLevel(), cards: p.levels.map((l) => l.d.cards), triangles: p.levels.map((l) => l.d.index.length / 3) }
    }
    return { show: this.settings.show, style: this.style(), colour: this.settings.colour, pieces, covers: this.covers(), failed: this.failed }
  }

  set(s: HairSettings): void {
    const before = this.covers().join()
    this.settings = s
    if (this.look.set(s.colour)) this.onChange()
    if (s.show && !this.failed) void this.ensureAll()
    this.updateVisibility()
    if (this.covers().join() !== before) this.onChange()
  }

  private get skinVertexCount(): number {
    return this.skin.position.length / 3
  }

  setSkinning(mode: SkinningMode): void {
    this.mode = mode
    if (this.tint) {
      this.tint.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.tint.material.positionNode
      this.tint.material.needsUpdate = true
    }
    for (const m of this.materials.values()) {
      m.positionNode = positionNodeFor(this.skinning, mode, false) as typeof m.positionNode
      m.needsUpdate = true
    }
  }

  private wanted(): HairPieceId[] {
    const out: HairPieceId[] = ['brows', 'lashes']
    const style = this.style()
    if (style && style !== 'none') out.unshift(style)
    return out
  }

  private updateVisibility(): void {
    const want = new Set(this.wanted())
    let changed = this.group.visible !== this.settings.show
    this.group.visible = this.settings.show
    for (const p of this.pieces.values()) {
      const v = want.has(p.id)
      if (p.lod.visible !== v) {
        p.lod.visible = v
        changed = true
      }
    }
    // 头皮底色只在有头发、头发已经到了时画 / the scalp tint shows only with scalp hair, once it has arrived
    const style = this.style()
    const tintOn = !!style && style !== 'none' && this.pieces.has(style)
    if (this.tint && this.tint.patch.mesh.visible !== tintOn) {
      this.tint.patch.mesh.visible = tintOn
      changed = true
    }
    if (changed) this.onChange()
  }

  private async ensureAll(): Promise<void> {
    try {
      this.dataLoad ??= loadHairData(this.base)
      this.data = await this.dataLoad
      if (!this.data || this.disposed) return
      if (this.data.skinVertexCount !== this.skinVertexCount) {
        console.warn(`[soma] hair rejected: it is for ${this.data.skinVertexCount} skin vertices, the skin has ${this.skinVertexCount}`)
        this.failed = true
        return
      }
      this.atlasLoad ??= this.loadAtlas(this.data)
      await this.atlasLoad
      if (!this.atlas || this.disposed) return
      await Promise.all([...this.wanted().map((id) => this.ensurePiece(id)), this.ensureTint()])
      this.updateVisibility()
    } catch (e) {
      // 毛发是附加的：坏了就照旧用外壳 / the hair is an extra: when broken the shells stay
      console.warn('[soma] hair failed to load', e)
      this.failed = true
      this.onChange()
    }
  }

  private async loadAtlas(data: HairData): Promise<void> {
    const [a, b] = await Promise.all([loadAtlasImage(this.base, data.atlas.a), loadAtlasImage(this.base, data.atlas.b)])
    if (!a || !b) throw new Error('hair atlas missing')
    const tex = (img: ImageBitmap): Texture => {
      const t = new Texture(img)
      t.flipY = false
      t.colorSpace = NoColorSpace
      t.generateMipmaps = true
      t.minFilter = LinearMipmapLinearFilter
      t.magFilter = LinearFilter
      t.anisotropy = 4
      t.needsUpdate = true
      return t
    }
    this.atlas = { a: tex(a), b: tex(b) }
  }

  private material(kind: MaterialKind): MeshStandardNodeMaterial {
    let m = this.materials.get(kind)
    if (!m) {
      m = makeHairMaterial(this.look, this.atlas!.a, this.atlas!.b, this.data!.atlas.size, MATERIAL[kind])
      m.positionNode = positionNodeFor(this.skinning, this.mode, false) as typeof m.positionNode
      this.materials.set(kind, m)
    }
    return m
  }

  private tintLoad: Promise<void> | null = null

  private ensureTint(): Promise<void> {
    this.tintLoad ??= (async () => {
      const sc = await loadScalp(this.base, this.data!)
      if (!sc || this.disposed) return
      const material = makeScalpTintMaterial(this.look)
      material.positionNode = positionNodeFor(this.skinning, this.mode, false) as typeof material.positionNode
      const patch = new SkinPatch(this.skin, sc.vertices, material)
      const dist = new Float32Array(this.skinVertexCount).fill(-127)
      sc.vertices.forEach((v, i) => (dist[v] = sc.distance[i]!))
      patch.setAttribute('aScalp', dist, 1)
      this.tint = { patch, material }
      this.placeTint()
      if (this.influence) patch.setInfluences(this.influence.index, this.influence.weight)
      patch.mesh.name = 'hair-scalp-tint'
      patch.mesh.renderOrder = 1
      this.group.add(patch.mesh)
    })()
    return this.tintLoad
  }

  private tintPos: Float32Array | null = null

  /**
   * 头皮底色放在皮肤外 0.25 毫米：只靠多边形偏移时，它和写实皮肤层的深度比较在一些角度下会输（分缝里露出皮肤）。
   * The scalp tint sits 0.25 mm outside the skin: with polygon offset alone its depth test against the lifelike skin layer
   * loses at some angles (skin shows in the part).
   */
  private placeTint(): void {
    if (!this.tint || !this.skinPos || !this.skinNormal) return
    const p = this.skinPos, n = this.skinNormal
    if (!this.tintPos || this.tintPos.length !== p.length) this.tintPos = new Float32Array(p.length)
    for (let i = 0; i < p.length; i++) this.tintPos[i] = p[i]! + n[i]! * 0.00025
    this.tint.patch.setPositions(this.tintPos, n)
  }

  private async ensurePiece(id: HairPieceId): Promise<void> {
    if (this.pieces.has(id) || this.loading.has(id) || !this.data) return
    this.loading.add(id)
    const bin = await loadPiece(this.base, this.data, id)
    this.loading.delete(id)
    if (!bin || this.disposed) return
    const spec = this.data.pieces.find((p) => p.id === id)!
    const lod = new LOD()
    lod.name = `hair-${id}`
    const levels = spec.lods.map((l, i) => {
      const d = decodeLod(bin, l, this.data!.offsetUnit, this.skinVertexCount)
      const geometry = new BufferGeometry()
      const V = d.offset.length / 3
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(V * 3), 3))
      // "法线"属性里放发丝走向：蒙皮按法线旋转它 / the "normal" attribute holds the strand direction: skinning rotates it like a normal
      geometry.setAttribute('normal', new BufferAttribute(d.tangent, 3))
      geometry.setAttribute('uv', new BufferAttribute(d.uv, 2))
      geometry.setAttribute('aLayer', new BufferAttribute(d.layer, 1))
      geometry.setAttribute('aRandom', new BufferAttribute(d.random, 1))
      geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(V * 4), 4, true))
      geometry.setAttribute('skinWeight', new BufferAttribute(new Uint8Array(V * 4), 4, true))
      geometry.setIndex(new BufferAttribute(d.index, 1))
      const mesh = new Mesh(geometry, this.material(KIND_OF[id]))
      mesh.frustumCulled = false
      mesh.name = `hair-${id}-lod${i}`
      const level = { d, geometry, mesh }
      this.place(level)
      this.influence_(level)
      lod.addLevel(mesh, i === 0 ? 0 : spec.lods[i - 1]!.maxDistance)
      return level
    })
    // LOD 按它自己的位置量距离：放在根的中心，网格反向挪回 / LOD measures distance from its own position: put it at the centre of the roots and shift the meshes back
    const c = this.rootCentre(levels[0]!.d)
    lod.position.copy(c)
    for (const l of levels) l.mesh.position.copy(c).multiplyScalar(-1)
    this.pieces.set(id, { id, lod, levels })
    this.group.add(lod)
    this.updateVisibility()
    this.onChange()
  }

  private rootCentre(d: DecodedLod): Vector3 {
    const c = new Vector3()
    if (!this.skinPos || d.cards === 0) return c
    const tmp = new Float32Array(d.offset.length)
    placeVertices(d, this.skinPos, tmp)
    for (let i = 0; i < tmp.length; i += 3) c.x += tmp[i]!, (c.y += tmp[i + 1]!), (c.z += tmp[i + 2]!)
    return c.multiplyScalar(3 / tmp.length)
  }

  private place(l: { d: DecodedLod; geometry: BufferGeometry }): void {
    if (!this.skinPos) return
    const attr = l.geometry.getAttribute('position') as BufferAttribute
    placeVertices(l.d, this.skinPos, attr.array as Float32Array)
    attr.needsUpdate = true
  }

  private influence_(l: { d: DecodedLod; geometry: BufferGeometry }): void {
    if (!this.influence) return
    const { index, weight } = this.influence
    const si = l.geometry.getAttribute('skinIndex') as BufferAttribute, sw = l.geometry.getAttribute('skinWeight') as BufferAttribute
    const di = si.array as Uint16Array, dw = sw.array as Uint8Array
    const per = l.d.rings * 2
    for (let c = 0; c < l.d.cards; c++) {
      const v = dominantVertex(l.d, c)
      for (let j = 0; j < per; j++) {
        const o = (c * per + j) * 4
        for (let k = 0; k < 4; k++) {
          di[o + k] = index[v * 4 + k]!
          dw[o + k] = weight[v * 4 + k]!
        }
      }
    }
    si.needsUpdate = true
    sw.needsUpdate = true
  }

  dispose(): void {
    this.disposed = true
    for (const p of this.pieces.values()) for (const l of p.levels) l.geometry.dispose()
    for (const m of this.materials.values()) m.dispose()
    this.tint?.patch.dispose()
    this.tint?.material.dispose()
    this.atlas?.a.dispose()
    this.atlas?.b.dispose()
    this.pieces.clear()
  }
}
