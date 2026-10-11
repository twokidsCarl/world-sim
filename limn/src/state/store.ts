import { create } from 'zustand'
import * as api from '../api'
import { download, loadMolecule } from '../mol/load'
import { bin, pad, parseMrc, surfaceMesh } from '../volume/mrc'
import { El, IDENTITY } from '../mol/types'
import { superpose } from '../mol/superpose'
import type { Molecule } from '../mol/types'
import { axisAngle, identity3, mul3, type Mat3 } from '../render/camera'
import { loadLipids, type LipidSet } from '../landscape/lipid'
import { fitFromPdbtm, fitToMembrane, type MembraneFit } from '../landscape/orient'
import type { Annotation, ColorMode } from '../style/annotate'
import { cloneStyle, STYLE_MOLECULE, styleFor, type Drawing, type Style } from '../render/style'
import type { Edit } from '../refine/edits'
import { defaultAssembly } from '../scene/build'
import type { Note, PanelSpec, SceneSpec, Tier } from '../scene/spec'
import { getLang, listParams, noteKey, pick, saveLang, syncLang, t, tIn, type Lang, noteError, errorNote, say } from '../i18n'
import catalog from '../../data/catalog.json'
import neuronTable from '../../data/neurons.json'
import cellTable from '../../data/cells.json'
import { buildCell, decodeCell, type CellGeometry } from '../volume/cell'
import { micronsUrl, neuromorphoUrl, neuronMolecule, parseSwc, within } from '../neuro/swc'
import { coarsen } from '../mol/coarse'
import { preparedMolecule } from '../mol/prepared'
import { fibonacciSphere, helicalLayer, layerOnSphere, rnpBundle, shell } from '../infer/influenza'
import { chainCentre, complexes, placeTemplate, ringSites, subMolecule, templateOf } from '../infer/idealise'
import { assemblyAtPicks, assemblyAtPoints, readPicks, type TemplateFit } from '../mol/points'
import { rng } from '../landscape/pack'
import { placedAtomCount } from '../scene/build'
import { defaultColoring, spreadHues, type Coloring } from '../style/assign'
import { parseHex } from '../style/oklab'
import { ROLE_HUE, type Role } from '../style/palettes'

export interface Panel {
  spec: PanelSpec
  mol: Molecule
  coloring: Coloring
  /** 当两个面板共有一种蛋白质时，把本面板转到与第一个一致 / turns this panel to match the first one, when they share a protein */
  align: Float32Array | null
  /** 全景里的膜蛋白：OPM 给出的膜内取向 / for a membrane protein in a landscape: its orientation in the membrane from OPM */
  membrane?: MembraneFit | null
  /** 逐残基注释，第一次用到按残基上色时才取；null 表示取过但没有 / per-residue annotation, fetched the first time a per-residue colour mode is used; null means fetched and absent */
  annotation?: Annotation | null
  /** 这个结构的主要引文，载入后异步取来 / the structure's primary citation, fetched after loading */
  /** 剖开时不切这个面板（密度图里的原子模型）/ this panel is left whole by a cut (the atomic model inside a density map) */
  noCut?: boolean
  paper?: { citation: api.Citation; open: boolean; licence: string; abstract: string } | null
}

/** 评审或用户能改变的、关于场景外观的一切 / Everything a reviewer or the user can change about how the scene looks. */
export interface Look {
  rot: Mat3
  /** 1 = 以标准边距给主体取景 / 1 = subject framed with the standard margin */
  zoom: number
  /** 主体向右/向上移动画幅的这个比例 / subject moved right/up by this share of the frame */
  shift: [number, number]
  style: Style
  colorings: Coloring[]
  /**
   * 从前面切掉的深度比例：0 = 不切，0.5 = 从正中剖开。
   * Share of the depth cut away from the front: 0 = whole, 0.5 = cut through the middle.
   */
  cut: number
}

export interface Round {
  image: string
  overall: number | null
  scores: api.CritiqueReply['scores'] | null
  comment: string
  edits: Edit[]
  look: Look
  /** 这一轮的修改与改之前比较的结论，以及有没有留下；没有比较过则不设 / how this round's changes compared with what came before, and whether they were kept; unset when no comparison was made */
  verdict?: 'better' | 'worse' | 'same'
  kept?: boolean
  reason?: string
}

interface State extends Look {
  /** 界面语言；`t` 读的就是它 / the interface language; it is what `t` reads */
  lang: Lang
  /** 换界面语言，并记住这次的选择 / change the interface language and remember the choice */
  setLang(lang: Lang): void
  spec: SceneSpec | null
  panels: Panel[]
  /** 每当 GPU 上的原子必须重建时加一 / bumped whenever the atoms on the GPU must be rebuilt */
  sceneRev: number
  /** 加一以要求舞台重画 / bumped to ask the stage to draw again */
  drawRev: number
  /** 正在做什么 / 出了什么错：存成消息键，显示时才写成文字 / what is going on, and what went wrong: kept as message keys and worded when shown */
  busy: Note | ''
  error: Note | ''
  /** 这张图载入时的“剖开”值，“重置视角”回到它 / the cut this picture loaded with, which "reset view" returns to */
  cutDefault: number
  rounds: Round[]
  refining: string
  /** 膜脂质，全景有膜时加载 / the membrane lipid, loaded when a landscape has a membrane */
  lipids: LipidSet | null
  /** 全景随机排布的种子 / seed of the random arrangement of a landscape */
  seed: number
  /** 每个面板在全景里放了多少拷贝；由舞台在排布完成后设置 / per panel, copies placed in the landscape; set by the stage after packing */
  placed: number[]
  /** 全景里画出的 DNA 碱基对数 / base pairs of DNA drawn in the landscape */
  dnaPairs: number
  repack(): void
  resolveTopic(topic: string): Promise<void>
  /** `title`、`titleEn`：目录里给这个结构起的名字，有就用它作标题 / `title`, `titleEn`: the name a catalogue gives the structure, used as the title when given */
  loadId(id: string, title?: string, titleEn?: string, iptm?: number): Promise<void>
  /** 当前这个预测蛋白所在的预测复合物；null 表示还没查或不适用 / predicted complexes containing the current predicted protein; null when not looked up or not applicable */
  complexes: api.PredictedComplex[] | null
  /** 画一个或几个检索到的神经元，几个时并排 / draw one or several neurons found by search, side by side when several */
  loadNeurons(hits: api.NeuronHit[]): Promise<void>
  loadCatalog(id: string): Promise<void>
  /** 载入目录里的一个神经元形态重建 / load a neuron reconstruction from the catalogue */
  loadNeuron(id: string): Promise<void>
  /** 载入目录里的一组连接组细胞，按它们共用的坐标系叠在一起 / load a set of connectome cells from the catalogue, overlaid in the frame they share */
  loadNeuronGroup(id: string): Promise<void>
  /** 载入一张 EMDB 密度图（编号的数字部分），有拟合的原子模型就叠在里面 / load an EMDB density map (the digits of its id), with its fitted atomic model inside when there is one */
  loadEmdb(n: string): Promise<void>
  /** 载入一个细胞的细胞器分割（目录里的 id）/ load the organelle segmentation of a cell (an id in the catalogue) */
  loadCell(id: string): Promise<void>
  setAssembly(panel: number, id: string): void
  setRole(panel: number, entity: number, role: Role): void
  /** 换上色方式；需要时先去取注释 / change the colour mode, fetching annotation first when it is needed */
  setColorMode(mode: ColorMode): Promise<void>
  setStyle(patch: (s: Style) => void): void
  /** 画法：手绘或 Illustrate / the way of drawing: painted or Illustrate */
  drawing: Drawing
  setDrawing(d: Drawing): void
  setLook(patch: Partial<Look>): void
  applyEdits(edits: Edit[]): void
  getLook(): Look
  resetView(): void
}

