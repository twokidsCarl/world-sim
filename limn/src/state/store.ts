import { create } from 'zustand'
import * as api from '../api'
import { download, loadMolecule } from '../mol/load'
import { bin, dilate, parseMrc, surfacePoints, voxelIndex } from '../volume/mrc'
import { El, IDENTITY } from '../mol/types'
import { superpose } from '../mol/superpose'
import type { Molecule } from '../mol/types'
import { axisAngle, identity3, mul3, type Mat3 } from '../render/camera'
import { loadLipids, type LipidSet } from '../landscape/lipid'
import { fitFromPdbtm, fitToMembrane, type MembraneFit } from '../landscape/orient'
import type { Annotation, ColorMode } from '../style/annotate'
import { cloneStyle, STYLE_LANDSCAPE, STYLE_MESOSCALE, STYLE_MOLECULE, STYLE_NEURON, type Style } from '../render/style'
import type { Edit } from '../refine/edits'
import { defaultAssembly } from '../scene/build'
import type { PanelSpec, SceneSpec, Tier } from '../scene/spec'
import catalog from '../../data/catalog.json'
import neuronTable from '../../data/neurons.json'
import cellTable from '../../data/cells.json'
import { readN5Mask } from '../volume/n5'
import { neuromorphoUrl, neuronMolecule, parseSwc } from '../neuro/swc'
import { coarsen } from '../mol/coarse'
import { assemblyAtPoints, parsePicks } from '../mol/points'
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
}

interface State extends Look {
  spec: SceneSpec | null
  panels: Panel[]
  /** 每当 GPU 上的原子必须重建时加一 / bumped whenever the atoms on the GPU must be rebuilt */
  sceneRev: number
  /** 加一以要求舞台重画 / bumped to ask the stage to draw again */
  drawRev: number
  busy: string
  error: string
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
  /** `title`：目录里给这个结构起的名字，有就用它作标题 / `title`: the name a catalogue gives the structure, used as the title when given */
  loadId(id: string, title?: string): Promise<void>
  loadCatalog(id: string): Promise<void>
  /** 载入目录里的一个神经元形态重建 / load a neuron reconstruction from the catalogue */
  loadNeuron(id: string): Promise<void>
  /** 载入一张 EMDB 密度图（编号的数字部分），有拟合的原子模型就叠在里面 / load an EMDB density map (the digits of its id), with its fitted atomic model inside when there is one */
  loadEmdb(n: string): Promise<void>
  /** 载入一个细胞的细胞器分割（目录里的 id）/ load the organelle segmentation of a cell (an id in the catalogue) */
  loadCell(id: string): Promise<void>
  setAssembly(panel: number, id: string): void
  setRole(panel: number, entity: number, role: Role): void
  /** 换上色方式；需要时先去取注释 / change the colour mode, fetching annotation first when it is needed */
  setColorMode(mode: ColorMode): Promise<void>
  setStyle(patch: (s: Style) => void): void
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
  keywords: string[]
  source: { kind: string; url?: string; id?: string }
  perCopy?: boolean
  /** 粒子的实测位置：文件地址和体素大小（Å）/ measured particle positions: the file's address and the voxel size in Å */
  points?: { url: string; voxelSpacing: number }
  merge?: string
  cut?: number
  roles?: string[][]
  caption: string
  tier: string
  licence: string
  attribution: string
  citation: string
  link: string
}

/** 膜的颜色：淡黄绿，取自 Goodsell 的膜 / the membrane wash: pale yellow-green, as in Goodsell's membranes */
export const MEMBRANE_LCH: [number, number, number] = [0.8, 0.085, 112]

export const CATALOG = catalog.models as CatalogEntry[]

const freshLook = (): Pick<Look, 'rot' | 'zoom' | 'shift'> => ({ rot: identity3(), zoom: 1, shift: [0, 0] })

