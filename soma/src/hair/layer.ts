// 写实模式的毛发层：头发（短或长）、眉毛、睫毛的发片。数据只在写实外观显示时才去取；每块发片按相机距离换细节层次。
// 它像别的覆盖层一样经 Viewer.addFollower 跟随皮肤：每张发片的根按重心坐标钉在皮肤三角形上，体型、表情、软组织偏移都跟着；
// 蒙皮的影响照抄根所在三角形里权重最大的皮肤顶点，所以摆姿势时整张发片随头（或那块皮肤）刚性地走。
// The lifelike-mode hair layer: cards for scalp hair (short or long), eyebrows and eyelashes. The data are fetched only
// once the lifelike look shows; each piece switches level of detail by camera distance.
// Like the other overlays it follows the skin through Viewer.addFollower: each card's root is pinned to a skin triangle
// by barycentric weights, so shape, expression and soft-tissue offsets carry it along; skinning influences are copied
// from the root triangle's highest-weight skin vertex, so in a pose the whole card moves rigidly with the head (or that
// patch of skin).

import { BufferAttribute, BufferGeometry, type DataTexture, Group, LinearFilter, LinearMipmapLinearFilter, LOD, Mesh, NoColorSpace, Texture, Vector3, type MeshLambertNodeMaterial, type MeshStandardNodeMaterial } from 'three/webgpu'
import type { BeardStyle, HairData, HairPieceId, HairStrandsInfo, HairStyle } from '../look/types.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import { type DecodedLod, decodeLod, dominantVertex, placeVertices } from './cards.ts'
import type { HairColour } from './colour.ts'
import { loadAtlasImage, loadHairData, loadMask, loadPiece, loadScalp, loadStrandFile } from './load.ts'
import { HairDynamics } from './dynamicsHost.ts'
import { Fn, attribute as tslAttribute, positionGeometry, positionLocal } from 'three/tsl'
import { buildStrands, type DecodedGuides, decodeGuides, makeStrandMaterial, placeRoots, rootTexture, type StrandGeometry } from './strands.ts'
import { HairLook, makeHairMaterial, makeScalpTintMaterial, makeStubbleMaterial, type HairMaterialOptions } from './material.ts'
import { SkinPatch } from '../viewer/skinPatch.ts'
import type { SkinGeometry } from '../viewer/skinLayer.ts'

type MaterialKind = 'short' | 'long' | 'brow' | 'lash' | 'beard' | 'body'
const KIND_OF: Record<HairPieceId, MaterialKind> = { short: 'short', long: 'long', brows: 'brow', lashes: 'lash', beard: 'beard', pubic: 'body', axilla: 'body' }
/** 盖住阴毛、腋窝的衣服：盖住时不画那里的毛（游戏的做法，免得从紧身裤里扎出来）/ garments covering the pubic area and the axillae: hair there is not drawn under them (as games do, so none pokes through tights) */
const PUBIC_COVER = ['pants', 'tights', 'skirt']
const AXILLA_COVER = ['tee', 'compression-top']
/** 材质参数（都是假设，按观感定）/ material parameters (all assumed, set by eye) */
const MATERIAL: Record<MaterialKind, HairMaterialOptions> = {
  // 根端淡入按发片长度的比例：短发约 5 毫米，长发约 6 毫米 / the root fade is a fraction of the card length: about 5 mm for short hair, 6 mm for long
  short: { roughness: 0.42, scatter: 0.8, rootShadow: 0.25, pigment: 1, rootFade: 0.12, tipFade: 0.8, layerShadow: 0.1 },
  long: { roughness: 0.48, scatter: 0.8, rootShadow: 0.4, pigment: 1, rootFade: 0.015, tipFade: 0.6, layerShadow: 0.3 },
  brow: { roughness: 0.4, scatter: 0.6, rootShadow: 0.2, pigment: 1.2, rootFade: 0, tipFade: 0, layerShadow: 0 },
  lash: { roughness: 0.35, scatter: 0.5, rootShadow: 0, pigment: 1.6, rootFade: 0, tipFade: 0, layerShadow: 0 },
  beard: { roughness: 0.45, scatter: 0.6, rootShadow: 0.15, pigment: 1.1, rootFade: 0, tipFade: 0.3, layerShadow: 0 },
  body: { roughness: 0.5, scatter: 0.6, rootShadow: 0.3, pigment: 1.15, rootFade: 0, tipFade: 0.4, layerShadow: 0 },
}