function coloringFor(mol: Molecule, spec: PanelSpec): Coloring {
  const base = defaultColoring(mol)
  const roles = mol.entities.map((e, i) => spec.entities.find((s) => s.entityId === e.id)?.role ?? base.roles[i]!)
  return spreadHues({ ...base, roles })
}

async function loadPanel(spec: PanelSpec): Promise<Panel> {
  const s = spec.source
  const mol = await loadMolecule(s.kind === 'pdb' ? { kind: 'pdb', id: s.id } : { kind: 'url', id: s.id, url: s.url!, minConfidence: 50 })
  const assembly = mol.assemblies.some((a) => a.id === spec.assembly) ? spec.assembly : defaultAssembly(mol)
  const full = { ...spec, assembly }
  return { spec: full, mol, coloring: coloringFor(mol, full), align: null }
}

/** 一次能流畅画出的球数上限 / how many spheres can be drawn comfortably at once */
const ATOM_BUDGET = 45_000_000

export interface CatalogEntry {
  id: string
  title: string
  titleEn: string
  captionEn: string
  licenceEn?: string
  attributionEn?: string
  keywords: string[]
  source: { kind: string; url?: string; id?: string }
  perCopy?: boolean
  /** 粒子的实测位置：文件地址和体素大小（Å）/ measured particle positions: the file's address and the voxel size in Å */
  points?: { url: string; voxelSpacing: number; fit?: TemplateFit }
  merge?: string
  cut?: number
  /** 按名字给实体指定颜色 [正则, [L, C, h]]，数值量自 Goodsell 画同一个对象的那幅画 / colours for entities by name, [pattern, [L, C, h]], the numbers measured on Goodsell's painting of the same subject */
  colors?: [string, [number, number, number]][]
  /** 数据里没有、按已知结构推断补上的部分 / parts absent from the data and filled in by inference from known structures */
  infer?: { kind: 'influenza-interior'; matrix: string; rnp: string; polymerase: string }
  /** 打开时的放大倍数，缺省 1 / the zoom it opens at, 1 by default */
  zoom?: number
  roles?: string[][]
  caption: string
  tier: string
  licence: string
  attribution: string
  citation: string
  link: string
}

/** 膜的颜色：淡黄绿，取自 Goodsell 的膜 / the membrane wash: pale yellow-green, as in Goodsell's membranes */
// 膜是很浅的一层淡色。量 Goodsell 的流感病毒，包膜是 L 0.89、C 0.035、h 290
// a membrane is a very pale wash. Measured on Goodsell's influenza virion, the envelope is L 0.89, C 0.035, h 290
export const MEMBRANE_LCH: [number, number, number] = [0.9, 0.035, 290]

export const CATALOG = catalog.models as CatalogEntry[]

/**
 * 地址里带 ?prim=spheres 时，神经元的分支和体数据的表面都改回用密排小球来画（加入圆台和三角网格之前的画法），
 * 用来对照两种画法。
 * With ?prim=spheres in the address, the branches of neurons and the surfaces of volumes go back
 * to being drawn with closely packed spheres (as they were before cones and triangle meshes), so
 * that the two ways of drawing can be compared.
 */
const DENSE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('prim') === 'spheres'

/** 向本地服务要一个预处理过的模型；还在准备就隔几秒再问 / ask the local service for a prepared model, asking again every few seconds while it is being prepared */
async function fetchPrepared(path: string, waiting: () => void): Promise<Uint8Array> {
  // 每 3 秒问一次，最多等一小时（最大的一个要下载 640 MB）/ asking every 3 seconds for up to an hour (the largest needs a 640 MB download)
  for (let tries = 0; tries < 1200; tries++) {
    const res = await fetch(path).catch(() => null)
    if (!res) throw noteError('error.preparedNoServer')
    if (res.status === 202) {
      waiting()
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? t('error.preparedNoServer'))
    return new Uint8Array(await res.arrayBuffer())
  }
  throw noteError('error.preparedTimeout')
}

/** 起始的画法：地址里带 ?style=illustrate 时用 Illustrate，否则手绘 / the drawing to start with: Illustrate when the address carries ?style=illustrate, painted otherwise */
const START_DRAWING: Drawing = typeof location !== 'undefined' && new URLSearchParams(location.search).get('style') === 'illustrate' ? 'illustrate' : 'painted'

/**
 * 流感病毒的内部（见 src/infer/influenza.ts）：基质蛋白一层、八条核糖核蛋白、八个聚合酶。
 * 颜色量自 Goodsell 的《Influenza Virus》：M1 蓝，核蛋白橙，RNA 黄，聚合酶红。
 * The inside of an influenza virion (see src/infer/influenza.ts): a layer of matrix protein, eight
 * ribonucleoproteins and eight polymerases. Colours are measured on Goodsell's "Influenza Virus":
 * M1 blue, nucleoprotein orange, RNA yellow, polymerase red.
 */
type V3 = [number, number, number]