/** 下载进度写到状态栏，每秒最多几次 / download progress for the status line, a few times a second at most */
function progress(name: string): (received: number, total: number) => void {
  let last = 0
  return (received, total) => {
    const now = performance.now()
    if (now - last < 250) return
    last = now
    const mb = (n: number) => (n / 1e6).toFixed(1)
    useStore.setState({ busy: `正在下载 ${name}… ${mb(received)}${total ? ' / ' + mb(total) : ''} MB` })
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
  spec: null,
  panels: [],
  ...freshLook(),
  cut: 0,
  style: cloneStyle(STYLE_MOLECULE),
  colorings: [],
  sceneRev: 0,
  drawRev: 0,
  busy: '',
  error: '',
  rounds: [],
  refining: '',
  lipids: null,
  seed: 1,
  placed: [],
  dnaPairs: 0,

  repack() {
    set((s) => ({ seed: s.seed + 1, sceneRev: s.sceneRev + 1 }))
  },

  async resolveTopic(topic) {
    set({ busy: '正在理解主题并检索结构数据库（约半分钟）…', error: '' })
    try {
      const { spec } = await api.resolve(topic)
      if (spec.catalog) return await get().loadCatalog(spec.catalog)
      set({ busy: `正在下载 ${spec.panels.map((p) => p.source.id).join('、')}…` })
      const panels = await Promise.all(spec.panels.map(loadPanel))
      if (spec.landscape) {
        const lipids = spec.landscape.membrane ? await loadLipids(spec.landscape.membraneType) : null
        if (lipids) spec.notes = [...spec.notes.filter((n) => !/脂质用同一种磷脂/.test(n)), `膜的脂质组成：${lipids.name}。${lipids.basis}${lipids.citation ? `出处：${lipids.citation}。` : ''}每种脂质用数据库里的理想坐标，尾链已转到同一侧；位置随机，构象都相同。`]
        // 膜蛋白：向 OPM 要它在膜里的取向，叠合到我们手上的坐标
        // membrane proteins: ask OPM how each sits in the membrane and fit that to the coordinates in hand
        const oriented: string[] = []
        await Promise.all(
          spec.landscape.ingredients.filter((g) => g.compartment === 'membrane').map(async (g) => {
            const p = panels[g.panel]!
            if (p.spec.source.kind !== 'pdb') return
            const data = await api.membrane(p.spec.source.id)
            p.membrane = data?.orientation ? fitToMembrane(p.mol, data.orientation) : data?.pdbtm ? fitFromPdbtm(p.mol, data.pdbtm, data.topology ?? {}) : null
            if (p.membrane) oriented.push(`${p.spec.label}（${p.membrane.source}）`)
          }),
        )
        if (oriented.length) spec.notes = [`${oriented.join('、')} 在膜里的位置和倾角取自膜蛋白取向数据库（OPM；OPM 没有的用 PDBTM，并按 UniProt 的拓扑注释定哪面朝外）。这些取向是由实验结构计算得到的，不是直接测量。`, ...spec.notes.filter((n) => !/^膜蛋白按分子长轴/.test(n) || oriented.length < spec.landscape!.ingredients.filter((g) => g.compartment === 'membrane').length)]
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
        set((s) => ({ spec, panels, colorings, lipids, ...freshLook(), cut: 0, style: cloneStyle(STYLE_LANDSCAPE), rounds: [], placed: [], busy: '', sceneRev: s.sceneRev + 1 }))
        return
      }
      // 同一蛋白质的各个面板转到共同的朝向，
      // 这样它们之间变化的是分子而不是相机。
      // Panels of the same protein are turned to a common orientation, so
      // that what changes between them is the molecule and not the camera.
      const aligned: string[] = []
      for (const p of panels.slice(1)) {
        const fit = superpose(p.mol, panels[0]!.mol)
        if (fit) {
          p.align = fit.matrix
          aligned.push(`${p.mol.id}（${fit.matched} 个残基，偏差 ${fit.rmsd.toFixed(1)} Å）`)
        }
      }
      if (aligned.length) spec.notes = [...spec.notes, `为便于比较，已按共同的蛋白链把 ${aligned.join('、')} 叠合到 ${panels[0]!.mol.id} 的朝向。`]
      set((s) => ({ spec, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: 0, style: cloneStyle(STYLE_MOLECULE), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
      fetchPapers()
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadId(id, title) {
    const clean = id.trim().toUpperCase()
    // "AF-P04637"：AlphaFold 数据库里这个 UniProt 编号的预测模型 / "AF-P04637": the AlphaFold DB model for that UniProt accession
    // "EMD-21317"：EMDB 里的一张密度图 / "EMD-21317": a density map in the EMDB
    const em = /^EMD-?(\d{4,6})$/.exec(clean)
    if (em) return get().loadEmdb(em[1]!)
    const af = /^AF-([A-Z0-9]{6,10})$/.exec(clean)
    if (!af && !/^[0-9][A-Z0-9]{3}$/.test(clean)) {
      set({ error: 'PDB 编号是 4 位，以数字开头，例如 2HHB；AlphaFold 预测模型写成 AF-加 UniProt 编号，例如 AF-P04637；电镜密度图写成 EMD-加数字，例如 EMD-1080' })
      return
    }
    set({ busy: `正在下载 ${clean}…`, error: '' })
    try {
      const prediction = af ? await api.alphafold(af[1]!) : null
      if (af && !prediction) throw new Error(`AlphaFold 数据库里没有 ${af[1]} 的预测模型（或本地服务没有启动）`)
      const mol = await loadMolecule(prediction ? { kind: 'url', id: clean, url: prediction.url, minConfidence: 50 } : { kind: 'pdb', id: clean }, progress(clean))
      const coloring = defaultColoring(mol)
      const spec: PanelSpec = {
        label: clean,
        source: prediction ? { id: clean, kind: 'alphafold', url: prediction.url, title: mol.title, method: 'AlphaFold 预测', resolution: null, year: null, tier: 'predicted' } : { id: clean, kind: 'pdb', title: mol.title, method: '', resolution: null, year: null },
        assembly: defaultAssembly(mol),
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: e.description || e.kind, description: e.description, organism: '' })),
        reason: '',
      }
      const scene: SceneSpec = { topic: clean, kind: 'molecule', title: title || mol.title || clean, caption: '', panels: [spec], notes: prediction ? [`这是 AlphaFold 预测模型，不是实验结构；置信度低于 50 的区域没有画（${Math.round(prediction.confident * 100)}% 的残基置信度在 70 以上）。`] : [] }
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null }], colorings: [coloring], ...freshLook(), cut: 0, style: cloneStyle(STYLE_MOLECULE), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
      fetchPapers()
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadCatalog(id) {
    const entry = (catalog.models as CatalogEntry[]).find((m) => m.id === id)
    if (!entry) {
      set({ error: `目录里没有 ${id}` })
      return
    }
    set({ busy: `正在下载 ${entry.title}…`, error: '' })
    try {
      const src = entry.source
      let mol = await loadMolecule(src.kind === 'pdb' ? { kind: 'pdb', id: src.id! } : { kind: 'url', id: entry.id, url: src.url! }, progress(entry.title))
      const notes: string[] = []
      let assembly = defaultAssembly(mol)
      if (entry.points) {
        // 实测的粒子位置：每个位置放一份原子模型 / measured particle positions: one copy of the atomic model at each
        set({ busy: `正在下载 ${entry.title} 的粒子位置…` })
        const res = await fetch(entry.points.url)
        if (!res.ok) throw new Error(`没能取到粒子位置（HTTP ${res.status}）：${new URL(entry.points.url).hostname}`)
        const pts = parsePicks(await res.text(), entry.points.voxelSpacing)
        if (pts.length === 0) throw new Error('粒子位置文件里没有读到位置')
        mol.assemblies.push(assemblyAtPoints(mol, assembly, pts, rng(1)))
        assembly = 'picks'
        notes.push(`${pts.length / 3} 个粒子的位置取自断层扫描的标注（实测）；每个粒子的朝向没有采用数据集里的值，是随机的：数据集的朝向参照的坐标系和这里用的原子模型对不上。`)
      }
      // 原子太多就改画每个残基一个球 / with too many atoms, draw one sphere per residue instead
      const full = placedAtomCount(mol, assembly)
      if (full > ATOM_BUDGET) {
        mol = coarsen(mol)
        notes.push(`完整模型有 ${(full / 1e6).toFixed(0)} 百万个原子，超出了能流畅绘制的范围，这里每个残基只画一个球（脂质每个分子画三个球）。`)
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
      const short = (d: string) => d.split('.').pop()!.replace(/_/g, ' ')
      const spec: PanelSpec = {
        label: entry.title,
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
          citation: entry.citation,
          link: entry.link,
          tier: entry.tier as Tier,
        },
        assembly,
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: short(e.description) || e.kind, description: e.description, organism: '' })),
        reason: '',
      }
      const mesoscale = !!entry.perCopy
      if (mesoscale && !entry.points) notes.push('这是别人已发表的整体模型：其中每个分子是真实结构，位置和数量由模型作者依据实验数据排布，不是直接观测到的。')
      const scene: SceneSpec = { topic: entry.title, kind: mesoscale ? 'model' : 'virus', title: entry.title, caption: entry.caption, panels: [spec], notes, mesoscale, merge: entry.merge }
      set((s) => ({
        spec: scene,
        panels: [{ spec, mol, coloring, align: null }],
        colorings: [coloring],
        ...freshLook(),
        cut: entry.cut ?? 0,
        style: cloneStyle(mesoscale ? STYLE_MESOSCALE : STYLE_MOLECULE),
        rounds: [],
        busy: '',
        sceneRev: s.sceneRev + 1,
      }))
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadEmdb(n) {
    set({ busy: `正在查询 EMD-${n}…`, error: '' })
    try {
      const info = await api.emdb(n)
      if (!info) throw new Error(`没有找到 EMD-${n}（或本地服务没有启动）`)
      if (info.contour === null) throw new Error(`EMD-${n} 没有给出等值面阈值，画不了`)
      if (info.megabytes > 420) throw new Error(`EMD-${n} 的密度图有 ${info.megabytes} MB，太大了`)
      const report = progress(`${info.id} 的密度图（共约 ${info.megabytes} MB，压缩后更小）`)
      let buf: Uint8Array | null = null
      for (const u of [`/api/structure?url=${encodeURIComponent(info.url)}`, info.url]) {
        buf = await download(u, report).catch(() => null)
        if (buf) break
      }
      if (!buf) throw new Error(`没能取到 ${info.id} 的密度图：它要从 ftp.ebi.ac.uk 现取，请检查网络后重试。`)
      set({ busy: `正在从 ${info.id} 的密度图取等值面…` })
      await new Promise((r) => setTimeout(r, 30))
      const full = parseMrc(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      // 最长边合并到 200 个体素以内，够画，也不至于太慢 / bin to at most 200 voxels a side: enough to draw, and not too slow
      const vol = bin(full, 200)
      const pts = surfacePoints(vol, info.contour)
      if (pts.length === 0) throw new Error(`${info.id} 在阈值 ${info.contour} 处没有等值面`)
      const count = pts.length / 3
      const map: Molecule = {
        id: info.id, title: info.title, atomCount: count, pos: pts,
        element: new Uint8Array(count).fill(El.N),
        // 每个点一个球，半径略小于一个体素，相邻的球正好连成面 / a sphere per point, a little under a voxel in radius, so that neighbours just join into a surface
        radius: new Float32Array(count).fill(vol.voxel[0] * 0.9),
        chainOf: new Uint32Array(count), isTrace: new Uint8Array(count), residue: new Int32Array(count).fill(1),
        chains: [{ asymId: 'map', authAsymId: 'map', entity: 0, start: 0, count, model: 1 }],
        entities: [{ id: 'map', description: '密度图的等值面 / isosurface of the density map', kind: 'protein' }],
        assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
      }
      const binned = vol.voxel[0] / full.voxel[0]
      const mapColoring: Coloring = { roles: ['soluble'], hueShift: [0], nudge: [0], override: [[0.87, 0.035, 250]] }
      const mapSpec: PanelSpec = {
        label: info.id,
        source: { id: info.id, kind: 'emdb', url: info.url, title: info.title, method: '电镜密度图', resolution: info.resolution, year: null, tier: 'measured', licence: 'CC0 1.0', attribution: 'EMDB', citation: info.id, link: `https://www.ebi.ac.uk/emdb/${info.id}` },
        assembly: 'asym',
        entities: [{ entityId: 'map', role: 'soluble', name: '密度图的等值面', description: info.title, organism: '' }],
        reason: '',
      }
      const panels: Panel[] = [{ spec: mapSpec, mol: map, coloring: mapColoring, align: null, paper: null, annotation: null }]
      const notes = [
        `这是电镜实验得到的三维密度图（${info.dims.join('×')} 个体素，每个 ${info.voxel.toFixed(2)} Å），画的是作者建议的阈值 ${info.contour} 处的等值面${binned > 1 ? `；为了画得动，体素按 ${binned} 倍合并过` : ''}。`,
        '表面是用一个个小球拼出来的（每个被等值面穿过的小格一个球），不是三角网格；阈值取得高一点或低一点，表面会瘦一点或胖一点。',
      ]
      // 拟合进这张图的原子模型和它在同一个坐标系里，直接叠进去 / the atomic model fitted into this map shares its coordinate frame and goes straight in
      const pdbId = info.pdb[0]
      if (pdbId) {
        set({ busy: `正在下载拟合的原子模型 ${pdbId}…` })
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
          notes.push(`里面是拟合进这张图的原子模型 ${pdbId}。密度图从正中剖开（“剖开”滑杆可调），原子模型不切，这样能看到模型怎样填在密度里。`)
        }
      }
      const overlay = panels.length > 1
      const scene: SceneSpec = { topic: info.id, kind: 'molecule', title: info.title || info.id, caption: '', panels: panels.map((p) => p.spec), notes, overlay }
      set((s) => ({ spec: scene, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), cut: overlay ? 0.5 : 0, style: cloneStyle(STYLE_MOLECULE), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
      fetchPapers()
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadCell(id) {
    const entry = cellTable.cells.find((c) => c.id === id)
    if (!entry) {
      set({ error: `目录里没有 ${id}` })
      return
    }
    set({ busy: `正在下载 ${entry.title}…`, error: '' })
    try {
      const pos: number[] = [], radius: number[] = []
      const chains: Molecule['chains'] = [], entities: Molecule['entities'] = []
      const roles: Role[] = []
      const missing: string[] = []
      let voxel = [0, 0, 0]
      let nearNucleus: { vol: Awaited<ReturnType<typeof readN5Mask>>; mask: Uint8Array } | null = null
      for (const o of entry.organelles) {
        const vol = await readN5Mask(`${entry.base}/${o.label}/${entry.scale}`, (done, total) => set({ busy: `正在下载 ${o.name}的分割数据… ${done}/${total} 块` })).catch(() => null)
        if (!vol) {
          missing.push(o.name)
          continue
        }
        voxel = vol.voxel
        set({ busy: `正在取 ${o.name}的表面…` })
        await new Promise((r) => setTimeout(r, 20))
        const pts = surfacePoints(vol, 0.5)
        if (pts.length === 0) {
          missing.push(o.name)
          continue
        }
        const start = pos.length / 3
        // 每个表面点一个球，半径略小于一个体素 / a sphere on every surface point, a little under a voxel in radius
        const r = Math.min(...vol.voxel) * 0.95
        // 核膜算在内质网的分割里，紧贴着细胞核的表面；两层表面叠在一起会互相抢，所以别的细胞器贴着细胞核的那部分不画
        // the nuclear envelope belongs to the ER segmentation and lies right on the nucleus's surface; two coincident surfaces fight over every pixel, so the part of any other organelle that hugs the nucleus is not drawn
        if (o.label === 'nucleus_seg') nearNucleus = { vol, mask: dilate(vol, 2) }
        const near = o.label !== 'nucleus_seg' ? nearNucleus : null
        for (let i = 0; i < pts.length; i += 3) {
          if (near) {
            const k = voxelIndex(near.vol, pts[i]!, pts[i + 1]!, pts[i + 2]!)
            if (k >= 0 && near.mask[k]) continue
          }
          pos.push(pts[i]!, pts[i + 1]!, pts[i + 2]!)
          radius.push(r)
        }
        if (pos.length / 3 === start) {
          missing.push(o.name)
          continue
        }
        entities.push({ id: o.label, description: `${o.name} / ${o.nameEn}`, kind: 'protein' })
        chains.push({ asymId: o.label, authAsymId: o.label, entity: entities.length - 1, start, count: pos.length / 3 - start, model: 1 })
        roles.push(o.role as Role)
      }
      const count = pos.length / 3
      if (count === 0) throw new Error(`没能取到 ${entry.title} 的数据：它要从 OpenOrganelle（亚马逊云存储）现取，请检查网络后重试。`)
      const chainOf = new Uint32Array(count)
      chains.forEach((c, i) => chainOf.fill(i, c.start, c.start + c.count))
      const mol: Molecule = {
        id: entry.id, title: entry.titleEn, atomCount: count, pos: new Float32Array(pos), element: new Uint8Array(count).fill(El.N), radius: new Float32Array(radius),
        chainOf, isTrace: new Uint8Array(count), residue: new Int32Array(count).fill(1), chains, entities,
        assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
      }
      const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
      const spec: PanelSpec = {
        label: entry.title,
        source: { id: entry.id, kind: 'cell', url: entry.base, title: entry.titleEn, method: '聚焦离子束扫描电镜 + 机器学习分割', resolution: null, year: null, tier: 'measured', licence: entry.licence, attribution: entry.attribution, citation: entry.citation, link: entry.link },
        assembly: 'asym',
        entities: entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description.split(' / ')[0]!, description: e.description, organism: 'Homo sapiens' })),
        reason: '',
      }
      const notes = [
        `这不是原子图，是电镜下一整个细胞的细胞器轮廓，长度单位是纳米。用的是原数据缩小 16 倍的版本：每个体素约 ${voxel.map((v) => Math.round(v)).join('×')} nm，比它细的结构（细的内质网小管、小泡）看不出来或者断开。`,
        '细胞器的边界是机器学习模型逐个体素判断出来的，不是人工描的，局部会有错。表面是用一个个小球拼出来的。',
        '核膜在数据里算作内质网，紧贴着细胞核；贴着细胞核两个体素以内的内质网等没有画，免得和细胞核的表面叠在一起。',
        ...(missing.length ? [`没能取到：${missing.join('、')}。`] : []),
      ]
      const scene: SceneSpec = { topic: entry.title, kind: 'neuron', title: entry.title, caption: entry.caption, panels: [spec], notes, unit: 'nm' }
      // 贴壁的细胞是扁的：从上往下看，在半高处剖开；结构很碎，线画细一些
      // a cell grown on a surface is flat: look down on it, cut at mid-height; the structures are fine-grained, so lines are drawn thinner
      const thin = cloneStyle(STYLE_MOLECULE)
      thin.lineWidth = 0.6
      thin.shadow.floor = 0.8
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null, paper: null, annotation: null }], colorings: [coloring], ...freshLook(), rot: axisAngle(1, 0, 0, Math.PI / 2), cut: 0.45, style: thin, rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadNeuron(id) {
    const entry = neuronTable.neurons.find((n) => n.id === id)
    if (!entry) {
      set({ error: `目录里没有 ${id}` })
      return
    }
    set({ busy: `正在下载 ${entry.title}…`, error: '' })
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
      if (!text) throw new Error(`没能取到 ${entry.title}：它要从 neuromorpho.org 现取，请检查网络后重试。`)
      const mol = neuronMolecule(parseSwc(text), entry.name, entry.titleEn)
      // 胞体是主角；轴突、基树突、顶树突各用一个色相区 / the soma is the subject; axon, basal and apical dendrites each take a hue sector
      const roleOf: Record<string, Role> = { '1': 'focus', '2': 'nucleic-binding', '3': 'soluble', '4': 'membrane', '0': 'extracellular' }
      const roles = mol.entities.map((e) => roleOf[e.id] ?? 'soluble')
      const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) }
      const spec: PanelSpec = {
        label: entry.title,
        source: {
          id: entry.name, kind: 'neuron', url, title: entry.titleEn, method: '显微重建', resolution: null, year: null, tier: 'measured',
          licence: 'CC BY 4.0', attribution: `NeuroMorpho.Org，${entry.archive} 档案`, citation: `doi:${entry.doi}`, link: `https://neuromorpho.org/neuron_info.jsp?neuron_name=${encodeURIComponent(entry.name)}`,
        },
        assembly: 'asym',
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description.split(' / ')[0]!, description: e.description, organism: entry.species })),
        reason: '',
      }
      const notes = [
        `这是从显微图像描出来的神经元形态（${entry.species}，${entry.region}）：${entry.has}。坐标和粗细的单位是微米，不是原子图。`,
        '比线还细的分支画粗了一点，否则看不见；每一段按两端的半径线性过渡。重建本身的粗细常常不如走向可靠。',
      ]
      const scene: SceneSpec = { topic: entry.title, kind: 'neuron', title: entry.title, caption: '', panels: [spec], notes, unit: 'µm' }
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null, paper: null, annotation: null }], colorings: [coloring], ...freshLook(), cut: 0, style: cloneStyle(STYLE_NEURON), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
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
      set({ busy: '正在查询结构域和位点注释…' })
      const panels = await Promise.all(get().panels.map(async (p) => (p.annotation !== undefined ? p : { ...p, annotation: await api.annotations(p.spec.source.id) })))
      set({ panels, busy: '' })
    }
    set((s) => ({ colorings: s.colorings.map((c) => ({ ...c, mode })) }))
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
    set(freshLook())
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