interface Piece {
  id: HairPieceId
  lod: LOD
  levels: { d: DecodedLod; geometry: BufferGeometry; mesh: Mesh }[]
  /** 近景真发丝（只在 WebGPU 上）/ close-up real strands (WebGPU only) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  strands?: { d: DecodedGuides; built: StrandGeometry; mesh: Mesh; roots: DataTexture; setSkinning: (s: SkinningData, m: SkinningMode, disp?: ((along: any, sim: any) => any) | null) => void }
}

export interface HairSettings {
  show: boolean
  /** null = 这副人体的默认 / null = this body's default */
  style: HairStyle | null
  colour: HairColour
  /** 胡须（只有有胡须数据的人体）/ facial hair (only bodies with beard data) */
  beard: BeardStyle
  /** 穿着的衣服 / the garments worn */
  wear: readonly string[]
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
  private settings: HairSettings = { show: false, style: null, colour: 'darkbrown', beard: 'none', wear: [] }
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
    /** 近景用真发丝（WebGPU）/ real strands for close-ups (WebGPU) */
    private readonly strandsEnabled = false,
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
        for (const piece of this.pieces.values()) {
          for (const l of piece.levels) this.place(l)
          if (piece.strands) placeRoots(piece.strands.d, p, piece.strands.roots)
        }
        this.dyn?.host.setRest(p)
      },
      setInfluences: (index, weight) => {
        this.influence = { index, weight }
        this.tint?.patch.setInfluences(index, weight)
        this.stubble?.patch.setInfluences(index, weight)
        for (const piece of this.pieces.values()) {
          for (const l of piece.levels) this.influence_(l)
          if (piece.strands) this.strandInfluence(piece.strands)
        }
        // 关节行要从影响里取：动力学按新的影响重建 / joint rows come from the influences: rebuild the dynamics with the new ones
        if (this.dyn) {
          const piece = this.pieces.get(this.dyn.piece)
          this.dropDynamics()
          if (piece) void this.ensureDynamics(piece)
        }
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
    // 阴毛外壳：毛发到了就藏（被衣服盖住时也藏，免得外壳从紧身裤里露出来）/ the pubic shell: hidden once the hair has arrived (also under clothes, so the shell does not show through tights)
    const pubicShell = this.data.hides[2]
    if (pubicShell && this.pieces.has('pubic')) out.push(pubicShell)
    return out
  }

  /** 统计（验证用）/ statistics (verification) */
  info(): { show: boolean; style: HairStyle | null; colour: HairColour; pieces: Record<string, { level: number; cards: number[]; triangles: number[]; strands?: number; strandTriangles?: number }>; covers: string[]; failed: boolean } {
    const pieces: Record<string, { level: number; cards: number[]; triangles: number[]; strands?: number; strandTriangles?: number }> = {}
    for (const p of this.pieces.values()) {
      pieces[p.id] = { level: p.lod.getCurrentLevel(), cards: p.levels.map((l) => l.d.cards), triangles: p.levels.map((l) => l.d.index.length / 3), ...(p.strands ? { strands: p.strands.built.strands, strandTriangles: p.strands.built.geometry.index!.count / 3 } : {}) }
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
    for (const o of [this.tint, this.stubble]) {
      if (!o) continue
      o.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof o.material.positionNode
      o.material.needsUpdate = true
    }
    this.refreshPositionNodes()
  }

  /** 发片和真发丝的顶点位置节点（长发带动力学位移）/ the vertex position nodes of cards and strands (long hair with the dynamics displacement) */
  private refreshPositionNodes(): void {
    for (const [kind, m] of this.materials) {
      m.positionNode = this.cardPositionNode(kind) as typeof m.positionNode
      m.needsUpdate = true
    }
    for (const p of this.pieces.values()) p.strands?.setSkinning(this.skinning, this.mode, this.dyn && this.dyn.piece === p.id ? (along, sim) => this.dyn!.host.node(along, sim) : null)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cardPositionNode(kind: MaterialKind): any {
    const skinned = positionNodeFor(this.skinning, this.mode, false)
    const dyn = this.dyn
    if (!dyn || KIND_OF[dyn.piece] !== kind) return skinned
    // 位移（静止空间）加在蒙皮之前 / the displacement (rest space) goes on before skinning
    return Fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const card: any = tslAttribute('aCard', 'vec4')
      ;(positionLocal as any).assign((positionGeometry as any).add(dyn.host.node(card.w, card.z)))
      return skinned
    })()
  }

  // ---- 长发动力学 / long-hair dynamics ----
  private dyn: { piece: HairPieceId; host: HairDynamics } | null = null
  private dynLoad = false
  private guideFiles = new Map<HairPieceId, Promise<DecodedGuides | null>>()

  private guidesOf(id: HairPieceId, info: HairStrandsInfo): Promise<DecodedGuides | null> {
    let p = this.guideFiles.get(id)
    if (!p) {
      p = loadStrandFile(this.base, info.file).then((bin) => (bin && this.data ? decodeGuides(bin, info, this.data.offsetUnit, this.skinVertexCount) : null))
      this.guideFiles.set(id, p)
    }
    return p
  }

  /** 长发的动力学：引导发丝到了、皮肤位置也有了就开始 / long-hair dynamics: starts once the guides and the skin positions are there */
  private async ensureDynamics(piece: Piece): Promise<void> {
    const info = this.data?.pieces.find((p) => p.id === piece.id)?.strands
    if (piece.id !== 'long' || !info || this.dyn || this.dynLoad) return
    this.dynLoad = true
    const d = await this.guidesOf(piece.id, info)
    this.dynLoad = false
    if (!d || this.disposed || !this.skinPos || !this.skinNormal || this.dyn) return
    const inf = this.influence
    const rowOf = (v: number): number => {
      if (!inf) return 0
      let best = 0
      for (let k = 1; k < 4; k++) if (inf.weight[v * 4 + k]! > inf.weight[v * 4 + best]!) best = k
      return inf.index[v * 4 + best]!
    }
    const host = new HairDynamics(d, this.skinPos, this.skinNormal, rowOf, () => this.onChange())
    this.dyn = { piece: piece.id, host }
    // 每个发片顶点、发丝顶点跟哪根模拟发丝 / which simulated strand each card and strand vertex follows
    for (const l of piece.levels) {
      const per = l.d.rings * 2
      const sim = new Float32Array(l.d.cards * per), along = new Float32Array(l.d.cards * per)
      const tmp = new Float32Array(l.d.offset.length)
      placeVertices(l.d, this.skinPos, tmp)
      for (let c = 0; c < l.d.cards; c++) {
        // 发片的根（第一个环的中点）/ the card's root (middle of the first ring)
        const i = c * per * 3
        const s = host.nearest((tmp[i]! + tmp[i + 3]!) / 2, (tmp[i + 1]! + tmp[i + 4]!) / 2, (tmp[i + 2]! + tmp[i + 5]!) / 2)
        for (let j = 0; j < per; j++) {
          sim[c * per + j] = s
          along[c * per + j] = Math.floor(j / 2) / (l.d.rings - 1)
        }
      }
      const cardAttr = l.geometry.getAttribute('aCard') as BufferAttribute
      const ca = cardAttr.array as Float32Array
      for (let v = 0; v < sim.length; v++) {
        ca[v * 4 + 2] = sim[v]!
        ca[v * 4 + 3] = along[v]!
      }
      cardAttr.needsUpdate = true
    }
    if (piece.strands) this.strandSim(piece.strands)
    this.refreshPositionNodes()
  }

  private strandSim(s: NonNullable<Piece['strands']>): void {
    if (!this.dyn) return
    const g = s.built.geometry
    const attr = g.getAttribute('aRef') as BufferAttribute
    const ref = attr.array as Float32Array
    for (let v = 0; v < attr.count; v++) ref[v * 3 + 2] = this.dyn.host.simOfGuide[ref[v * 3 + 1]!]!
    attr.needsUpdate = true
  }

  private dropDynamics(): void {
    this.dyn?.host.dispose()
    this.dyn = null
    this.refreshPositionNodes()
  }

  /**
   * 每帧调一次（Viewer 的渲染循环）：长发显示着就推进动力学；新的位移到了会通过 onChange 要求重画。
   * Called once per frame (the Viewer's render loop): while long hair shows, advance the dynamics; a new displacement
   * asks for a redraw through onChange.
   */
  tickDynamics(t: number): void {
    const d = this.dyn
    if (!d || !this.settings.show || this.style() !== d.piece) return
    d.host.tick(t, this.mode === 'off' ? null : (this.skinning.joints.image.data as Float32Array), this.mode)
  }

  private wanted(): HairPieceId[] {
    const out: HairPieceId[] = ['brows', 'lashes', 'pubic', 'axilla']
    const style = this.style()
    if (style && style !== 'none') out.unshift(style)
    if (this.settings.beard === 'short' && this.data?.pieces.some((p) => p.id === 'beard')) out.push('beard')
    return out
  }

  private updateVisibility(): void {
    const want = new Set(this.wanted())
    if (this.settings.wear.some((g) => PUBIC_COVER.includes(g))) want.delete('pubic')
    if (this.settings.wear.some((g) => AXILLA_COVER.includes(g))) want.delete('axilla')
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
    // 胡茬：选了胡茬或短须就画（短须下面也要有发根的颜色）/ stubble: drawn for stubble or the short beard (the short beard needs the root colour beneath too)
    const stubbleOn = this.settings.beard !== 'none'
    if (this.stubble && this.stubble.patch.mesh.visible !== stubbleOn) {
      this.stubble.patch.mesh.visible = stubbleOn
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
      await Promise.all([...this.wanted().map((id) => this.ensurePiece(id)), this.ensureTint(), this.settings.beard !== 'none' ? this.ensureStubble() : Promise.resolve()])
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
      this.materials.set(kind, m)
      m.positionNode = this.cardPositionNode(kind) as typeof m.positionNode
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
  /** 胡茬（只有男性）：跟着皮肤的一块覆盖网格 / stubble (male only): an overlay patch following the skin */
  private stubble: { patch: SkinPatch; material: MeshLambertNodeMaterial } | null = null
  private stubbleLoad: Promise<void> | null = null

  private ensureStubble(): Promise<void> {
    this.stubbleLoad ??= (async () => {
      const info = this.data?.beard
      if (!info) return
      const mask = await loadMask(this.base, info.file, info.vertices)
      if (!mask || this.disposed) return
      const material = makeStubbleMaterial(this.look)
      material.positionNode = positionNodeFor(this.skinning, this.mode, false) as typeof material.positionNode
      const patch = new SkinPatch(this.skin, mask.vertices, material)
      const w = new Float32Array(this.skinVertexCount)
      mask.vertices.forEach((v, i) => (w[v] = mask.value[i]! / 255))
      patch.setAttribute('aStubble', w, 1)
      if (this.influence) patch.setInfluences(this.influence.index, this.influence.weight)
      patch.mesh.name = 'hair-stubble'
      patch.mesh.renderOrder = 1
      this.stubble = { patch, material }
      this.placeTint()
      this.group.add(patch.mesh)
      this.updateVisibility()
    })()
    return this.stubbleLoad
  }

  /**
   * 头皮底色放在皮肤外 0.25 毫米：只靠多边形偏移时，它和写实皮肤层的深度比较在一些角度下会输（分缝里露出皮肤）。
   * The scalp tint sits 0.25 mm outside the skin: with polygon offset alone its depth test against the lifelike skin layer
   * loses at some angles (skin shows in the part).
   */
  private placeTint(): void {
    if ((!this.tint && !this.stubble) || !this.skinPos || !this.skinNormal) return
    const p = this.skinPos, n = this.skinNormal
    if (!this.tintPos || this.tintPos.length !== p.length) this.tintPos = new Float32Array(p.length)
    for (let i = 0; i < p.length; i++) this.tintPos[i] = p[i]! + n[i]! * 0.00025
    this.tint?.patch.setPositions(this.tintPos, n)
    this.stubble?.patch.setPositions(this.tintPos, n)
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
      // aCard = (层, 随机数, 模拟发丝, 根→梢)；后两项在动力学就绪时填 / aCard = (layer, random, simulated strand, root → tip); the last two are filled once the dynamics are ready
      const card = new Float32Array(d.layer.length * 4)
      for (let v = 0; v < d.layer.length; v++) {
        card[v * 4] = d.layer[v]!
        card[v * 4 + 1] = d.random[v]!
      }
      geometry.setAttribute('aCard', new BufferAttribute(card, 4))
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
    const piece: Piece = { id, lod, levels }
    this.pieces.set(id, piece)
    this.group.add(lod)
    this.updateVisibility()
    this.onChange()
    if (this.strandsEnabled && spec.strands) void this.loadStrands(piece, spec.strands, c)
    if (id === 'long') void this.ensureDynamics(piece)
  }

  /** 近景真发丝：发片之后再取，到了就插到 LOD 的最近一级 / close-up strands: fetched after the cards and inserted as the nearest LOD level once they arrive */
  private async loadStrands(piece: Piece, info: HairStrandsInfo, centre: Vector3): Promise<void> {
    const d = await this.guidesOf(piece.id, info)
    if (!d || this.disposed || !this.data) return
    const built = buildStrands(d, 7, piece.id === 'long' ? 2 : 1)
    const roots = rootTexture(info.guides)
    if (this.skinPos) placeRoots(d, this.skinPos, roots)
    const { material, setSkinning } = makeStrandMaterial(this.look, MATERIAL[KIND_OF[piece.id]], roots, info.diameter * info.hairsPerStrand)
    setSkinning(this.skinning, this.mode)
    const mesh = new Mesh(built.geometry, material)
    mesh.frustumCulled = false
    mesh.name = `hair-${piece.id}-strands`
    mesh.position.copy(centre).multiplyScalar(-1)
    piece.strands = { d, built, mesh, roots, setSkinning }
    if (this.dyn?.piece === piece.id) {
      this.strandSim(piece.strands)
      setSkinning(this.skinning, this.mode, (along, sim) => this.dyn!.host.node(along, sim))
    }
    this.strandInfluence(piece.strands)
    // 发片的第 0 级从发丝的最远距离开始 / the cards' level 0 starts where the strands stop
    piece.lod.levels[0]!.distance = info.maxDistance
    piece.lod.addLevel(mesh, 0)
    this.onChange()
  }

  private strandInfluence(s: NonNullable<Piece['strands']>): void {
    if (!this.influence) return
    const { index, weight } = this.influence
    const g = s.built.geometry
    const si = g.getAttribute('skinIndex') as BufferAttribute, sw = g.getAttribute('skinWeight') as BufferAttribute
    const di = si.array as Uint16Array, dw = sw.array as Uint8Array
    const per = (s.built.geometry.getAttribute('aRef').count / s.d.info.guides) | 0
    for (let gi = 0; gi < s.d.info.guides; gi++) {
      const v = s.built.dominant[gi]!
      for (let j = 0; j < per; j++) {
        const o = (gi * per + j) * 4
        for (let k = 0; k < 4; k++) {
          di[o + k] = index[v * 4 + k]!
          dw[o + k] = weight[v * 4 + k]!
        }
      }
    }
    si.needsUpdate = true
    sw.needsUpdate = true
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
    for (const p of this.pieces.values()) {
      for (const l of p.levels) l.geometry.dispose()
      if (p.strands) {
        p.strands.built.geometry.dispose()
        ;(p.strands.mesh.material as MeshStandardNodeMaterial).dispose()
        p.strands.roots.dispose()
      }
    }
    for (const m of this.materials.values()) m.dispose()
    this.tint?.patch.dispose()
    this.stubble?.patch.dispose()
    this.stubble?.material.dispose()
    this.dyn?.host.dispose()
    this.tint?.material.dispose()
    this.atlas?.a.dispose()
    this.atlas?.b.dispose()
    this.pieces.clear()
  }
}