async function influenzaInterior(spec: NonNullable<CatalogEntry['infer']>, model: Molecule, notes: Note[], busy: (name: string) => void, idealise: boolean, colors: NonNullable<CatalogEntry['colors']>): Promise<Panel[]> {
  const lipids = model.chains.filter((c) => model.entities[c.entity]!.kind === 'lipid')
  if (lipids.length === 0) return []
  const start = Math.min(...lipids.map((c) => c.start)), end = Math.max(...lipids.map((c) => c.start + c.count))
  const membrane = shell(model.pos, start, end - start)
  const load = async (id: string) => {
    busy(id)
    return loadMolecule({ kind: 'pdb', id })
  }
  const [m1, rnp, pol] = [await load(spec.matrix), await load(spec.rnp), await load(spec.polymerase)]
  const layer = helicalLayer(m1, defaultAssembly(m1))
  // M1 的质心放在膜内表面往里 25 Å；再往里 30 Å 之内是给 RNP 的空腔 / M1 centroids sit 25 Å inside the membrane's inner face; the space for the RNPs starts 30 Å further in
  const matrix = layerOnSphere(layer, membrane.centre, membrane.inner - 25)
  // 一段 RNP 螺旋里有多少个核苷酸：数它的 RNA 链上的磷原子 / nucleotides in one stretch of RNP helix: count the phosphorus atoms on its RNA chains
  let nt = 0
  for (const c of rnp.chains) if (rnp.entities[c.entity]!.kind === 'rna') for (let i = c.start; i < c.start + c.count; i++) if (rnp.isTrace[i]) nt++
  const bundle = rnpBundle(rnp, pol, membrane.centre, membrane.inner - 55, [0, 1, 0], nt || 616)
  const make = (mol: Molecule, id: string, title: string, titleEn: string, operators: Float32Array[], colors: (e: Molecule['entities'][number]) => [number, number, number], names: (e: Molecule['entities'][number]) => [string, string]): Panel => {
    mol.assemblies.push({ id: 'inferred', groups: [{ chains: mol.chains.map((_, i) => i), operators }] })
    const roles: Role[] = mol.entities.map((e) => (e.kind === 'rna' || e.kind === 'dna' ? 'nucleic' : 'soluble'))
    const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: mol.entities.map((e) => colors(e)) }
    const panelSpec: PanelSpec = {
      label: title, labelEn: titleEn,
      source: { id, kind: 'pdb', title: mol.title, method: tIn('zh', 'method.inferredPlacement'), methodEn: tIn('en', 'method.inferredPlacement'), resolution: null, year: null, tier: 'estimated', licence: 'CC0 1.0', attribution: 'RCSB PDB', citation: `PDB ${id}`, link: `https://www.rcsb.org/structure/${id}` },
      assembly: 'inferred',
      entities: mol.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: names(e)[0], nameEn: names(e)[1], description: e.description, organism: '' })),
      reason: '',
    }
    return { spec: panelSpec, mol, coloring, align: null }
  }
  const isRna = (e: Molecule['entities'][number]) => e.kind === 'rna' || e.kind === 'dna'
  const wanted = bundle.rods.reduce((s, r) => s + r.wanted, 0), placed = bundle.rods.reduce((s, r) => s + r.placed, 0)
  notes.push({ key: 'note.inferred.influenza', params: { matrix: spec.matrix, rnp: spec.rnp, polymerase: spec.polymerase, m1: matrix.length.toLocaleString('en-US'), nt: nt || 616, wanted, placed } })
  const outside: Panel[] = []
  if (idealise) {
    // 外面的刺：种类、数量和结构照模拟，位置和朝向排成一圈圈（见 src/infer/idealise.ts）
    // the spikes outside: kinds, numbers and structures as in the simulation, positions and orientations set in rings (see src/infer/idealise.ts)
    const named = (re: RegExp) => model.chains.map((_, i) => i).filter((i) => re.test(model.entities[model.chains[i]!.entity]!.description))
    const ha = complexes(model, named(/hemagglutinin/i), 3, 70), na = complexes(model, named(/neuraminidase/i), 4, 80), m2 = complexes(model, named(/^M2/i), 4, 45)
    const glycans = named(/glycan/i)
    const proteins = [...ha.flat(), ...na.flat()]
    const centres = new Map(proteins.map((ci) => [ci, chainCentre(model, ci)]))
    // 每棵糖链归到离它最近的那条蛋白链 / each glycan goes with the protein chain nearest to it
    const sugarOf = new Map<number, number[]>()
    for (const g of glycans) {
      const c = chainCentre(model, g)
      let best = -1, bd = Infinity
      for (const [ci, p] of centres) {
        const d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])
        if (d < bd) {
          bd = d
          best = ci
        }
      }
      if (best >= 0) sugarOf.set(best, [...(sugarOf.get(best) ?? []), g])
    }
    // 样板：最直立的那一个 / the template: the most upright one
    const pick = (groups: number[][]) => groups.map((g) => ({ g, t: templateOf(model, g, membrane.centre) })).sort((a, b) => a.t.tilt - b.t.tilt)[0]
    const sites = ringSites(ha.length + na.length, [0, 0, 1])
    // 神经氨酸酶均匀地插在血凝素中间 / neuraminidase is spread evenly among the hemagglutinins
    const naAt = new Set(na.map((_, k) => Math.min(sites.length - 1, Math.round(((k + 0.5) * sites.length) / Math.max(1, na.length)))))
    const lch = (e: Molecule['entities'][number]): [number, number, number] => colors.find(([pattern]) => new RegExp(pattern, 'i').test(e.description))?.[1] ?? [0.76, 0.086, 290]
    const kinds: [typeof ha, V3[], string, string, string][] = [
      [ha, sites.filter((_, i) => !naAt.has(i)), 'hemagglutinin', '血凝素（理想化的排布）', 'Hemagglutinin (idealised arrangement)'],
      [na, sites.filter((_, i) => naAt.has(i)), 'neuraminidase', '神经氨酸酶（理想化的排布）', 'Neuraminidase (idealised arrangement)'],
      [m2, fibonacciSphere(Math.max(1, m2.length)), 'M2', 'M2 质子通道（理想化的排布）', 'M2 proton channel (idealised arrangement)'],
    ]
    const tilts: number[] = []
    for (const [groups, where, id, title, titleEn] of kinds) {
      const chosen = pick(groups)
      if (!chosen || where.length === 0) continue
      tilts.push(...groups.map((g) => templateOf(model, g, membrane.centre).tilt))
      const sub = subMolecule(model, [...chosen.g, ...chosen.g.flatMap((ci) => sugarOf.get(ci) ?? [])], `${model.id}:${id}`, titleEn)
      const panel = make(sub, `${model.id}:${id}`, title, titleEn, placeTemplate(chosen.t, membrane.centre, where), lch, (e) => [e.description, e.description])
      panel.spec.source = { ...panel.spec.source, kind: 'model', method: tIn('zh', 'method.idealisedPlacement'), methodEn: tIn('en', 'method.idealisedPlacement'), licence: tIn('zh', 'licence.none'), licenceEn: tIn('en', 'licence.none'), attribution: '', citation: '', link: undefined }
      outside.push(panel)
    }
    // 原模型里只留膜 / only the membrane is kept from the original model
    for (const a of model.assemblies) a.groups = a.groups.filter((g) => g.chains.every((ci) => model.entities[model.chains[ci]!.entity]!.kind === 'lipid'))
    tilts.sort((a, b) => a - b)
    notes.push({ key: 'note.idealised', params: { ha: ha.length, na: na.length, m2: m2.length, tilt: Math.round(tilts[Math.floor(tilts.length / 2)] ?? 0) } })
  }
  return [
    ...outside,
    make(m1, spec.matrix, '基质蛋白 M1（推断的位置）', 'Matrix protein M1 (inferred placement)', matrix, () => [0.79, 0.083, 245], () => ['基质蛋白 M1', 'matrix protein M1']),
    make(rnp, spec.rnp, '核糖核蛋白（推断的位置）', 'Ribonucleoprotein (inferred placement)', bundle.stretches, (e) => (isRna(e) ? [0.84, 0.15, 86] : [0.72, 0.135, 62]), (e) => (isRna(e) ? ['基因组 RNA', 'genomic RNA'] : ['核蛋白 NP', 'nucleoprotein NP'])),
    make(pol, spec.polymerase, '聚合酶（推断的位置）', 'Polymerase (inferred placement)', bundle.polymerases, (e) => (isRna(e) ? [0.84, 0.15, 86] : [0.66, 0.13, 25]), (e) => (isRna(e) ? ['RNA', 'RNA'] : ['聚合酶', 'polymerase'])),
  ]
}

const freshLook = (): Pick<Look, 'rot' | 'zoom' | 'shift'> => ({ rot: identity3(), zoom: 1, shift: [0, 0] })

/** 下载进度写到状态栏，每秒最多几次 / download progress for the status line, a few times a second at most */
function progress(name: string): (received: number, total: number) => void {
  let last = 0
  return (received, total) => {
    const now = performance.now()
    if (now - last < 250) return
    last = now
    const mb = (n: number) => (n / 1e6).toFixed(1)
    useStore.setState({ busy: total ? say('busy.progressOf', { name, received: mb(received), total: mb(total) }) : say('busy.progress', { name, received: mb(received) }) })
  }
}

/** 载入 PDB 结构之后去取它的论文信息，取到再补进面板 / after a PDB structure loads, fetch its paper and add it to the panel when it arrives */
function fetchPapers(): void {
  for (const p of useStore.getState().panels) {
    if (p.paper !== undefined || p.spec.source.kind !== 'pdb') continue
    const id = p.spec.source.id
    void api.citation(id).then((r) => {
      const c = r?.entry?.citation
      const paper = c ? { citation: c, open: !!r?.paper?.open, licence: r?.paper?.licence ?? '', abstract: r?.paper?.abstract ?? '' } : null
      useStore.setState((s) => ({ panels: s.panels.map((x) => (x.spec.source.id === id && x.paper === undefined ? { ...x, paper } : x)) }))
    })
  }
}

export const useStore = create<State>((set, get) => ({
  lang: getLang(),
  setLang(lang) {
    saveLang(lang)
    syncLang(lang)
    // 画面上的图注和状态栏也是文字，重画一次 / the labels on the stage and the status line are text too, so draw again
    set((s) => ({ lang, drawRev: s.drawRev + 1 }))
  },
  spec: null,
  panels: [],
  ...freshLook(),
  cut: 0,
  drawing: START_DRAWING,
  style: styleFor('molecule', START_DRAWING),
  colorings: [],
  sceneRev: 0,
  drawRev: 0,
  busy: '',
  error: '',
  cutDefault: 0,
  rounds: [],
  refining: '',
  lipids: null,
  seed: 1,
  placed: [],
  dnaPairs: 0,
  complexes: null,

  repack() {
    set((s) => ({ seed: s.seed + 1, sceneRev: s.sceneRev + 1 }))
  },

  async resolveTopic(topic) {
    set({ busy: say('busy.resolving'), error: '' })
    try {
      const { spec } = await api.resolve(topic)
      if (spec.catalog) return await get().loadCatalog(spec.catalog)
      set({ busy: say('busy.downloading', { name: spec.panels.map((p) => p.source.id).join(t('punct.list')) }) })
      const panels = await Promise.all(spec.panels.map(loadPanel))
      if (spec.landscape) {
        const lipids = spec.landscape.membrane ? await loadLipids(spec.landscape.membraneType) : null
        // 服务端那条“近似摆放、只用一种磷脂”的说明，换成实际用的脂质组成
        // the server's note on approximate placement and a single phospholipid gives way to the lipid composition actually used
        if (lipids) spec.notes = [...spec.notes.filter((n) => noteKey(n) !== 'note.land.membranePlacement'), { key: lipids.citation ? 'note.lipidsCited' : 'note.lipids', params: { name: lipids.name, nameEn: lipids.nameEn, basis: lipids.basis, basisEn: lipids.basisEn, ...(lipids.citation ? { citation: lipids.citation } : {}) } }]
        // 膜蛋白：向 OPM 要它在膜里的取向，叠合到我们手上的坐标
        // membrane proteins: ask OPM how each sits in the membrane and fit that to the coordinates in hand
        const oriented: { label: string; source: string }[] = []
        await Promise.all(
          spec.landscape.ingredients.filter((g) => g.compartment === 'membrane').map(async (g) => {
            const p = panels[g.panel]!
            if (p.spec.source.kind !== 'pdb') return
            const data = await api.membrane(p.spec.source.id)
            p.membrane = data?.orientation ? fitToMembrane(p.mol, data.orientation) : data?.pdbtm ? fitFromPdbtm(p.mol, data.pdbtm, data.topology ?? {}) : null
            if (p.membrane) oriented.push({ label: p.spec.label, source: p.membrane.source })
          }),
        )
        if (oriented.length) spec.notes = [{ key: 'note.oriented', params: listParams('list', (lang) => oriented.map((o) => tIn(lang, 'note.oriented.item', o))) }, ...spec.notes.filter((n) => noteKey(n) !== 'note.land.membranePlacement' || oriented.length < spec.landscape!.ingredients.filter((g) => g.compartment === 'membrane').length)]
        // 拥挤场景里几种分子共用一个角色；把它们在该角色的色相范围内展开，
        // 以便分清相邻的分子。
        // Several kinds of molecule share a role in a crowded scene; fan
        // them across the role's hue range so neighbours can be told apart.
        const colorings = panels.map((p) => p.coloring)
        const byRole = new Map<Role, number[]>()
        panels.forEach((p, i) => {
          const role = p.coloring.roles[p.mol.entities.findIndex((e) => e.kind === 'protein')] ?? p.coloring.roles[0]!
          byRole.set(role, [...(byRole.get(role) ?? []), i])
        })
        for (const [role, idx] of byRole) {
          const spread = Math.max(ROLE_HUE[role].spread, 18)
          idx.forEach((pi, k) => {
            const shift = idx.length === 1 ? 0 : -spread + (2 * spread * k) / (idx.length - 1)
            colorings[pi] = { ...colorings[pi]!, hueShift: colorings[pi]!.hueShift.map(() => 0), nudge: colorings[pi]!.nudge.map(() => shift) }
          })
        }
        set((s) => ({ spec, panels, colorings, lipids, ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('landscape', s.drawing), rounds: [], placed: [], busy: '', sceneRev: s.sceneRev + 1 }))
        return
      }
      // 同一蛋白质的各个面板转到共同的朝向，
      // 这样它们之间变化的是分子而不是相机。
      // Panels of the same protein are turned to a common orientation, so
      // that what changes between them is the molecule and not the camera.
      const aligned: { id: string; matched: number; rmsd: string }[] = []
      for (const p of panels.slice(1)) {
        const fit = superpose(p.mol, panels[0]!.mol)
        if (fit) {
          p.align = fit.matrix
          aligned.push({ id: p.mol.id, matched: fit.matched, rmsd: fit.rmsd.toFixed(1) })
        }
      }
      if (aligned.length) spec.notes = [...spec.notes, { key: 'note.aligned', params: { ...listParams('list', (lang) => aligned.map((a) => tIn(lang, 'note.aligned.item', a))), ref: panels[0]!.mol.id } }]
      set((s) => ({ spec, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('molecule', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
      fetchPapers()
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadId(id, title, titleEn, iptm) {
    const clean = id.trim().toUpperCase()
    // "AF-P04637"：AlphaFold 数据库里这个 UniProt 编号的预测模型 / "AF-P04637": the AlphaFold DB model for that UniProt accession
    // "EMD-21317"：EMDB 里的一张密度图 / "EMD-21317": a density map in the EMDB
    const em = /^EMD-?(\d{4,6})$/.exec(clean)
    if (em) return get().loadEmdb(em[1]!)
    // "AF-0000000211046780"：AlphaFold 数据库里的一个预测复合物 / "AF-0000000211046780": a predicted complex in the AlphaFold DB
    const af = /^AF-([A-Z0-9]{6,10}|\d{10,20})$/.exec(clean)
    const isComplex = !!af && /^\d+$/.test(af[1]!)
    if (!af && !/^[0-9][A-Z0-9]{3}$/.test(clean)) {
      set({ error: say('error.badId') })
      return
    }
    set({ busy: say('busy.downloading', { name: clean }), error: '' })
    try {
      const prediction = af ? await api.alphafold(af[1]!) : null
      if (af && !prediction) throw noteError('error.noAlphafold', { id: af[1]! })
      const mol = await loadMolecule(prediction ? { kind: 'url', id: clean, url: prediction.url, minConfidence: 50 } : { kind: 'pdb', id: clean }, progress(clean))
      const coloring = defaultColoring(mol)
      const methodKey = isComplex ? 'method.complex' : prediction?.source === 'BFVD' ? 'method.bfvd' : 'method.alphafold'
      const spec: PanelSpec = {
        label: clean,
        source: prediction ? { id: clean, kind: 'alphafold', url: prediction.url, title: mol.title, method: tIn('zh', methodKey), methodEn: tIn('en', methodKey), resolution: null, year: null, tier: 'predicted', ...(prediction.source === 'BFVD' ? { licence: 'CC BY 4.0', attribution: 'BFVD (Steinegger lab)', link: 'https://bfvd.steineggerlab.workers.dev/' } : { licence: 'CC BY 4.0', attribution: 'AlphaFold Protein Structure Database', link: `https://alphafold.ebi.ac.uk/entry/${isComplex ? clean : af![1]}` }) } : { id: clean, kind: 'pdb', title: mol.title, method: '', resolution: null, year: null },
        assembly: defaultAssembly(mol),
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: e.description || e.kind, description: e.description, organism: '' })),
        reason: '',
      }
      const scene: SceneSpec = { topic: clean, kind: 'molecule', title: title || mol.title || clean, ...(title && titleEn ? { titleEn } : {}), caption: '', panels: [spec], notes: !prediction ? [] : isComplex ? [{ key: 'note.complex', params: { iptm: iptm ?? '?' } }] : prediction.source === 'BFVD' ? [{ key: 'note.bfvd' }] : [{ key: 'note.alphafold', params: { percent: Math.round(prediction.confident * 100) } }] }
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null }], colorings: [coloring], ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('molecule', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1, complexes: null }))
      fetchPapers()
      // 单个蛋白的预测模型：顺便查含有它的预测复合物 / for a single predicted protein, also look up the predicted complexes that contain it
      if (af && !isComplex) void api.complexes(af[1]!).then((list) => useStore.getState().spec?.topic === clean && useStore.setState({ complexes: list }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadCatalog(id) {
    const entry = (catalog.models as CatalogEntry[]).find((m) => m.id === id)
    if (!entry) {
      set({ error: say('error.notInCatalog', { id }) })
      return
    }
    set({ busy: say('busy.downloading', { name: pick(entry.title, entry.titleEn) }), error: '' })
    try {
      const src = entry.source
      const notes: Note[] = []
      let mol: Molecule
      if (src.kind === 'prepared') {
        // 几十亿个原子的模型：本地服务先把它粗化成球（第一次要一两分钟），这里取粗化后的小文件
        // a model of billions of atoms: the local service coarsens it into spheres first (a minute or two the first time), and the small result is fetched here
        const buf = await fetchPrepared(`/api/prepared?id=${encodeURIComponent(entry.id)}`, () => set({ busy: say('busy.preparing', { name: pick(entry.title, entry.titleEn) }) }))
        const made = preparedMolecule(buf, entry.id, entry.titleEn)
        mol = made.mol
        const h = made.header
        const n = (v: number) => v.toLocaleString('en-US')
        if (h.unit === 'beads') notes.push({ key: 'note.preparedBeads', params: { atoms: n(h.atomsPlaced), per: h.atomsPerSphere, spheres: n(h.spheresPlaced) } })
        // 只有一份的显式模型（不是实例化的）/ an explicit model in a single copy (not instanced)
        else if (h.ops === 1) notes.push({ key: 'note.preparedAtoms', params: { atoms: n(h.atomsPlaced), heavy: n(h.heavyPlaced), per: h.atomsPerSphere, spheres: n(h.spheresPlaced) } })
        else notes.push({ key: 'note.prepared', params: { atoms: n(h.atomsPlaced), heavy: n(h.heavyPlaced), per: h.atomsPerSphere, spheres: n(h.spheresPlaced), kinds: h.objects.length, copies: n(h.ops) } })
      } else mol = await loadMolecule(src.kind === 'pdb' ? { kind: 'pdb', id: src.id! } : { kind: 'url', id: entry.id, url: src.url! }, progress(pick(entry.title, entry.titleEn)))
      let assembly = defaultAssembly(mol)
      if (entry.points) {
        // 实测的粒子位置：每个位置放一份原子模型 / measured particle positions: one copy of the atomic model at each
        set({ busy: say('busy.picks', { name: pick(entry.title, entry.titleEn) }) })
        const res = await fetch(entry.points.url)
        if (!res.ok) throw noteError('error.picksFetch', { status: res.status, host: new URL(entry.points.url).hostname })
        const picks = readPicks(await res.text(), entry.points.voxelSpacing)
        const pts = picks.points
        if (pts.length === 0) throw noteError('error.picksEmpty')
        // 有朝向矩阵、也有模型在模板坐标系里的拟合时，朝向用实测的；否则随机
        // with orientation matrices and a fit of the model into the template's frame, orientations are the measured ones; otherwise random
        const oriented = !!picks.rotations && !!entry.points.fit
        mol.assemblies.push(oriented ? assemblyAtPicks(mol, assembly, pts, picks.rotations!, entry.points.fit!) : assemblyAtPoints(mol, assembly, pts, rng(1)))
        assembly = 'picks'
        notes.push(oriented ? { key: 'note.picksOriented', params: { count: pts.length / 3 } } : { key: 'note.picks', params: { count: pts.length / 3 } })
      }
      // 原子太多就改画每个残基一个球 / with too many atoms, draw one sphere per residue instead
      const full = placedAtomCount(mol, assembly)
      if (full > ATOM_BUDGET && src.kind !== 'prepared') {
        mol = coarsen(mol)
        notes.push({ key: 'note.coarse', params: { millions: (full / 1e6).toFixed(0) } })
      }
      const roles: Role[] = mol.entities.map((e) => {
        if (e.kind === 'lipid') return 'membrane'
        for (const [pattern, role] of entry.roles ?? []) if (new RegExp(pattern!, 'i').test(e.description)) return role as Role
        return entry.roles ? 'soluble' : (undefined as unknown as Role)
      })
      const base = defaultColoring(mol)
      const coloring = spreadHues({ ...base, roles: roles.map((r, i) => r ?? base.roles[i]!) })
      // 整张膜一个颜色，不按来源的拼块分色 / the whole membrane is one colour, not a patchwork of where its lipids came from
      if (entry.perCopy) mol.entities.forEach((e, i) => e.kind === 'lipid' && (coloring.override[i] = MEMBRANE_LCH))
      for (const [pattern, lch] of entry.colors ?? []) mol.entities.forEach((e, i) => new RegExp(pattern, 'i').test(e.description) && (coloring.override[i] = lch))
      const short = (d: string) => d.split('.').pop()!.replace(/_/g, ' ')
      const spec: PanelSpec = {
        label: entry.title,
        labelEn: entry.titleEn,
        source: {
          id: src.kind === 'pdb' ? src.id! : entry.id,
          kind: src.kind === 'pdb' ? 'pdb' : 'model',
          url: src.url,
          title: entry.titleEn,
          method: '',
          resolution: null,
          year: null,
          licence: entry.licence,
          attribution: entry.attribution,
          ...(entry.licenceEn ? { licenceEn: entry.licenceEn } : {}),
          ...(entry.attributionEn ? { attributionEn: entry.attributionEn } : {}),
          citation: entry.citation,
          link: entry.link,
          tier: entry.tier as Tier,
        },
        assembly,
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: short(e.description) || e.kind, description: e.description, organism: '' })),
        reason: '',
      }
      const mesoscale = !!entry.perCopy
      // 没有找到许可声明的数据，在说明里写明 / data for which no licence statement was found says so in its notes
      if (entry.licenceEn === 'no licence statement found') notes.push({ key: 'note.noLicence' })
      if (mesoscale && !entry.points) notes.push({ key: 'note.publishedModel' })
      // 数据里没有的部分，按已知结构推断着补上，各自是一个面板，和模型在同一个坐标系里
      // what the data lacks is filled in by inference from known structures, each part a panel of its own in the model's coordinate frame
      const inferred: Panel[] = entry.infer ? await influenzaInterior(entry.infer, mol, notes, (name) => set({ busy: say('busy.downloading', { name }) }), get().drawing === 'painted', entry.colors ?? []) : []
      const scene: SceneSpec = { topic: entry.title, kind: mesoscale ? 'model' : 'virus', title: entry.title, titleEn: entry.titleEn, caption: entry.caption, captionEn: entry.captionEn, catalog: entry.id, ...(inferred.length ? { overlay: true } : {}), panels: [spec], notes, mesoscale, merge: entry.merge }
      set((s) => ({
        spec: scene,
        panels: [{ spec, mol, coloring, align: null }, ...inferred],
        colorings: [coloring, ...inferred.map((p) => p.coloring)],
        ...freshLook(),
        // 很大的模型默认放大到中间一块：整个画出来时每个分子只有几个像素，什么也看不清
        // a very large model opens zoomed in on its middle: drawn whole, each molecule is a few pixels and nothing can be made out
        zoom: entry.zoom ?? 1,
        cut: entry.cut ?? 0,
        cutDefault: entry.cut ?? 0,
        style: styleFor(mesoscale ? 'mesoscale' : 'molecule', get().drawing),
        rounds: [],
        busy: '',
        sceneRev: s.sceneRev + 1,
      }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadEmdb(n) {
    set({ busy: say('busy.emdbQuery', { n }), error: '' })
    try {
      const info = await api.emdb(n)
      if (!info) throw noteError('error.emdbMissing', { n })
      if (info.contour === null) throw noteError('error.emdbNoContour', { n })
      if (info.megabytes > 420) throw noteError('error.emdbTooBig', { n, mb: info.megabytes })
      const report = progress(t('busy.mapName', { id: info.id, mb: info.megabytes }))
      // 第一次取时，本地服务要先把整张图下完才开始回传，这段时间没有进度可报 / the first time, the local service fetches the whole map before it starts replying, and there is no progress to report meanwhile
      set({ busy: say('busy.downloading', { name: `${info.id} (${info.megabytes} MB)` }) })
      let buf: Uint8Array | null = null
      for (const u of [`/api/structure?url=${encodeURIComponent(info.url)}`, info.url]) {
        buf = await download(u, report).catch(() => null)
        if (buf) break
      }
      if (!buf) throw noteError('error.emdbFetch', { id: info.id })
      set({ busy: say('busy.isosurface', { id: info.id }) })
      await new Promise((r) => setTimeout(r, 30))
      const full = parseMrc(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      // 最长边合并到 200 个体素以内，够画，也不至于太慢 / bin to at most 200 voxels a side: enough to draw, and not too slow
      const vol = bin(full, 200)
      // 四周补一层空体素，密度贴着盒子边界的地方表面也是封闭的 / one layer of empty voxels all round, so the surface is closed even where density touches the box
      const surface = surfaceMesh(DENSE ? vol : pad(vol, Math.min(0, info.contour - 1)), info.contour)
      const pts = surface.positions
      if (pts.length === 0) throw noteError('error.emdbNoSurface', { id: info.id, contour: info.contour })
      const count = pts.length / 3
      const map: Molecule = {
        id: info.id, title: info.title, atomCount: count, pos: pts,
        element: new Uint8Array(count).fill(El.N),
        // 每个点一个球，半径略小于一个体素，相邻的球正好连成面；画三角网格时这些球只用来取景
        // a sphere per point, a little under a voxel in radius, so that neighbours just join into a surface; when the triangle mesh is drawn the spheres serve only for framing
        radius: new Float32Array(count).fill(vol.voxel[0] * 0.9),
        ...(DENSE ? {} : { triangles: surface.triangles }),
        chainOf: new Uint32Array(count), isTrace: new Uint8Array(count), residue: new Int32Array(count).fill(1),
        chains: [{ asymId: 'map', authAsymId: 'map', entity: 0, start: 0, count, model: 1 }],
        entities: [{ id: 'map', description: `${tIn('zh', 'entity.isosurface')} / ${tIn('en', 'entity.isosurface')}`, kind: 'protein' }],
        assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
      }
      const binned = vol.voxel[0] / full.voxel[0]
      const mapColoring: Coloring = { roles: ['soluble'], hueShift: [0], nudge: [0], override: [[0.87, 0.035, 250]] }
      const mapSpec: PanelSpec = {
        label: info.id,
        source: { id: info.id, kind: 'emdb', url: info.url, title: info.title, method: tIn('zh', 'method.emMap'), methodEn: tIn('en', 'method.emMap'), resolution: info.resolution, year: null, tier: 'measured', licence: 'CC0 1.0', attribution: 'EMDB', citation: info.id, link: `https://www.ebi.ac.uk/emdb/${info.id}` },
        assembly: 'asym',
        entities: [{ entityId: 'map', role: 'soluble', name: tIn('zh', 'entity.isosurface'), nameEn: tIn('en', 'entity.isosurface'), description: info.title, organism: '' }],
        reason: '',
      }
      const panels: Panel[] = [{ spec: mapSpec, mol: map, coloring: mapColoring, align: null, paper: null, annotation: null }]
      const notes: Note[] = [
        { key: binned > 1 ? 'note.emdb.mapBinned' : 'note.emdb.map', params: { dims: info.dims.join('×'), voxel: info.voxel.toFixed(2), contour: info.contour, ...(binned > 1 ? { binned } : {}) } },
        { key: DENSE ? 'note.spheresSurface' : 'note.meshSurface' },
      ]
      // 拟合进这张图的原子模型和它在同一个坐标系里，直接叠进去 / the atomic model fitted into this map shares its coordinate frame and goes straight in
      const pdbId = info.pdb[0]
      if (pdbId) {
        set({ busy: say('busy.fittedModel', { id: pdbId }) })
        const mol = await loadMolecule({ kind: 'pdb', id: pdbId }, progress(pdbId)).catch(() => null)
        if (mol) {
          const coloring = defaultColoring(mol)
          const spec: PanelSpec = {
            label: pdbId,
            source: { id: pdbId, kind: 'pdb', title: mol.title, method: '', resolution: null, year: null },
            assembly: 'asym',
            entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: e.description || e.kind, description: e.description, organism: '' })),
            reason: '',
          }
          panels.push({ spec, mol, coloring, align: null, noCut: true })
          notes.push({ key: 'note.emdb.fitted', params: { id: pdbId } })
        }
      }
      const overlay = panels.length > 1
      const scene: SceneSpec = { topic: info.id, kind: 'molecule', title: info.title || info.id, caption: '', panels: panels.map((p) => p.spec), notes, overlay }
      set((s) => ({ spec: scene, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: overlay ? 0.5 : 0, cutDefault: overlay ? 0.5 : 0, style: styleFor('molecule', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
      fetchPapers()
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadCell(id) {
    const entry = cellTable.cells.find((c) => c.id === id)
    if (!entry) {
      set({ error: say('error.notInCatalog', { id }) })
      return
    }
    set({ busy: say('busy.downloading', { name: pick(entry.title, entry.titleEn) }), error: '' })
    try {
      const nameOf = new Map(entry.organelles.map((o) => [o.label, o]))
      // 平常读本地服务预先做好的那一个文件；没有服务（或在用小球的对照画法）时，在页面里逐块取、现算
      // normally the one file the local service prepared ahead of time is read; without the service (or in the sphere drawing kept for comparison) the page fetches block by block and computes it
      let geo: CellGeometry | null = null
      if (!DENSE) geo = await fetchPrepared(`/api/cell?id=${encodeURIComponent(entry.id)}`, () => set({ busy: say('busy.preparing', { name: pick(entry.title, entry.titleEn) }) })).then(decodeCell, () => null)
      if (!geo)
        geo = await buildCell(entry, DENSE, {
          fetching: (label, done, total) => set({ busy: say('busy.segmentation', { name: nameOf.get(label)!.name, nameEn: nameOf.get(label)!.nameEn, done, total }) }),
          surfacing: async (label) => {
            set({ busy: say('busy.surface', { name: nameOf.get(label)!.name, nameEn: nameOf.get(label)!.nameEn }) })
            await new Promise((r) => setTimeout(r, 20))
          },
        })
      const count = geo.positions.length / 3
      if (count === 0) throw noteError('error.cellFetch', { title: entry.title, titleEn: entry.titleEn })
      const voxel = geo.voxel
      const missing = geo.missing.map((label) => nameOf.get(label)!)
      const chains: Molecule['chains'] = [], entities: Molecule['entities'] = []
      const roles: Role[] = []
      for (const part of geo.parts) {
        const o = nameOf.get(part.label)!
        entities.push({ id: o.label, description: `${o.name} / ${o.nameEn}`, kind: 'protein' })
        chains.push({ asymId: o.label, authAsymId: o.label, entity: entities.length - 1, start: part.start, count: part.count, model: 1 })
        roles.push(o.role as Role)
      }
      const chainOf = new Uint32Array(count)
      chains.forEach((c, i) => chainOf.fill(i, c.start, c.start + c.count))
      const mol: Molecule = {
        id: entry.id, title: entry.titleEn, atomCount: count, pos: geo.positions, element: new Uint8Array(count).fill(El.N), radius: new Float32Array(count).fill(geo.radius),
        chainOf, isTrace: new Uint8Array(count), residue: new Int32Array(count).fill(1), chains, entities,
        ...(DENSE ? {} : { triangles: geo.triangles, solid: true }),
        assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
      }
      const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
      const spec: PanelSpec = {
        label: entry.title,
        labelEn: entry.titleEn,
        source: { id: entry.id, kind: 'cell', url: entry.base, title: entry.titleEn, method: tIn('zh', 'method.fibsem'), methodEn: tIn('en', 'method.fibsem'), resolution: null, year: null, tier: 'measured', licence: entry.licence, attribution: entry.attribution, attributionEn: entry.attributionEn, citation: entry.citation, link: entry.link },
        assembly: 'asym',
        entities: entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description.split(' / ')[0]!, nameEn: e.description.split(' / ')[1], description: e.description, organism: 'Homo sapiens' })),
        reason: '',
      }
      const notes: Note[] = [
        { key: 'note.cell.scale', params: { voxel: voxel.map((v) => Math.round(v)).join('×') } },
        { key: 'note.cell.segmentation' },
        { key: DENSE ? 'note.cell.spheres' : 'note.cell.mesh' },
        { key: 'note.cell.envelope' },
        ...(missing.length ? [{ key: 'note.cell.missing', params: listParams('names', (lang) => missing.map((o) => (lang === 'zh' ? o.name : o.nameEn))) }] : []),
      ]
      const scene: SceneSpec = { topic: entry.title, kind: 'neuron', title: entry.title, titleEn: entry.titleEn, caption: entry.caption, captionEn: entry.captionEn, panels: [spec], notes, unit: 'nm' }
      // 贴壁的细胞是扁的：从上往下看，在半高处剖开；结构很碎，线画细一些
      // a cell grown on a surface is flat: look down on it, cut at mid-height; the structures are fine-grained, so lines are drawn thinner
      const thin = cloneStyle(STYLE_MOLECULE)
      thin.lineWidth = 0.6
      thin.shadow.floor = 0.8
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null, paper: null, annotation: null }], colorings: [coloring], ...freshLook(), rot: axisAngle(1, 0, 0, Math.PI / 2), cut: 0.45, cutDefault: 0.45, style: thin, rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadNeuron(id) {
    if (neuronTable.groups.some((g) => g.id === id)) return get().loadNeuronGroup(id)
    const entry = neuronTable.neurons.find((n) => n.id === id)
    if (!entry) {
      set({ error: say('error.notInCatalog', { id }) })
      return
    }
    set({ busy: say('busy.downloading', { name: pick(entry.title, entry.titleEn) }), error: '' })
    try {
      const url = neuromorphoUrl(entry.archive, entry.name)
      // 先走本地服务的缓存，不行再直接取 / through the local service's cache first, then directly
      let text = ''
      for (const u of [`/api/structure?url=${encodeURIComponent(url)}`, url]) {
        const res = await fetch(u).catch(() => null)
        if (res?.ok) {
          text = await res.text()
          break
        }
      }
      if (!text) throw noteError('error.neuronFetch', { title: entry.title, titleEn: entry.titleEn })
      const mol = neuronMolecule(parseSwc(text), entry.name, entry.titleEn, DENSE)
      // 胞体是主角；轴突、基树突、顶树突各用一个色相区 / the soma is the subject; axon, basal and apical dendrites each take a hue sector
      const roleOf: Record<string, Role> = { '1': 'focus', '2': 'nucleic-binding', '3': 'soluble', '4': 'membrane', '0': 'extracellular' }
      const roles = mol.entities.map((e) => roleOf[e.id] ?? 'soluble')
      const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
      const spec: PanelSpec = {
        label: entry.title,
        labelEn: entry.titleEn,
        source: {
          id: entry.name, kind: 'neuron', url, title: entry.titleEn, method: tIn('zh', 'method.reconstruction'), methodEn: tIn('en', 'method.reconstruction'), resolution: null, year: null, tier: 'measured',
          licence: 'CC BY 4.0', attribution: tIn('zh', 'source.neuromorpho', { archive: entry.archive }), attributionEn: tIn('en', 'source.neuromorpho', { archive: entry.archive }), citation: `doi:${entry.doi}`, link: `https://neuromorpho.org/neuron_info.jsp?neuron_name=${encodeURIComponent(entry.name)}`,
        },
        assembly: 'asym',
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description.split(' / ')[0]!, nameEn: e.description.split(' / ')[1], description: e.description, organism: entry.species })),
        reason: '',
      }
      const notes: Note[] = [
        { key: 'note.neuron.about', params: { species: entry.species, region: entry.region, has: entry.has, hasEn: entry.hasEn } },
        { key: 'note.neuron.thin' },
      ]
      const scene: SceneSpec = { topic: entry.title, kind: 'neuron', title: entry.title, titleEn: entry.titleEn, caption: '', panels: [spec], notes, unit: 'µm' }
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null, paper: null, annotation: null }], colorings: [coloring], ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('neuron', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadNeuronGroup(id) {
    const group = neuronTable.groups.find((g) => g.id === id)
    if (!group) {
      set({ error: say('error.notInCatalog', { id }) })
      return
    }
    set({ busy: say('busy.downloading', { name: pick(group.title, group.titleEn) }), error: '' })
    try {
      const cells: { id: string; url: string; nodes: ReturnType<typeof parseSwc> }[] = []
      for (const cell of group.cells) {
        const url = micronsUrl(cell)
        let text = ''
        for (const u of [`/api/structure?url=${encodeURIComponent(url)}`, url]) {
          const res = await fetch(u).catch(() => null)
          if (res?.ok) {
            text = await res.text()
            break
          }
        }
        if (!text) throw noteError('error.micronsFetch', { id: cell })
        cells.push({ id: cell, url, nodes: parseSwc(text) })
      }
      // 以胞体的平均位置为原点；数据的 y 轴从皮层表面指向深处，绕 x 轴转半圈让表面朝上（不改变手性）
      // the mean soma position becomes the origin; the data's y axis runs from the cortical surface downwards, so a half turn about x puts the surface on top (handedness unchanged)
      const somas = cells.map((c) => c.nodes.find((n) => n.type === 1) ?? c.nodes[0]!)
      const mid: [number, number, number] = [0, 1, 2].map((k) => somas.reduce((a, n) => a + [n.x, n.y, n.z][k]!, 0) / somas.length) as [number, number, number]
      // 每个细胞一个色相 / one hue per cell
      const hues: Role[] = ['focus', 'soluble', 'membrane', 'nucleic-binding', 'extracellular', 'nucleic']
      const panels: Panel[] = []
      let dropped = 0
      cells.forEach((c, i) => {
        const kept = within(c.nodes, mid, group.radius)
        dropped += c.nodes.length - kept.length
        const mol = neuronMolecule(kept.map((n) => ({ ...n, x: n.x - mid[0], y: -(n.y - mid[1]), z: -(n.z - mid[2]) })), c.id, c.id, DENSE)
        const roles = mol.entities.map(() => hues[i % hues.length]!)
        const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
        const spec: PanelSpec = {
          label: c.id,
          source: {
            id: c.id, kind: 'neuron', url: c.url, title: c.id, method: tIn('zh', 'method.emSkeleton'), methodEn: tIn('en', 'method.emSkeleton'), resolution: null, year: 2025, tier: 'measured',
            licence: tIn('zh', 'licence.none'), licenceEn: tIn('en', 'licence.none'), attribution: tIn('zh', 'source.microns'), attributionEn: tIn('en', 'source.microns'), citation: `doi:${group.doi}`, link: group.link,
          },
          assembly: 'asym',
          entities: mol.entities.map((e, k) => ({ entityId: e.id, role: roles[k]!, name: e.description.split(' / ')[0]!, nameEn: e.description.split(' / ')[1], description: e.description, organism: group.species })),
          reason: '',
        }
        panels.push({ spec, mol, coloring, align: null, paper: null, annotation: null })
      })
      const notes: Note[] = [
        { key: 'note.microns.about', params: { n: cells.length } },
        ...(dropped > 0 ? [{ key: 'note.microns.cropped', params: { radius: group.radius } } as Note] : []),
        { key: 'note.microns.licence' },
        { key: 'note.neuron.thin' },
      ]
      const scene: SceneSpec = { topic: group.title, kind: 'neuron', title: group.title, titleEn: group.titleEn, caption: group.about, captionEn: group.aboutEn, panels: panels.map((p) => p.spec), notes, unit: 'µm', overlay: true }
      set((s) => ({ spec: scene, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('neuron', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1, complexes: null }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  async loadNeurons(hits) {
    const list = hits.slice(0, 4)
    if (list.length === 0) return
    set({ busy: say('busy.downloading', { name: list.map((h) => h.name).join(', ') }), error: '' })
    try {
      const roleOf: Record<string, Role> = { '1': 'focus', '2': 'nucleic-binding', '3': 'soluble', '4': 'membrane', '0': 'extracellular' }
      const panels: Panel[] = []
      for (const h of list) {
        const url = neuromorphoUrl(h.archive, h.name)
        let text = ''
        for (const u of [`/api/structure?url=${encodeURIComponent(url)}`, url]) {
          const res = await fetch(u).catch(() => null)
          if (res?.ok) {
            text = await res.text()
            break
          }
        }
        if (!text) throw noteError('error.neuronFetch', { title: h.name, titleEn: h.name })
        const mol = neuronMolecule(parseSwc(text), h.name, h.name, DENSE)
        const roles = mol.entities.map((e) => roleOf[e.id] ?? 'soluble')
        const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
        const label = `${h.species} · ${h.cellType.split(',')[0]} · ${h.name}`
        const spec: PanelSpec = {
          label,
          source: {
            id: h.name, kind: 'neuron', url, title: label, method: tIn('zh', 'method.reconstruction'), methodEn: tIn('en', 'method.reconstruction'), resolution: null, year: null, tier: 'measured',
            licence: 'CC BY 4.0', attribution: tIn('zh', 'source.neuromorpho', { archive: h.archive }), attributionEn: tIn('en', 'source.neuromorpho', { archive: h.archive }), citation: h.doi ? `doi:${h.doi}` : '', link: `https://neuromorpho.org/neuron_info.jsp?neuron_name=${encodeURIComponent(h.name)}`,
          },
          assembly: 'asym',
          entities: mol.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description.split(' / ')[0]!, nameEn: e.description.split(' / ')[1], description: e.description, organism: h.species })),
          reason: '',
        }
        panels.push({ spec, mol, coloring, align: null, paper: null, annotation: null })
      }
      const notes: Note[] = [
        ...list.map((h): Note => ({ key: 'note.neuron.found', params: { species: h.species, region: h.region, cellType: h.cellType, domain: h.domain } })),
        ...(list.length > 1 ? [{ key: 'note.neuron.sideBySide' } as Note] : []),
        { key: 'note.neuron.thin' },
      ]
      const title = list.map((h) => h.name).join(' · ')
      const scene: SceneSpec = { topic: title, kind: 'neuron', title, caption: '', panels: panels.map((p) => p.spec), notes, unit: 'µm' }
      set((s) => ({ spec: scene, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: 0, cutDefault: 0, style: styleFor('neuron', s.drawing), rounds: [], busy: '', sceneRev: s.sceneRev + 1, complexes: null }))
    } catch (e) {
      set({ busy: '', error: errorNote(e) })
    }
  },

  setAssembly(panel, id) {
    set((s) => ({
      panels: s.panels.map((p, i) => (i === panel ? { ...p, spec: { ...p.spec, assembly: id } } : p)),
      zoom: 1,
      shift: [0, 0],
      sceneRev: s.sceneRev + 1,
    }))
  },

  setRole(panel, entity, role) {
    set((s) => ({
      colorings: s.colorings.map((c, i) => {
        if (i !== panel) return c
        const roles = c.roles.slice()
        roles[entity] = role
        return spreadHues({ ...c, roles })
      }),
    }))
  },

  async setColorMode(mode) {
    const needs = mode === 'domains' || mode === 'sites' || mode === 'pathogenicity'
    if (needs && get().panels.some((p) => p.annotation === undefined)) {
      set({ busy: say('busy.annotations') })
      const panels = await Promise.all(get().panels.map(async (p) => (p.annotation !== undefined ? p : { ...p, annotation: await api.annotations(p.spec.source.id) })))
      set({ panels, busy: '' })
    }
    set((s) => ({ colorings: s.colorings.map((c) => ({ ...c, mode })) }))
  },

  setDrawing(drawing) {
    const sp = get().spec
    // 带“理想化排布”的模型两种画法用的排布不同，要重新载入 / a model with an idealised arrangement uses a different arrangement in each drawing and has to be reloaded
    const entry = sp?.catalog ? (catalog.models as CatalogEntry[]).find((m) => m.id === sp.catalog) : undefined
    if (entry?.infer) {
      set({ drawing })
      void get().loadCatalog(entry.id)
      return
    }
    // 细胞和密度图这类网格场景有自己调过的画法，不跟着换 / mesh scenes such as cells and density maps keep their own tuned style
    const kind = sp?.landscape ? 'landscape' : sp?.mesoscale ? 'mesoscale' : sp?.kind === 'neuron' ? 'neuron' : 'molecule'
    set((s) => ({ drawing, style: sp && !get().panels.some((p) => p.mol.triangles) ? styleFor(kind, drawing) : s.style, colorings: s.colorings.slice() }))
  },

  setStyle(patch) {
    const style = cloneStyle(get().style)
    patch(style)
    set({ style })
  },

  setLook(patch) {
    set(patch)
  },

  getLook() {
    const s = get()
    return structuredClone({ rot: s.rot, zoom: s.zoom, shift: s.shift, style: s.style, colorings: s.colorings, cut: s.cut })
  },

  resetView() {
    set((s) => ({ ...freshLook(), cut: s.cutDefault }))
  },

  applyEdits(edits) {
    const s = get()
    let rot = s.rot, zoom = s.zoom, cut = s.cut
    let shift: [number, number] = [...s.shift]
    const style = cloneStyle(s.style)
    const colorings = structuredClone(s.colorings)
    for (const e of edits) {
      switch (e.op) {
        case 'rotate': {
          const a = (e.degrees * Math.PI) / 180
          rot = mul3(e.axis === 'x' ? axisAngle(1, 0, 0, a) : e.axis === 'y' ? axisAngle(0, 1, 0, a) : axisAngle(0, 0, 1, a), rot)
          break
        }
        case 'zoom': zoom = Math.min(4, Math.max(0.25, zoom * e.factor)); break
        case 'pan': shift = [shift[0] + e.dx, shift[1] + e.dy]; break
        case 'set_role':
        case 'hue_shift': {
          const c = colorings[e.panel], mol = s.panels[e.panel]?.mol
          const idx = mol ? mol.entities.findIndex((x) => x.id === e.entity_id) : -1
          if (!c || idx < 0) break
          if (e.op === 'set_role') {
            c.roles[idx] = e.role
            colorings[e.panel] = spreadHues(c)
          } else c.nudge[idx] = Math.max(-60, Math.min(60, (c.nudge[idx] ?? 0) + e.degrees))
          break
        }
        case 'cut': cut = e.value; break
        case 'color_mode': void get().setColorMode(e.mode); break
        case 'line_width': style.lineWidth = e.value; break
        case 'inner_lines': style.contour.diffMax = e.value; break
        case 'shadow_strength': style.shadow.strength = e.value; break
        case 'shadow_floor': style.shadow.floor = e.value; break
        case 'fog_back': style.fog.back = e.value; break
        case 'background': style.background = parseHex(e.hex); break
      }
    }
    set({ rot, zoom, shift, style, colorings, cut })
  },
}))

// `t` 读的是 i18n 里的镜像；不管语言是怎么改的，都让它跟上
// `t` reads the mirror kept in i18n; keep it in step however the language was changed
useStore.subscribe((s) => s.lang !== getLang() && syncLang(s.lang))
