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
import { clipToCavity, fibonacciSphere, helicalLayer, layerOnSphere, rnaPath, rnpBundle, shell } from '../infer/influenza'
import { outsideOf, randomRotation, scatter, serpentine, stringThrough, threads, type Box } from '../infer/environment'
import { chainCentre, complexes, exaggerate, lobed, placeTemplate, ringSites, shellMembrane, subMolecule, templateOf } from '../infer/idealise'
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
  /** 单个分子的场景里：这个面板的每份拷贝是一个完整的分子，整个留或整个切（示意的环境）/ in a single-molecule scene: every copy in this panel is a whole molecule, kept or cut whole (a schematic environment) */
  perCopy?: boolean
  /** 示意的环境：拖动时不画（见 RenderItem.decor）/ a schematic environment: not drawn while dragging (see RenderItem.decor) */
  decor?: boolean
  /** 垫在后面的底色，比切面再退这么多（Å）才画（见 Placement.ground）/ a ground laid behind, drawn only this far (Å) behind the cut (see Placement.ground) */
  ground?: number
  /** 当两个面板共有一种蛋白质时，把本面板转到与第一个一致 / turns this panel to match the first one, when they share a protein */
  align: Float32Array | null
  /** 全景里的膜蛋白：OPM 给出的膜内取向 / for a membrane protein in a landscape: its orientation in the membrane from OPM */
  membrane?: MembraneFit | null
  /** 逐残基注释，第一次用到按残基上色时才取；null 表示取过但没有 / per-residue annotation, fetched the first time a per-residue colour mode is used; null means fetched and absent */
  annotation?: Annotation | null
  /** 这个结构的主要引文，载入后异步取来 / the structure's primary citation, fetched after loading */
  /** 剖开时不切这个面板（密度图里的原子模型）/ this panel is left whole by a cut (the atomic model inside a density map) */
  noCut?: boolean
  /** 切片的背面不切这个面板 / this panel is not cut at the back of a slab */
  keepBack?: boolean
  /** 这个面板的所有拷贝共用一个编号，彼此之间不画线 / every copy of this panel shares one id, with no lines between them */
  oneId?: boolean
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
  /** 手绘画法下把刺的形状夸张成 Goodsell 画的那样（细长的柄、宽的头）；不是真实的形状 / in the painted drawing, exaggerate spikes the way Goodsell paints them (a long thin stalk, a wide head); not their real shape */
  exaggerate: boolean
  setExaggerate(on: boolean): void
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
  /** 手绘画法下把小分子画成圆点的半径（Å）；夸张，可以关 / the radius in Å of the dots small molecules become in the painted drawing; an exaggeration that can be turned off */
  dots?: number
  cut?: number
  /** 衬在切片后面的实体（正则）/ entities that line the back of the slab (a regular expression) */
  lining?: string
  /**
   * 膜上某种蛋白的数量按文献推断、位置重排成等间隔的环：pattern 是它的实体名，count 是推断的数量，source 是出处。
   * A membrane protein whose number is inferred from the literature and whose copies are re-set in evenly spaced rings: `pattern` names its entity, `count` is the inferred number, `source` where it comes from.
   */
  respike?: { pattern: string; count: number; source: string; shape?: Parameters<typeof exaggerate>[2] }
  /** 手绘画法下把膜上的蛋白重排成等间隔的一圈圈，膜换成光滑的球壳（见 arrange）：`pattern` 匹配要排的蛋白，`exclude` 排除，`reach` 是离膜中面多远以内算膜上的（Å），`lining` 是衬在膜里面的一层的颜色（里面的空处露出它，膜的切口才读得出是一条带子）/ in the painted drawing, set the membrane's proteins out afresh in evenly spaced rings and make the membrane a smooth shell (see `arrange`): `pattern` matches the proteins, `exclude` leaves some out, `reach` is how far from the mid-plane still counts as on the membrane, in Å, `lining` the colour of a layer lining the inside (empty space within shows it, so the cut membrane reads as a band) */
  /** 手绘画法下给名字匹配的一个个团块补上把它们串起来的线（见 strung）/ in the painted drawing, supply the strand that strings together the clumps whose name matches (see `strung`) */
  string?: { pattern: string; name: string; nameEn: string; fill?: number; beadName?: string; beadNameEn?: string; radius: number; lch: [number, number, number]; basis: string; basisEn: string }
  /** 手绘画法下把整个对象再画一份，挪到旁边（单位是对象的半径），像正在分裂的两个细胞。数据里只有一个，第二个是示意 / in the painted drawing, draw the whole subject a second time, moved aside (in subject radii), like two cells in division. The data holds one; the second is schematic */
  twin?: number
  arrange?: { pattern: string; exclude?: string; reach?: number; lining?: [number, number, number]; whiskers?: [number, number] }
  /**
   * 周围的环境（示意）：几种蛋白随机摆在对象周围，外加若干条长链，底色用深色。basis 写明种类的依据。
   * The surrounding environment (schematic): a few proteins scattered round the subject, some long strands besides, on a dark ground. `basis` states the grounds for the kinds.
   */
  environment?: { proteins: { pdb: string; name: string; nameEn: string; count: number; lch: [number, number, number] }[]; strands?: { name: string; nameEn: string; count: number; length: number; radius: number; branches?: number; wander?: number; lch: [number, number, number] }; ground?: [number, number, number]; inside?: boolean; replace?: string; outside?: boolean; clear?: number; fringe?: { name: string; nameEn: string; count: number; length: number; radius: number; branches?: number; wander?: number; lch: [number, number, number]; thickness: number }; basis: string; basisEn: string }
  /** 手绘画法下的底色（场景的缝隙里露出的颜色），缺省是纸白 / the ground in the painted drawing (what shows in the gaps of a scene); paper white by default */
  ground?: [number, number, number]
  /** 膜的颜色 [L, C, h]，缺省是浅淡紫 / the membrane's colour [L, C, h]; a pale lavender by default */
  membrane?: [number, number, number]
  /** 按角色指定色族 {角色: [L, C, h]} / a family of hue per role, {role: [L, C, h]} */
  hues?: Partial<Record<Role, [number, number, number]>>
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
/** 刺的形状要不要夸张（见 src/infer/idealise.ts 的 exaggerate）/ whether spikes are exaggerated (see `exaggerate` in src/infer/idealise.ts) */
const EXAGGERATE = () => useStore.getState().exaggerate

/**
 * 概念“场景”：在对象周围填上环境（见 src/infer/environment.ts）。对象的范围取它各部分摆好之后离中心最远的地方。
 * The concept "scene": the environment is filled in round the subject (see src/infer/environment.ts). The subject's extent is the farthest any of its placed parts reaches from the centre.
 */
/** 环境铺到对象半径的多少倍；数量是按 1.5 倍定的，铺得更开时按面积补 / how many subject radii the environment reaches; counts were set for 1.5 and are topped up by area when it reaches farther */
const SPREAD = 1.8
/** 示意的环境最多这么多个球：再多，拖动和完整重画都会慢下来 / at most this many spheres of schematic environment: more, and both dragging and the full redraw slow down */
const ENV_BUDGET = 2_500_000
async function environmentPanels(entry: CatalogEntry, mols: Molecule[], assemblies: string[], mainAssembly: string, notes: Note[], busy: (name: string) => void): Promise<Panel[]> {
  const env = entry.environment!
  // replace：模型里名字匹配的那些东西拿掉，由下面生成的线代替（模型里的 DNA 弯而密，他画的直而稀）
  // replace: what the model holds under a matching name is taken out and the strands generated below stand in for it (the model's DNA is curved and dense; he paints it straight and sparse)
  if (env.replace) {
    const re = new RegExp(env.replace, 'i'), m = mols[0]!
    const asm = m.assemblies.find((a) => a.id === mainAssembly)
    if (asm) asm.groups = asm.groups.filter((g) => !g.chains.every((ci) => re.test(m.entities[m.chains[ci]!.entity]!.description)))
  }
  // 对象的中心和半径：各份拷贝的位置 / the subject's centre and radius, from where its copies stand
  const pts: number[] = []
  mols.forEach((m, i) => {
    const asm = m.assemblies.find((a) => a.id === (i === 0 ? mainAssembly : assemblies[i - 1])) ?? m.assemblies[m.assemblies.length - 1]
    for (const g of asm?.groups ?? []) {
      // 每条链都取点（原来只取第一条链的六个原子，量不到刺的顶端，环境就挤进刺之间了）
      // points are taken from every chain (it used to be six atoms of the first chain only, which missed the tips of spikes and let the environment in among them)
      for (const ci of g.chains.slice(0, 12)) {
       const ch = m.chains[ci]
       if (!ch) continue
       const step = Math.max(1, Math.floor(ch.count / (g.operators.length > 2000 ? 4 : 24)))
       for (const op of g.operators) for (let a = ch.start; a < ch.start + ch.count; a += step) {
        const x = m.pos[a * 3]!, y = m.pos[a * 3 + 1]!, z = m.pos[a * 3 + 2]!
        pts.push(op[0]! * x + op[4]! * y + op[8]! * z + op[12]!, op[1]! * x + op[5]! * y + op[9]! * z + op[13]!, op[2]! * x + op[6]! * y + op[10]! * z + op[14]!)
       }
      }
    }
  })
  const centre: V3 = [0, 0, 0]
  for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) centre[k]! += pts[i + k]! / (pts.length / 3)
  let R = 0
  for (let i = 0; i < pts.length; i += 3) R = Math.max(R, Math.hypot(pts[i]! - centre[0], pts[i + 1]! - centre[1], pts[i + 2]! - centre[2]))
  // 环境从哪里开始：不取最远的那一点（个别伸得很远的蛋白会在对象周围留下一圈空着的底色），取九成的点都在以内的半径
  // where the environment begins: not at the farthest point (a few far-reaching proteins would leave an empty ring of ground round the subject) but at the radius that holds nine tenths of the points
  const dist: number[] = []
  for (let i = 0; i < pts.length; i += 3) dist.push(Math.hypot(pts[i]! - centre[0], pts[i + 1]! - centre[1], pts[i + 2]! - centre[2]))
  dist.sort((x, y) => x - y)
  const near = dist[Math.floor(dist.length * 0.9)] ?? R
  // clear：在“九成的点以内”和“最远的点”之间取多少（1 = 最远的点，缺省；0 = 紧贴着对象）。伸出去的东西少而长时取小些，免得周围空一圈
  // clear: how far between "nine tenths of the points" and "the farthest point" the environment starts (1 = the farthest point, the default; 0 = hard against the subject). Smaller where what sticks out is sparse and long, so that no empty ring is left
  // 环境是立体的：填满对象周围的一个球（或对象的整个里面），由切面露出剖面，所以转到哪个角度都成立。
  // （原来只在切面后面铺薄薄一层，只有正面一个视角是对的。）数量是按那一薄层定的，这里按体积补上。
  // The environment is a solid: it fills a ball round the subject (or the whole inside of it) and the cut exposes a section, so it holds from any angle.
  // (It used to be one thin layer behind the cut, right from the front only.) Counts were set for that layer and are topped up by volume here.
  // inside：填对象的里面（数据里只有外壳时），范围取到外壳以内 / inside: fill the inside of the subject (when the data holds only its shell), within the shell
  const box: Box = env.inside ? { centre, hx: R, hy: R, z0: -R, z1: R, exclude: 0, within: R * 0.9 } : { centre, hx: R * SPREAD, hy: R * SPREAD, z0: -R * SPREAD, z1: R * SPREAD, exclude: near + (R - near) * (env.clear ?? 1) + 6, within: R * SPREAD }
  let volume = env.inside ? 6 : (SPREAD / 1.5) ** 2 * ((2 * SPREAD) / 0.42) * 0.52
  // outside：对象的形状不规则（一段树突），环境只填在它外面，范围是放大后的画面 / outside: the subject is of irregular shape (a stretch of dendrite); the environment fills only what lies outside it, over the zoomed frame
  if (env.outside) {
    const half = (R / (entry.zoom ?? 1)) * 1.25
    Object.assign(box, { hx: half, hy: half, z0: -half * 0.6, z1: half * 0.6, exclude: 0, within: undefined, free: outsideOf(pts, 70) })
    volume = 10
  }
  // replace 的条数在目录里直接按整个细胞给 / with `replace`, the catalogue gives the count for the whole cell outright
  if (env.replace) volume = 1
  const rand = rng(7)
  const placed: { p: V3; r: number }[] = []
  const panels: Panel[] = []
  const source = (id: string, link: string | undefined): PanelSpec['source'] => ({ id, kind: 'model', title: id, method: tIn('zh', 'method.schematicEnvironment'), methodEn: tIn('en', 'method.schematicEnvironment'), resolution: null, year: null, tier: 'estimated', licence: 'CC0 1.0', attribution: 'RCSB PDB', citation: id, link })
  // 先量每种蛋白有多少个球（每个残基一个），算出整个环境要压到几成 / first count each kind's spheres (one per residue), to work out how far the whole environment must be scaled down
  // 每个残基一个球：环境里要摆上万份，按原子画不动；平滑之后轮廓差不多
  // one sphere per residue: the environment holds thousands of copies, too many to draw atom by atom, and after smoothing the outline is much the same
  const coarse = await Promise.all(env.proteins.map(async (p) => {
    busy(p.pdb)
    return coarsen(await loadMolecule({ kind: 'pdb', id: p.pdb }))
  }))
  const sizes = coarse.map((m) => m.atomCount)
  const total = env.proteins.reduce((n, p, i) => n + p.count * volume * sizes[i]!, 0)
  const envScale = (_atoms: number) => Math.min(1, ENV_BUDGET / Math.max(1, total))
  // 大的先摆 / larger ones are placed first
  for (const [pi, p] of env.proteins.entries()) {
    const m = coarse[pi]!
    m.assemblies = m.assemblies.slice()
    const c: V3 = [0, 0, 0]
    for (let i = 0; i < m.atomCount; i++) for (let k = 0; k < 3; k++) c[k]! += m.pos[i * 3 + k]! / m.atomCount
    // 占的地方按均方根半径算（再放大一点），不按最远的原子：细长的分子（纤维蛋白原）按最远点算会占掉一个大球，周围什么都放不下
    // the room it takes goes by its root-mean-square radius (a little enlarged), not its farthest atom: a long thin molecule (fibrinogen) measured by its farthest point claims a large sphere in which nothing else can be put
    let r2 = 0, nr = 0
    for (let i = 0; i < m.atomCount; i += 5) {
      r2 += (m.pos[i * 3]! - c[0]) ** 2 + (m.pos[i * 3 + 1]! - c[1]) ** 2 + (m.pos[i * 3 + 2]! - c[2]) ** 2
      nr++
    }
    const r = Math.sqrt(r2 / Math.max(1, nr)) * 1.25
    // 份数按体积补，但整个环境合起来不超过 ENV_BUDGET 个球：按各种蛋白要的球数等比例压下去
    // copies are topped up by volume, but the whole environment stays within ENV_BUDGET spheres: every kind is scaled down in the same proportion
    const wanted = Math.round(p.count * volume)
    const ops = scatter(Math.max(1, Math.round(wanted * envScale(m.atomCount))), r, c, box, rand, placed)
    m.assemblies.push({ id: 'inferred', groups: [{ chains: m.chains.map((_, i) => i), operators: ops }] })
    const roles: Role[] = m.entities.map(() => 'extracellular')
    panels.push({
      spec: { label: `${p.name}（示意的环境）`, labelEn: `${p.nameEn} (schematic environment)`, source: source(`PDB ${p.pdb}`, `https://www.rcsb.org/structure/${p.pdb}`), assembly: 'inferred', entities: m.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: p.name, nameEn: p.nameEn, description: e.description, organism: '' })), reason: '' },
      mol: m, coloring: { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => p.lch) }, align: null, perCopy: true,
    })
  }
  type Strands = NonNullable<typeof env.strands>
  const strandPanel = (def: Strands, where: Box, id: string) => {
    const t = threads(def.count, def.length, 16, where, rand, def.branches ?? 0, def.wander)
    const n = t.pos.length / 3
    const m: Molecule = {
      id, title: def.nameEn, atomCount: n, pos: t.pos, element: new Uint8Array(n).fill(El.N), radius: new Float32Array(n).fill(def.radius),
      chainOf: new Uint32Array(n), isTrace: new Uint8Array(n).fill(1), residue: new Int32Array(n).fill(1), segments: t.segments,
      chains: [{ asymId: 'S', authAsymId: 'S', entity: 0, start: 0, count: n, model: 1 }], entities: [{ id, description: def.nameEn, kind: 'protein' }],
      assemblies: [{ id: 'inferred', groups: [{ chains: [0], operators: [IDENTITY] }] }],
    }
    panels.push({
      spec: { label: `${def.name}（示意的环境）`, labelEn: `${def.nameEn} (schematic environment)`, source: source(def.nameEn, undefined), assembly: 'inferred', entities: [{ entityId: id, role: 'extracellular', name: def.name, nameEn: def.nameEn, description: def.nameEn, organism: '' }], reason: '' },
      mol: m, coloring: { roles: ['extracellular'], hueShift: [0], nudge: [0], override: [def.lch] }, align: null,
    })
  }
  if (env.strands) strandPanel({ ...env.strands, count: Math.min(4000, Math.round(env.strands.count * volume)) }, box, 'strands')
  // 外面的一圈乱线（荚膜）：线限在膜外的一层里，贴着对象，杂乱但厚薄均匀
  // a fringe of tangled strands outside (a capsule): the strands are confined to a layer just outside the membrane, hugging the subject, tangled yet even in thickness
  if (env.fringe) {
    // 膜的外沿：有理想化的球壳就取它的，否则取“九成的点以内”的半径 / the membrane's outer edge: that of the idealised shell where there is one, otherwise the radius holding nine tenths of the points
    const shellMol = mols.find((m) => m.id.endsWith(':membrane'))
    let rim = near
    // 中心也取球壳自己的：各部分位置的平均会偏一点，偏了膜和这一圈之间就露一道缝 / the centre is the shell's own too: the mean of the parts' positions is a little off, and then a slit opens between the membrane and the fringe
    const c0: V3 = [centre[0], centre[1], centre[2]]
    if (shellMol) {
      for (let k = 0; k < 3; k++) c0[k] = 0
      for (let i = 0; i < shellMol.atomCount; i++) for (let k = 0; k < 3; k++) c0[k]! += shellMol.pos[i * 3 + k]! / shellMol.atomCount
      rim = 0
      for (let i = 0; i < shellMol.atomCount; i += 7) rim = Math.max(rim, Math.hypot(shellMol.pos[i * 3]! - c0[0], shellMol.pos[i * 3 + 1]! - c0[1], shellMol.pos[i * 3 + 2]! - c0[2]))
    }
    // 整整一层球壳，不是切面后面的一圈：线数按体积补 / a whole spherical shell, not a ring behind the cut: the strand count is topped up by volume
    const t = env.fringe.thickness
    strandPanel({ ...env.fringe, count: Math.min(7000, Math.round(env.fringe.count * 20)) }, { centre: c0, hx: rim + t, hy: rim + t, z0: -(rim + t), z1: rim + t, exclude: rim - 16, within: rim + t + 14 }, 'fringe')
    // 乱线后面垫一层深一号的同色（一个球壳，切开后是后面的半个碗）：线之间露出的是它，不是白纸
    // a deeper shade of the same hue lies behind the strands (a spherical shell, of which the cut leaves the bowl at the back): it shows between them where paper would
    panels.push(groundShell('fringe-ground', c0, rim + t * 0.8, [Math.max(0.2, env.fringe.lch[0] - 0.2), env.fringe.lch[1], env.fringe.lch[2]], source('ground', undefined), 0.04))
  }
  notes.push({ key: env.replace ? 'note.rethreaded' : env.inside ? 'note.filledInside' : 'note.environment', params: { basis: env.basis, basisEn: env.basisEn } })
  // 填在对象里面的（inside、replace）是对象的一部分，拖动时照画；周围的是陪衬 / what fills the subject's inside (inside, replace) is part of it and drawn while dragging; what surrounds it is decoration
  return env.inside || env.replace ? panels.map((p) => (p.mol.id.startsWith('fringe') ? { ...p, decor: true } : p)) : panels.map((p) => ({ ...p, decor: true }))
}

/**
 * 实例化的模型里，把膜上某种蛋白的数量换成文献里的数，并排成等间隔的环（见 src/infer/idealise.ts）。
 * 原模型里这种蛋白的拷贝去掉（它们各自带的那一小块膜留着），返回新的一个面板。
 * In an instanced model, replace the number of one membrane protein by a number from the
 * literature and set the copies in evenly spaced rings (see src/infer/idealise.ts). The model's own
 * copies of that protein are removed (the patch of membrane each carries stays), and a new panel
 * is returned.
 */
function respike(entry: CatalogEntry, model: Molecule, assembly: string, notes: Note[]): Panel[] {
  const re = new RegExp(entry.respike!.pattern, 'i')
  const asm = model.assemblies.find((a) => a.id === assembly)
  if (!asm) return []
  const is = (ci: number) => re.test(model.entities[model.chains[ci]!.entity]!.description) && model.entities[model.chains[ci]!.entity]!.kind !== 'lipid'
  const group = asm.groups.find((g) => g.chains.some(is))
  if (!group || group.operators.length === 0) return []
  const chains = group.chains.filter(is)
  const at = (m: Float32Array, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]
  // 膜的中心：所有膜块位置的平均 / the membrane's centre: the mean position of all its patches
  const centre: V3 = [0, 0, 0]
  let n = 0
  for (const g of asm.groups) {
    const c0 = chainCentre(model, g.chains[0]!)
    for (const op of g.operators) {
      const p = at(op, c0)
      centre[0] += p[0]
      centre[1] += p[1]
      centre[2] += p[2]
      n++
    }
  }
  centre[0] /= n
  centre[1] /= n
  centre[2] /= n
  // 样板：原模型里的第一份，搬到它在模型里的位置上 / the template: the model's first copy, carried to where it stands in the model
  const sub = subMolecule(model, chains, `${model.id}:spike`, entry.titleEn)
  const op = group.operators[0]!
  for (let i = 0; i < sub.atomCount; i++) {
    const p = at(op, [sub.pos[i * 3]!, sub.pos[i * 3 + 1]!, sub.pos[i * 3 + 2]!])
    sub.pos.set(p, i * 3)
  }
  let template = templateOf(sub, sub.chains.map((_, i) => i), centre)
  if (EXAGGERATE()) {
    template = exaggerate(sub, template, entry.respike!.shape ?? { stretch: 1, stalk: 0.8, head: 1.15, split: 0.45, lobes: 16 })
    notes.push({ key: 'note.exaggerated' })
  }
  const had = group.operators.length
  const count = entry.respike!.count
  sub.assemblies.push({ id: 'inferred', groups: [{ chains: sub.chains.map((_, i) => i), operators: placeTemplate(template, centre, ringSites(count, [0, 0, 1])) }] })
  group.chains = group.chains.filter((ci) => !is(ci))
  if (group.chains.length === 0) asm.groups.splice(asm.groups.indexOf(group), 1)
  const lch = (e: Molecule['entities'][number]): [number, number, number] | null => entry.colors?.find(([pattern]) => new RegExp(pattern, 'i').test(e.description))?.[1] ?? null
  const roles: Role[] = sub.entities.map(() => 'focus')
  const coloring: Coloring = { roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: sub.entities.map((e) => lch(e)) }
  notes.push({ key: 'note.respiked', params: { had, count, source: entry.respike!.source } })
  const spec: PanelSpec = {
    label: `${entry.title}：刺（推断的数量和排布）`, labelEn: `${entry.titleEn}: spikes (inferred number and arrangement)`,
    source: { id: `${entry.id}:spike`, kind: 'model', title: entry.titleEn, method: tIn('zh', 'method.inferredCount'), methodEn: tIn('en', 'method.inferredCount'), resolution: null, year: null, tier: 'estimated', licence: entry.licence, attribution: entry.attribution, citation: entry.respike!.source, link: entry.link },
    assembly: 'inferred',
    entities: sub.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: e.description, description: e.description, organism: '' })),
    reason: '',
  }
  // 刺衬在后面：切片的背面不切它，前排的刺之间露出的是后面那一圈刺（深一号的色调），不是底色
  // the spikes line the back: the back of the slab does not cut them, so between the spikes in front the ring behind shows (in a deeper tone) and not the ground
  // 刺后面垫一只深一号的碗（见 groundShell）：刺之间露出的是刺的深色，不是环境的底色
  // a bowl of a deeper shade lies behind the spikes (see groundShell): between spikes their own deep tone shows, not the environment's ground
  const own = coloring.override.find((c) => c) ?? [0.6, 0.15, 330]
  const ground = groundShell(`${entry.id}:spike-ground`, centre, template.distance + 55, [own[0] - 0.28, own[1] * 0.8, own[2]], spec.source)
  return [ground, { spec, mol: sub, coloring, align: null, keepBack: true }]
}

/**
 * 垫在后面的底色：一个球壳上的一层小球，颜色深一号。切面把朝观察者的半个切掉，剩下的半个像一只碗衬在后面，
 * 东西之间的空隙里露出的是它，不是白纸。它是立体的，所以转到哪个角度都成立。
 * A ground laid behind: one layer of small spheres on a spherical shell, in a deeper colour. The cut
 * removes the half towards the viewer and the rest lines the back like a bowl, so that gaps between
 * things show it and not paper. It is a solid, and holds from any angle.
 */
function groundShell(id: string, centre: V3, radius: number, lch: [number, number, number], source: PanelSpec['source'], back = 0.3): Panel {
  const size = Math.max(9, radius / 40)
  const ops = fibonacciSphere(Math.round((4 * Math.PI * radius * radius) / (size * size))).map((d) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, centre[0] + d[0] * radius, centre[1] + d[1] * radius, centre[2] + d[2] * radius, 1]))
  const m: Molecule = {
    id, title: 'ground', atomCount: 1, pos: new Float32Array(3), element: new Uint8Array([El.C]), radius: new Float32Array([size * 1.1]),
    chainOf: new Uint32Array(1), isTrace: new Uint8Array(1), residue: new Int32Array([1]),
    chains: [{ asymId: 'G', authAsymId: 'G', entity: 0, start: 0, count: 1, model: 1 }], entities: [{ id: 'ground', description: 'ground', kind: 'protein' }],
    assemblies: [{ id: 'inferred', groups: [{ chains: [0], operators: ops }] }],
  }
  return {
    spec: { label: '底色', labelEn: 'ground', source: { ...source, id }, assembly: 'inferred', entities: [{ entityId: 'ground', role: 'soluble', name: '底色', nameEn: 'ground', description: 'ground', organism: '' }], reason: '' },
    mol: m, coloring: { roles: ['soluble'], hueShift: [0], nudge: [0], override: [lch] }, align: null, keepBack: true, oneId: true, ground: radius * back,
  }
}

/**
 * 概念“膜上的一圈突起”：把膜上的各种蛋白重新排成等间隔的一圈圈，膜换成一条光滑均匀的球壳。
 * 每种蛋白的结构、数量、嵌在膜里的深浅和歪斜都取自模型（取它的第一份拷贝），只有“在球面上的哪里”是重排的。
 * 原模型里这些蛋白和膜的拷贝去掉，返回两个面板（膜、蛋白）。只对近似球形的对象有意义。
 *
 * The concept "a ring of protrusions on a membrane": the proteins of a membrane are set out afresh
 * in evenly spaced rings and the membrane becomes a smooth, even spherical shell. Each protein's
 * structure, number, depth in the membrane and tilt are the model's (taken from its first copy);
 * only where on the sphere it stands is rearranged. The model's own copies of these proteins and
 * of the membrane are removed, and two panels are returned (membrane, proteins). It makes sense
 * only for a subject that is roughly a sphere.
 */
function arrange(entry: CatalogEntry, model: Molecule, assembly: string, notes: Note[]): Panel[] {
  const spec = entry.arrange!
  const asm = model.assemblies.find((a) => a.id === assembly)
  if (!asm) return []
  const re = new RegExp(spec.pattern, 'i'), not = spec.exclude ? new RegExp(spec.exclude, 'i') : null
  const lipid = (ci: number) => model.entities[model.chains[ci]!.entity]!.kind === 'lipid'
  const at = (m: Float32Array, p: V3): V3 => [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!]
  // 膜的中心和中面半径：脂质各份拷贝的位置 / the membrane's centre and mid-plane radius, from where the copies of its lipids stand
  const lipidAt: V3[] = []
  for (const g of asm.groups) {
    if (!g.chains.every(lipid)) continue
    const c0 = chainCentre(model, g.chains[0]!)
    const step = Math.max(1, Math.floor(g.operators.length / 4000))
    if (g.operators.length >= 20) for (let i = 0; i < g.operators.length; i += step) lipidAt.push(at(g.operators[i]!, c0))
    // 一整张不分块的膜（只有一两份、球很多）：取它的球本身 / a membrane in one piece (a copy or two with very many spheres): its spheres themselves are taken
    else for (const ci of g.chains) {
      const ch = model.chains[ci]!
      const skip = Math.max(1, Math.floor(ch.count / 4000))
      for (const op of g.operators) for (let i = ch.start; i < ch.start + ch.count; i += skip) lipidAt.push(at(op, [model.pos[i * 3]!, model.pos[i * 3 + 1]!, model.pos[i * 3 + 2]!]))
    }
  }
  if (lipidAt.length < 20) return []
  const centre: V3 = [0, 0, 0]
  for (const p of lipidAt) for (let k = 0; k < 3; k++) centre[k]! += p[k]! / lipidAt.length
  const radii = lipidAt.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])).sort((a, b) => a - b)
  const mid = radii[radii.length >> 1]!
  // 要排的蛋白：名字匹配、离膜不远的各组 / the proteins to arrange: groups whose name matches and that stand near the membrane
  const kinds: { g: (typeof asm.groups)[number]; chains: number[]; count: number }[] = []
  for (const g of asm.groups) {
    const chains = g.chains.filter((ci) => !lipid(ci) && re.test(model.entities[model.chains[ci]!.entity]!.description) && !not?.test(model.entities[model.chains[ci]!.entity]!.description))
    if (chains.length === 0 || g.operators.length === 0) continue
    const c: V3 = [0, 0, 0]
    for (const ci of chains) {
      const p = at(g.operators[0]!, chainCentre(model, ci))
      for (let k = 0; k < 3; k++) c[k]! += p[k]! / chains.length
    }
    if (Math.abs(Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]) - mid) > (spec.reach ?? 160)) continue
    kinds.push({ g, chains, count: g.operators.length })
  }
  const total = kinds.reduce((n, k) => n + k.count, 0)
  if (total === 0) return []
  const sub = subMolecule(model, kinds.flatMap((k) => k.chains), `${model.id}:arranged`, entry.titleEn)
  const sites = ringSites(total, [0, 0, 1])
  // 各种蛋白在位置上穿插着分：每个位置给“欠得最多”的那一种 / the kinds are interleaved over the sites: each site goes to the kind that is furthest behind its share
  const given = kinds.map(() => 0), mine: V3[][] = kinds.map(() => [])
  sites.forEach((site, i) => {
    let best = 0, lag = -Infinity
    kinds.forEach((k, j) => {
      const l = (k.count * (i + 1)) / total - given[j]!
      if (given[j]! < k.count && l > lag) {
        lag = l
        best = j
      }
    })
    given[best]!++
    mine[best]!.push(site)
  })
  let chainAt = 0
  const groups: Molecule['assemblies'][number]['groups'] = []
  kinds.forEach((k, j) => {
    const own = k.chains.map((_, i) => chainAt + i)
    chainAt += k.chains.length
    // 样板：这一种的第一份，搬到它在模型里的位置；轴取那里的膜法线，于是它嵌在膜里的深浅和歪斜原样保留
    // the template: this kind's first copy, carried to where it stands in the model; its axis is the membrane normal there, so its depth in the membrane and its tilt are kept as they are
    const c: V3 = [0, 0, 0]
    let n = 0
    for (const ci of own) {
      const ch = sub.chains[ci]!
      for (let i = ch.start; i < ch.start + ch.count; i++) {
        const q = at(k.g.operators[0]!, [sub.pos[i * 3]!, sub.pos[i * 3 + 1]!, sub.pos[i * 3 + 2]!])
        sub.pos.set(q, i * 3)
        for (let d = 0; d < 3; d++) c[d]! += q[d]!
        n++
      }
    }
    for (let d = 0; d < 3; d++) c[d]! /= Math.max(1, n)
    const distance = Math.hypot(c[0] - centre[0], c[1] - centre[1], c[2] - centre[2])
    const up: V3 = [(c[0] - centre[0]) / distance, (c[1] - centre[1]) / distance, (c[2] - centre[2]) / distance]
    // whiskers [拉长, 收细]：膜外的那一截沿法线拉长、横向收细，成一根根细长的须（他画的小泡是这样的）。这是夸张
    // whiskers [stretch, narrow]: the part outside the membrane is stretched along the normal and narrowed across it, into long thin whiskers (as on the vesicles he paints). This is an exaggeration
    if (spec.whiskers && EXAGGERATE()) for (const ci of own) {
      const ch = sub.chains[ci]!
      for (let i = ch.start; i < ch.start + ch.count; i++) {
        const q: V3 = [sub.pos[i * 3]! - centre[0], sub.pos[i * 3 + 1]! - centre[1], sub.pos[i * 3 + 2]! - centre[2]]
        const h = q[0] * up[0] + q[1] * up[1] + q[2] * up[2]
        const out = Math.max(0, h - (mid + 19))
        const k = out > 0 ? spec.whiskers[1] : 1
        for (let d = 0; d < 3; d++) sub.pos[i * 3 + d] = centre[d]! + up[d]! * (h + out * (spec.whiskers[0] - 1)) + (q[d]! - up[d]! * h) * k
      }
    }
    groups.push({ chains: own, operators: placeTemplate({ origin: c, up, distance, tilt: 0 }, centre, mine[j]!) })
    k.g.chains = k.g.chains.filter((ci) => !k.chains.includes(ci))
  })
  sub.assemblies.push({ id: 'inferred', groups })
  asm.groups = asm.groups.filter((g) => g.chains.length > 0 && !g.chains.every(lipid))
  const roleOf = (e: Molecule['entities'][number]): Role => {
    for (const [pattern, role] of entry.roles ?? []) if (new RegExp(pattern!, 'i').test(e.description)) return role as Role
    return 'soluble'
  }
  const roles = sub.entities.map(roleOf)
  const coloring: Coloring = spreadHues({ ...defaultColoring(sub), roles })
  sub.entities.forEach((e, i) => {
    const base = entry.hues?.[roles[i]!]
    if (base) coloring.override[i] = [base[0] + (i % 3 === 0 ? 0.03 : i % 3 === 1 ? 0 : -0.04), base[1], (base[2] + (coloring.hueShift[i] ?? 0) * 0.3 + 360) % 360]
    for (const [pattern, lch] of entry.colors ?? []) if (new RegExp(pattern, 'i').test(e.description)) coloring.override[i] = lch
  })
  notes.push({ key: 'note.arranged', params: { count: total, kinds: kinds.length } })
  if (spec.whiskers && EXAGGERATE()) notes.push({ key: 'note.whiskers' })
  const source = (id: string): PanelSpec['source'] => ({ id, kind: 'model', title: entry.titleEn, method: tIn('zh', 'method.idealisedPlacement'), methodEn: tIn('en', 'method.idealisedPlacement'), resolution: null, year: null, tier: 'estimated', licence: entry.licence, attribution: entry.attribution, citation: entry.citation, link: entry.link })
  const shellMol = shellMembrane(centre, mid - 19, mid + 19, `${model.id}:membrane`)
  shellMol.assemblies.push({ id: 'inferred', groups: [{ chains: [0], operators: [IDENTITY] }] })
  // 衬里：膜里面贴一层深一号的颜色，一个小球一份拷贝，各自按深度切（只留切面后面的半个）
  // the lining: a layer of a deeper colour just inside the membrane, one small sphere per copy, each cut by its own depth (only the half behind the cut remains)
  const liningPanel: Panel[] = []
  if (spec.lining) {
    // 小球的大小跟着对象走：大的细胞用大的球，不然要几十万个 / the spheres scale with the subject: a large cell takes larger ones, or hundreds of thousands would be needed
    const size = Math.max(7, mid / 45)
    const r = mid - 23 - size, count = Math.round((4 * Math.PI * r * r) / (size * size))
    const m: Molecule = {
      id: `${model.id}:lining`, title: 'lining', atomCount: 1, pos: new Float32Array(3), element: new Uint8Array([El.C]), radius: new Float32Array([size]),
      chainOf: new Uint32Array(1), isTrace: new Uint8Array(1), residue: new Int32Array([1]),
      chains: [{ asymId: 'L', authAsymId: 'L', entity: 0, start: 0, count: 1, model: 1 }], entities: [{ id: 'lining', description: 'lining', kind: 'protein' }],
      assemblies: [{ id: 'inferred', groups: [{ chains: [0], operators: fibonacciSphere(count).map((d) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, centre[0] + d[0] * r, centre[1] + d[1] * r, centre[2] + d[2] * r, 1])) }] }],
    }
    liningPanel.push({
      spec: { label: `${entry.title}：里面的底色`, labelEn: `${entry.titleEn}: the ground inside`, source: source(`${entry.id}:lining`), assembly: 'inferred', entities: [{ entityId: 'lining', role: 'soluble', name: '里面的底色', nameEn: 'the ground inside', description: 'lining', organism: '' }], reason: '' },
      mol: m, coloring: { roles: ['soluble'], hueShift: [0], nudge: [0], override: [spec.lining] }, align: null, keepBack: true, oneId: true,
    })
  }
  const short = (d: string) => d.split('.').pop()!.replace(/_/g, ' ')
  return [
    ...liningPanel,
    {
      spec: { label: `${entry.title}：膜（理想化的球壳）`, labelEn: `${entry.titleEn}: membrane (idealised shell)`, source: source(`${entry.id}:membrane`), assembly: 'inferred', entities: [{ entityId: 'membrane', role: 'membrane', name: '膜', nameEn: 'membrane', description: 'membrane', organism: '' }], reason: '' },
      mol: shellMol, coloring: { roles: ['membrane'], hueShift: [0], nudge: [0], override: [entry.membrane ?? MEMBRANE_LCH] }, align: null,
    },
    {
      spec: { label: `${entry.title}：膜上的蛋白（理想化的排布）`, labelEn: `${entry.titleEn}: membrane proteins (idealised arrangement)`, source: source(`${entry.id}:arranged`), assembly: 'inferred', entities: sub.entities.map((e, i) => ({ entityId: e.id, role: roles[i]!, name: short(e.description), description: e.description, organism: '' })), reason: '' },
      mol: sub, coloring, align: null, keepBack: true,
    },
  ]
}

/**
 * 概念“里面：核酸串着蛋白”。模型里有一个个核蛋白团块而没有核酸时，补上把它们串起来的那条线（见 stringThrough）。
 * 团块的位置是模型的，线是推断的。
 * The concept "inside: nucleic acid strung with protein". Where a model holds clumps of nucleoprotein
 * and no nucleic acid, the strand that strings them together is supplied (see stringThrough). Where
 * the clumps are is the model's; the strand is inferred.
 */
function strung(entry: CatalogEntry, model: Molecule, assembly: string, notes: Note[]): Panel[] {
  const spec = entry.string!
  const asm = model.assemblies.find((a) => a.id === assembly)
  if (!asm) return []
  const re = new RegExp(spec.pattern, 'i')
  const beads: V3[] = []
  let reach = 0
  for (const g of asm.groups) {
    const chains = g.chains.filter((ci) => re.test(model.entities[model.chains[ci]!.entity]!.description))
    if (chains.length === 0) continue
    // 一份拷贝的质心和大小 / the centroid and size of one copy
    const c: V3 = [0, 0, 0]
    let n = 0
    for (const ci of chains) {
      const ch = model.chains[ci]!
      for (let i = ch.start; i < ch.start + ch.count; i += 4) {
        for (let k = 0; k < 3; k++) c[k]! += model.pos[i * 3 + k]!
        n++
      }
    }
    for (let k = 0; k < 3; k++) c[k]! /= Math.max(1, n)
    let r2 = 0, m = 0
    for (const ci of chains) {
      const ch = model.chains[ci]!
      for (let i = ch.start; i < ch.start + ch.count; i += 4) {
        r2 += (model.pos[i * 3]! - c[0]) ** 2 + (model.pos[i * 3 + 1]! - c[1]) ** 2 + (model.pos[i * 3 + 2]! - c[2]) ** 2
        m++
      }
    }
    reach = Math.max(reach, Math.sqrt(r2 / Math.max(1, m)) * 1.3)
    for (const op of g.operators) beads.push([op[0]! * c[0] + op[4]! * c[1] + op[8]! * c[2] + op[12]!, op[1]! * c[0] + op[5]! * c[1] + op[9]! * c[2] + op[13]!, op[2]! * c[0] + op[6]! * c[1] + op[10]! * c[2] + op[14]!])
  }
  if (beads.length < 2) return []
  const plane = beads.reduce((z, b) => z + b[2], 0) / beads.length
  // fill：不用模型里那几十个大团块的位置，把腔用一条来回折的线和沿线的小珠子铺满（他的画法）。珠子取模型里团块的一条链。
  // fill: the positions of the model's few dozen large clumps are set aside and the cavity is filled with one line folded back and forth and small beads along it (the way he paints it). A bead is one chain of the model's clump.
  const extra: Panel[] = []
  let t: { pos: Float32Array; segments: Uint32Array }
  if (spec.fill) {
    const mid: V3 = [0, 0, 0]
    for (const b of beads) for (let k = 0; k < 3; k++) mid[k]! += b[k]! / beads.length
    const cavity = Math.max(...beads.map((b) => Math.hypot(b[0] - mid[0], b[1] - mid[1], b[2] - mid[2]))) - reach * 0.1
    const rand = rng(11)
    // 一层层叠满整个腔（不是只在切面后面放两层）：每层是一条来回折的线，层与层转一个角度。切面露出哪一层就看见哪一层，转到哪个角度都成立
    // layers are stacked through the whole cavity (not two layers behind the cut): each is one line folded back and forth, turned from the one before. The cut shows whichever layer it meets, and it holds from any angle
    const layers: ReturnType<typeof serpentine>[] = []
    for (let k = 0, z = -spec.fill * 0.45; z > -cavity; k++, z -= spec.fill) layers.push(serpentine(mid, Math.sqrt(cavity * cavity - z * z) * 0.97, spec.fill, z, rand, 0.3 + k * 1.1))
    for (let k = 0, z = spec.fill * 0.55; z < cavity; k++, z += spec.fill) layers.push(serpentine(mid, Math.sqrt(cavity * cavity - z * z) * 0.97, spec.fill, z, rand, 0.9 + k * 1.1))
    const pos = new Float32Array(layers.reduce((n, l) => n + l.pos.length, 0)), segs = new Uint32Array(layers.reduce((n, l) => n + l.segments.length, 0))
    let pa = 0, sa = 0
    for (const l of layers) {
      pos.set(l.pos, pa)
      l.segments.forEach((v, k) => (segs[sa + k] = v + pa / 3))
      pa += l.pos.length
      sa += l.segments.length
    }
    t = { pos, segments: segs }
    const g0 = asm.groups.find((g) => g.chains.some((ci) => re.test(model.entities[model.chains[ci]!.entity]!.description)))!
    const chain = g0.chains.filter((ci) => re.test(model.entities[model.chains[ci]!.entity]!.description)).sort((a, b) => model.chains[b]!.count - model.chains[a]!.count)[0]!
    const sub = subMolecule(model, [chain], `${model.id}:beads`, spec.nameEn)
    const c = chainCentre(sub, 0)
    if (EXAGGERATE()) lobed(sub, undefined, 0.8)
    const place = (b: V3) => {
      const R = randomRotation(rand)
      return new Float32Array([R[0]!, R[1]!, R[2]!, 0, R[3]!, R[4]!, R[5]!, 0, R[6]!, R[7]!, R[8]!, 0, b[0] - (R[0]! * c[0] + R[3]! * c[1] + R[6]! * c[2]), b[1] - (R[1]! * c[0] + R[4]! * c[1] + R[7]! * c[2]), b[2] - (R[2]! * c[0] + R[5]! * c[1] + R[8]! * c[2]), 1])
    }
    const ops = layers.flatMap((l) => l.beads).map(place)
    sub.assemblies.push({ id: 'inferred', groups: [{ chains: [0], operators: ops }] })
    const lch = entry.colors?.find(([pattern]) => new RegExp(pattern, 'i').test(sub.entities[0]!.description))?.[1] ?? entry.hues?.['nucleic-binding'] ?? [0.72, 0.12, 290]
    extra.push({
      spec: { label: `${spec.beadName ?? spec.name}（推断的排布）`, labelEn: `${spec.beadNameEn ?? spec.nameEn} (inferred arrangement)`, source: { id: `${entry.id}:beads`, kind: 'model', title: spec.nameEn, method: tIn('zh', 'method.inferredCount'), methodEn: tIn('en', 'method.inferredCount'), resolution: null, year: null, tier: 'estimated', licence: entry.licence, attribution: entry.attribution, citation: spec.basisEn, link: entry.link }, assembly: 'inferred', entities: [{ entityId: sub.entities[0]!.id, role: 'nucleic-binding', name: spec.beadName ?? spec.name, nameEn: spec.beadNameEn ?? spec.nameEn, description: sub.entities[0]!.description, organism: '' }], reason: '' },
      mol: sub, coloring: { roles: ['nucleic-binding'], hueShift: [0], nudge: [0], override: [lch as [number, number, number]] }, align: null, keepBack: true,
    })
    // 腔的内壁垫一层更深的同色（见 groundShell）：珠子之间的空隙里露出的是它，珠子才一个个分得开
    // a still deeper shade of the same hue lines the cavity's wall (see groundShell): it shows in the gaps between beads, which is what sets them apart one from another
    {
      const l = lch as number[]
      extra.push(groundShell(`${entry.id}:cavity`, mid, cavity + 8, [l[0]! - 0.2, l[1]! * 0.9, l[2]!], extra[0]!.spec.source, 0.04))
    }
    for (const g of asm.groups) g.chains = g.chains.filter((ci) => !re.test(model.entities[model.chains[ci]!.entity]!.description))
    asm.groups = asm.groups.filter((g) => g.chains.length > 0)
    if (EXAGGERATE()) notes.push({ key: 'note.lobed' })
    notes.push({ key: 'note.strungFill', params: { had: beads.length, count: ops.length, basis: spec.basis, basisEn: spec.basisEn } })
  } else {
    t = stringThrough(beads, reach, plane)
    notes.push({ key: 'note.strung', params: { count: beads.length, basis: spec.basis, basisEn: spec.basisEn } })
  }
  const n = t.pos.length / 3
  if (n === 0) return []
  const m: Molecule = {
    id: `${model.id}:string`, title: spec.nameEn, atomCount: n, pos: t.pos, element: new Uint8Array(n).fill(El.N), radius: new Float32Array(n).fill(spec.radius),
    chainOf: new Uint32Array(n), isTrace: new Uint8Array(n).fill(1), residue: new Int32Array(n).fill(1), segments: t.segments,
    chains: [{ asymId: 'R', authAsymId: 'R', entity: 0, start: 0, count: n, model: 1 }], entities: [{ id: 'string', description: spec.nameEn, kind: 'rna' }],
    assemblies: [{ id: 'inferred', groups: [{ chains: [0], operators: [IDENTITY] }] }],
  }
  return [...extra, {
    spec: { label: `${spec.name}（推断的走向）`, labelEn: `${spec.nameEn} (inferred course)`, source: { id: `${entry.id}:string`, kind: 'model', title: spec.nameEn, method: tIn('zh', 'method.inferredCourse'), methodEn: tIn('en', 'method.inferredCourse'), resolution: null, year: null, tier: 'estimated', licence: 'CC0 1.0', attribution: '', citation: spec.basisEn, link: undefined }, assembly: 'inferred', entities: [{ entityId: 'string', role: 'nucleic', name: spec.name, nameEn: spec.nameEn, description: spec.nameEn, organism: '' }], reason: '' },
    mol: m, coloring: { roles: ['nucleic'], hueShift: [0], nudge: [0], override: [spec.lch] }, align: null,
  }]
}

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
  // 理想化时膜的内表面在中面往里 19 Å；否则取数据里最靠里的脂质 / when idealised the membrane's inner face is 19 Å inside its mid-plane; otherwise where the data's innermost lipids are
  const inner = idealise ? membrane.mid - 19 : membrane.inner
  const matrix = layerOnSphere(layer, membrane.centre, inner - 25)
  // 一段 RNP 螺旋里有多少个核苷酸：数它的 RNA 链上的磷原子 / nucleotides in one stretch of RNP helix: count the phosphorus atoms on its RNA chains
  let nt = 0
  for (const c of rnp.chains) if (rnp.entities[c.entity]!.kind === 'rna') for (let i = c.start; i < c.start + c.count; i++) if (rnp.isTrace[i]) nt++
  const cavity = inner - 55
  // 手绘画法：照 Goodsell 的做法，每条杆一直画到内壁、在内壁处截断，里面是满的；Illustrate 画法：每条只放完整的螺旋段
  // painted drawing: as Goodsell does, every rod runs up to the inner wall and is cut there, so the inside is full; Illustrate drawing: whole helical stretches only
  const bundle = rnpBundle(rnp, pol, membrane.centre, cavity, [0, 1, 0], nt || 616, undefined, idealise)
  const filled = idealise ? clipToCavity(rnp, bundle.stretches, membrane.centre, cavity, [0, 1, 0], bundle.tops, spec.rnp) : null
  const make = (mol: Molecule, id: string, title: string, titleEn: string, operators: Float32Array[], colors: (e: Molecule['entities'][number]) => [number, number, number], names: (e: Molecule['entities'][number]) => [string, string]): Panel => {
    // 糖链单独成组：它们共用一个编号、彼此不描边；和蛋白放在一组的话，整个刺都会被当成“不单独描边”的东西
    // glycans form a group of their own: they share one id and are not outlined one by one; grouped with the protein, the whole spike would be taken for something not outlined separately
    const sugar = mol.chains.map((_, i) => i).filter((i) => /glycan/i.test(mol.entities[mol.chains[i]!.entity]!.description))
    const rest = mol.chains.map((_, i) => i).filter((i) => !sugar.includes(i))
    mol.assemblies.push({ id: 'inferred', groups: [...(rest.length ? [{ chains: rest, operators }] : []), ...(sugar.length ? [{ chains: sugar, operators }] : [])] })
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
  const wanted = bundle.rods.reduce((s, r) => s + r.wanted, 0)
  // 画出来的相当于几段完整的螺旋 / how many whole helical stretches what is drawn amounts to
  const placed = filled ? Math.round(filled.kept * bundle.stretches.length * 10) / 10 : bundle.rods.reduce((s, r) => s + r.placed, 0)
  notes.push({ key: filled ? 'note.inferred.influenzaFilled' : 'note.inferred.influenza', params: { matrix: spec.matrix, rnp: spec.rnp, polymerase: spec.polymerase, m1: matrix.length.toLocaleString('en-US'), nt: nt || 616, wanted, placed } })
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
    // 神经氨酸酶：先在切面那一圈上等间隔地放八个（他的画里切面上看得到八九个），其余的均匀插在别处
    // neuraminidase: eight go evenly round the ring in the cut plane first (his painting shows eight or nine there), and the rest are spread evenly elsewhere
    const equator = sites.map((p, i) => ({ i, a: Math.atan2(p[1], p[0]) })).filter((x) => Math.abs(sites[x.i]![2] + 0.02) < 0.02).sort((x, y) => x.a - y.a)
    const onRing = Math.min(8, na.length, equator.length)
    const naAt = new Set<number>(Array.from({ length: onRing }, (_, k) => equator[Math.floor(((k + 0.5) * equator.length) / onRing)]!.i))
    const elsewhere = sites.map((_, i) => i).filter((i) => !equator.some((x) => x.i === i))
    for (let k = 0; k < na.length - onRing && elsewhere.length > 0; k++) naAt.add(elsewhere[Math.min(elsewhere.length - 1, Math.floor(((k + 0.5) * elsewhere.length) / (na.length - onRing)))]!)
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
      // 糖链和它所在的蛋白同色：他把糖链画成蛋白轮廓的一部分，不另外上色 / glycans take the colour of the protein they sit on: he paints them as part of the protein's outline, not in a colour of their own
      // 夸张：柄拉长收细、头放宽（只有刺，M2 不动）/ exaggeration: stalk stretched and narrowed, head widened (spikes only, not M2)
      const tpl = EXAGGERATE() && id !== 'M2' ? exaggerate(sub, templateOf(sub, sub.chains.map((_, i) => i).filter((i) => !/glycan/i.test(sub.entities[sub.chains[i]!.entity]!.description)), membrane.centre), id === 'neuraminidase' ? { stretch: 1.25, stalk: 0.5, head: 1.15, split: 0.5 } : { stretch: 1.4, stalk: 0.75, head: 1.05, split: 0.55, lobes: 10, ripple: [15, 24] }) : chosen.t
      const own = lch(sub.entities.find((e) => !/glycan/i.test(e.description)) ?? sub.entities[0]!)
      const panel = make(sub, `${model.id}:${id}`, title, titleEn, placeTemplate(tpl, membrane.centre, where), () => own, (e) => [e.description, e.description])
      panel.spec.source = { ...panel.spec.source, kind: 'model', method: tIn('zh', 'method.idealisedPlacement'), methodEn: tIn('en', 'method.idealisedPlacement'), licence: tIn('zh', 'licence.none'), licenceEn: tIn('en', 'licence.none'), attribution: '', citation: '', link: undefined }
      // 刺衬在后面：前排刺之间的缝里露出的是后排的刺（深一号），不是白纸 / spikes line the back: the slits between the front row show the rows behind (a deeper tone), not paper
      outside.push(id === 'M2' ? panel : { ...panel, keepBack: true })
    }
    // 膜也理想化：一条边缘光滑、宽度均匀的球壳，厚度取自模拟里的膜。原模型里的东西在这种画法下都不画了。
    // the membrane is idealised too: a spherical shell of smooth edges and even width, as thick as the simulated one. Nothing of the original model is drawn in this drawing any more.
    for (const a of model.assemblies) a.groups = []
    outside.unshift(make(shellMembrane(membrane.centre, membrane.mid - 19, membrane.mid + 19, `${model.id}:membrane`), `${model.id}:membrane`, '膜（理想化的球壳）', 'Membrane (idealised shell)', [IDENTITY], () => MEMBRANE_LCH, () => ['膜', 'membrane']))
    outside[0]!.spec.source = { ...outside[0]!.spec.source, kind: 'model', method: tIn('zh', 'method.idealisedPlacement'), methodEn: tIn('en', 'method.idealisedPlacement'), licence: tIn('zh', 'licence.none'), licenceEn: tIn('en', 'licence.none'), attribution: '', citation: '', link: undefined }
    // 刺的后面垫一只深靛色的碗（见 groundShell）：柄之间的缝里露出的是它，不是白纸（他的画里那里是深靛色的后排刺）
    // a bowl of deep indigo lies behind the spikes (see groundShell): the slits between stalks show it and not paper (in his painting the darker rows behind show there)
    outside.unshift(groundShell(`${model.id}:ground`, membrane.centre, membrane.mid + 19 + 168, [0.42, 0.09, 285], outside[0]!.spec.source, 0.16))
    tilts.sort((a, b) => a - b)
    if (EXAGGERATE()) notes.push({ key: 'note.exaggerated' })
    notes.push({ key: 'note.idealised', params: { ha: ha.length, na: na.length, m2: m2.length, tilt: Math.round(tilts[Math.floor(tilts.length / 2)] ?? 0) } })
  }
  // 基因组 RNA 画成一条线：走向取自 RNP 结构里的 RNA 链 / the genomic RNA as a line, its course taken from the RNA chains of the RNP structure
  let path = rnaPath(rnp, bundle.stretches, 9)
  if (filled) {
    // 线也在内壁处截断：留在空腔里的点才要，两端都在的线段才连 / the line is cut at the inner wall too: only points inside the cavity are kept, and only segments with both ends kept are joined
    const per = path.pos.length / 3 / bundle.stretches.length
    const keep = new Int32Array(path.pos.length / 3).fill(-1)
    const kp: number[] = [], ks: number[] = []
    for (let i = 0; i < keep.length; i++) {
      const d = [path.pos[i * 3]! - membrane.centre[0], path.pos[i * 3 + 1]! - membrane.centre[1], path.pos[i * 3 + 2]! - membrane.centre[2]]
      if (Math.hypot(d[0]!, d[1]!, d[2]!) > cavity - 4 || d[1]! > (bundle.tops?.[Math.floor(i / per)] ?? Infinity)) continue
      keep[i] = kp.length / 3
      kp.push(path.pos[i * 3]!, path.pos[i * 3 + 1]!, path.pos[i * 3 + 2]!)
    }
    for (let k = 0; k < path.segments.length; k += 2) if (keep[path.segments[k]!]! >= 0 && keep[path.segments[k + 1]!]! >= 0) ks.push(keep[path.segments[k]!]!, keep[path.segments[k + 1]!]!)
    path = { pos: new Float32Array(kp), segments: new Uint32Array(ks) }
  }
  const np = path.pos.length / 3
  const strand: Molecule = {
    id: `${spec.rnp}:RNA`, title: 'genomic RNA', atomCount: np, pos: path.pos, element: new Uint8Array(np).fill(El.N), radius: new Float32Array(np).fill(5.5),
    chainOf: new Uint32Array(np), isTrace: new Uint8Array(np).fill(1), residue: new Int32Array(np).fill(1), segments: path.segments,
    chains: [{ asymId: 'RNA', authAsymId: 'RNA', entity: 0, start: 0, count: np, model: 1 }], entities: [{ id: 'rna', description: 'genomic RNA', kind: 'rna' }], assemblies: [],
  }
  const rnpPanel = make(filled?.mol ?? rnp, spec.rnp, '核糖核蛋白（推断的位置）', 'Ribonucleoprotein (inferred placement)', filled ? [IDENTITY] : bundle.stretches, (e) => (isRna(e) ? [0.88, 0.16, 92] : [0.79, 0.15, 68]), (e) => (isRna(e) ? ['基因组 RNA', 'genomic RNA'] : ['核蛋白 NP', 'nucleoprotein NP']))
  // 填满时每个核蛋白单独描边：他画里的核糖核蛋白是一串看得出一个个核蛋白的珠子
  // when filled, every nucleoprotein is outlined on its own: in his painting a ribonucleoprotein is a string of beads in which each nucleoprotein can be told
  // 原子画胖一些（2.9 Å）：螺旋里的小孔合上，每个核蛋白读成一个完整的瓣，而不是带着透出后面颜色的小洞
  // atoms are drawn fatter (2.9 Å): the small holes in the helix close, and each nucleoprotein reads as one whole lobe instead of showing specks of what lies behind
  if (filled) filled.mol.radius = new Float32Array(filled.mol.atomCount).fill(2.9)
  // 夸张：每个核蛋白收成两瓣的圆润小块，一串串读得出是珠子（见 lobed）/ exaggeration: each nucleoprotein collapses to a rounded two-lobed piece, so that the strings read as beads (see `lobed`)
  if (filled && EXAGGERATE()) {
    lobed(filled.mol, (ci) => isRna(filled.mol.entities[filled.mol.chains[ci]!.entity]!))
    notes.push({ key: 'note.lobed' })
  }
  if (filled) filled.mol.assemblies[filled.mol.assemblies.length - 1]!.groups = filled.mol.chains.map((_, i) => ({ chains: [i], operators: [IDENTITY] }))
  // 基质蛋白层衬在里面：核糖核蛋白之间的空隙里露出的是它的深色，不是白纸
  // the matrix layer lines the inside: gaps between ribonucleoproteins show its deep tone, not paper
  const lining = (p: Panel): Panel => ({ ...p, keepBack: true })
  // 一整层：各份拷贝之间不画线，读成一条带子 / one layer: no lines between its copies, so that it reads as a band
  const band = (p: Panel): Panel => ({ ...p, keepBack: true, oneId: true })
  return [
    ...outside,
    // 基质蛋白层也衬在后面，杆之间和杆外面的空处露出的是它 / the matrix layer lines the back as well, showing between and beyond the rods
    band(make(m1, spec.matrix, '基质蛋白 M1（推断的位置）', 'Matrix protein M1 (inferred placement)', matrix, () => [0.79, 0.083, 245], () => ['基质蛋白 M1', 'matrix protein M1'])),
    // 核糖核蛋白衬在里面：切片后面的那几条仍然画出来（用深一号的橙色），空隙里露出的是它们，不是白纸，也不是基质蛋白的内壁
    // the ribonucleoproteins line the inside: those behind the slab are still drawn (in a deeper orange), so gaps show them and neither paper nor the inner wall of matrix protein
    filled ? lining(rnpPanel) : rnpPanel,
    ...(np > 1 ? [make(strand, spec.rnp, '基因组 RNA 的走向', 'The course of the genomic RNA', [IDENTITY], () => [0.88, 0.16, 92], () => ['基因组 RNA', 'genomic RNA'])] : []),
    make(pol, spec.polymerase, '聚合酶（推断的位置）', 'Polymerase (inferred placement)', bundle.polymerases, (e) => (isRna(e) ? [0.88, 0.16, 92] : [0.72, 0.12, 22]), (e) => (isRna(e) ? ['RNA', 'RNA'] : ['聚合酶', 'polymerase'])),
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
  exaggerate: typeof location === 'undefined' || new URLSearchParams(location.search).get('exaggerate') !== '0',
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
    // 加载中拖动过：加载完不把视角重置回正面 / dragged while loading: the view is not reset to the front once loaded
    const rotAtStart = get().rot
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
      const mesoscale0 = !!entry.perCopy
      const full = placedAtomCount(mol, assembly)
      if (full > ATOM_BUDGET && src.kind !== 'prepared') {
        mol = coarsen(mol)
        notes.push({ key: 'note.coarse', params: { millions: (full / 1e6).toFixed(0) } })
      }
      // 概念“核酸”：纤维的每一节画成同样大小的球，连起来是一条粗细均匀的线（DNA 双螺旋半径约 10 Å，单链 RNA 画细一些）
      // the concept "nucleic acid": every piece of a fibre is drawn as a sphere of one size, which join into a strand of even width (a DNA double helix is about 10 Å in radius; single-stranded RNA is drawn thinner)
      if (mesoscale0 && mol.radius && get().drawing === 'painted')
        for (const c of mol.chains) {
          const d = mol.entities[c.entity]!.description
          if (/\.fibers?\./i.test(d)) mol.radius.fill(/RNA/i.test(d) ? 7 : 11, c.start, c.start + c.count)
        }
      const roles: Role[] = mol.entities.map((e) => {
        if (e.kind === 'lipid') return 'membrane'
        for (const [pattern, role] of entry.roles ?? []) if (new RegExp(pattern!, 'i').test(e.description)) return role as Role
        return entry.roles ? 'soluble' : (undefined as unknown as Role)
      })
      const base = defaultColoring(mol)
      const coloring = spreadHues({ ...base, roles: roles.map((r, i) => r ?? base.roles[i]!) })
      // 整张膜一个颜色，不按来源的拼块分色 / the whole membrane is one colour, not a patchwork of where its lipids came from
      if (entry.perCopy) mol.entities.forEach((e, i) => e.kind === 'lipid' && (coloring.override[i] = entry.membrane ?? MEMBRANE_LCH))
      // 按区室配色：这个模型里每种角色用哪一族颜色（量自 Goodsell 画同一个对象的那幅画）；同一角色的各个实体只在这一族里小幅变化
      // colour by compartment: which family of hue each role takes in this model (measured on Goodsell's painting of the same subject); entities of one role vary only a little within the family
      if (entry.hues) mol.entities.forEach((e, i) => {
        const base = entry.hues![coloring.roles[i]!]
        if (base && e.kind !== 'lipid') coloring.override[i] = [base[0] + (i % 3 === 0 ? 0.03 : i % 3 === 1 ? 0 : -0.04), base[1], (base[2] + (coloring.hueShift[i] ?? 0) * 0.3 + 360) % 360]
      })
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
      const respiked = entry.respike && get().drawing === 'painted' ? respike(entry, mol, assembly, notes) : []
      const inferred: Panel[] = respiked.length ? respiked : entry.infer ? await influenzaInterior(entry.infer, mol, notes, (name) => set({ busy: say('busy.downloading', { name }) }), get().drawing === 'painted', entry.colors ?? []) : []
      if (entry.arrange && get().drawing === 'painted') inferred.push(...arrange(entry, mol, assembly, notes))
      // 里面重画的东西不参与“对象有多大”的计算（否则环境的范围会跟着变），所以放到环境之后再加进来
      // what is redrawn inside takes no part in working out how large the subject is (or the environment's range would shift with it), so it joins after the environment
      const interior = entry.string && get().drawing === 'painted' ? strung(entry, mol, assembly, notes) : []
      const surroundings: Panel[] = entry.environment && get().drawing === 'painted' ? await environmentPanels(entry, [mol, ...inferred.map((p) => p.mol)], inferred.map((p) => p.spec.assembly), assembly, notes, (name) => set({ busy: say('busy.downloading', { name }) })) : []
      inferred.push(...surroundings)
      inferred.push(...interior)
      // twin：整个对象再画一份，绕竖直于画面的轴转半圈后挪到旁边，两个挨着，像正在分裂。第二个不是数据
      // twin: the whole subject is drawn a second time, turned half a circle about the axis normal to the picture and moved aside, so that the two touch as if dividing. The second is not data
      const shellOf = inferred.find((p) => p.mol.id.endsWith(':membrane'))?.mol
      const twins: Panel[] = []
      if (entry.twin && get().drawing === 'painted' && shellOf) {
        const c: V3 = [0, 0, 0]
        for (let i = 0; i < shellOf.atomCount; i++) for (let k = 0; k < 3; k++) c[k]! += shellOf.pos[i * 3 + k]! / shellOf.atomCount
        let rim = 0
        for (let i = 0; i < shellOf.atomCount; i += 7) rim = Math.max(rim, Math.hypot(shellOf.pos[i * 3]! - c[0], shellOf.pos[i * 3 + 1]! - c[1], shellOf.pos[i * 3 + 2]! - c[2]))
        // 两个连通：每个细胞越过两者中间那个平面的部分都去掉（膜、膜上的蛋白、里面的东西），相接处是一个开口，不是两层膜。
        // 第二个是第一个转了半圈，所以“第一个越过平面的部分”转过去正好是“第二个越过平面的部分”，只需要去一次。
        // The two are joined: whatever of each cell lies past the plane midway between them is removed (membrane, its proteins, what is inside), so they meet at an opening and not at two membranes.
        // The second is the first turned half a circle, so "what of the first lies past the plane" turns into "what of the second lies past it", and removing once does for both.
        const plane = c[0] + (rim * entry.twin) / 2
        for (const p of [{ mol } as Panel, ...inferred]) {
          const pm = p.mol
          for (const a of pm.assemblies) for (const g of a.groups) {
            if (g.operators.length > 1) {
              const c0 = chainCentre(pm, g.chains[0]!)
              g.operators = g.operators.filter((op) => op[0]! * c0[0] + op[4]! * c0[1] + op[8]! * c0[2] + op[12]! <= plane)
            } else if (g.operators.length === 1) {
              const op = g.operators[0]!
              if (!pm.radius) pm.radius = new Float32Array(pm.atomCount).fill(1.7)
              for (const ci of g.chains) {
                const ch = pm.chains[ci]!
                for (let i = ch.start; i < ch.start + ch.count; i++) if (op[0]! * pm.pos[i * 3]! + op[4]! * pm.pos[i * 3 + 1]! + op[8]! * pm.pos[i * 3 + 2]! + op[12]! > plane) pm.radius[i] = -1
              }
            }
          }
        }
        const m = new Float32Array([-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 2 * c[0] + rim * entry.twin, 2 * c[1], 0, 1])
        for (const p of [{ spec, mol, coloring, align: null } as Panel, ...inferred]) twins.push({ ...p, align: m, spec: { ...p.spec, label: `${p.spec.label}（第二个，示意）`, labelEn: `${p.spec.labelEn ?? p.spec.label} (the second, schematic)`, source: { ...p.spec.source, id: `${p.spec.source.id}:twin` } } })
        inferred.push(...twins)
        notes.push({ key: 'note.twin' })
      }
      const dots = entry.dots && get().drawing === 'painted' && EXAGGERATE() ? entry.dots : 0
      if (dots) notes.push({ key: 'note.dots' })
      const scene: SceneSpec = { topic: entry.title, kind: mesoscale ? 'model' : 'virus', title: entry.title, titleEn: entry.titleEn, caption: entry.caption, captionEn: entry.captionEn, catalog: entry.id, ...(entry.lining ? { lining: entry.lining } : {}), ...(inferred.length ? { overlay: true } : {}), panels: [spec], notes, mesoscale, merge: entry.merge, ...(dots ? { dots } : {}) }
      set((s) => ({
        spec: scene,
        // 单个结构加了环境：结构本身不切，环境切掉朝观察者的一半，不然它被挡在环境后面
        // a single structure with surroundings: the structure itself is left whole and the half of the surroundings towards the viewer is cut away, or it would be hidden behind them
        panels: [{ spec, mol, coloring, align: null, ...(!mesoscale && surroundings.length ? { noCut: true } : {}) }, ...inferred],
        colorings: [coloring, ...inferred.map((p) => p.coloring)],
        ...freshLook(),
        ...(get().rot !== rotAtStart && get().spec?.catalog === id ? { rot: get().rot } : {}),
        // 很大的模型默认放大到中间一块：整个画出来时每个分子只有几个像素，什么也看不清
        // a very large model opens zoomed in on its middle: drawn whole, each molecule is a few pixels and nothing can be made out
        // 周围铺了环境的，画面跟着环境变大了，按同样的比例放大回来，对象在画面里的大小不变
        // where surroundings were laid, the frame grew with them; zooming by the same ratio keeps the subject the size it was
        zoom: (entry.zoom ?? 1) * (surroundings.length && !entry.environment?.inside && !entry.environment?.outside ? (SPREAD / 1.5) * 1.1 : 1),
        cut: entry.cut ?? (!mesoscale && surroundings.length ? 0.5 : 0),
        cutDefault: entry.cut ?? (!mesoscale && surroundings.length ? 0.5 : 0),
        style: (() => {
          const st = styleFor(mesoscale ? 'mesoscale' : 'molecule', get().drawing)
          // 很大的单个结构（整个衣壳）：每个原子不到一个像素，不平滑就是一片麻点 / a very large single structure (a whole capsid): an atom is under a pixel, and without smoothing it is all speckle
          if (!mesoscale && get().drawing === 'painted' && full > 200_000) {
            st.smooth = 7
            st.inkShade = 0.22
          }
          // 很密的模型（几万份拷贝以上）线收细，否则满纸都是黑线 / a very dense model (tens of thousands of copies or more) gets thinner lines, or the sheet is all black line
          const copies = mol.assemblies.find((a) => a.id === assembly)?.groups.reduce((n, g) => n + g.operators.length, 0) ?? 0
          // 场景：深色的底 / a scene: a dark ground
          if (surroundings.length && entry.environment?.ground) st.background = entry.environment.ground
          if (entry.ground && get().drawing === 'painted') st.background = entry.ground
          if (mesoscale && copies > 20_000) {
            st.lineWidth = Math.min(st.lineWidth, 0.7)
            // 密的模型里一个分子只有画幅的百分之几，切片要厚些才连得成片，否则到处露白
            // in a dense model a molecule is a few percent of the frame, and the slab has to be thicker for the picture to hold together, or paper shows everywhere
            if (st.slab) st.slab = 0.4
            // 线用填色的深一号，不用近黑：分子又小又密时黑线会盖住颜色，他画密的场景时线很柔和
            // lines take a deeper shade of the fill rather than near-black: with small, crowded molecules black line smothers the colour, and his line is soft in crowded scenes
            st.inkShade = 0.3
          }
          return st
        })(),
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
      // 手绘画法：暖白的纸，线是填色的深一号、很细。细胞器的碎片成千上万，用黑线会把画面盖成一片黑
      // painted drawing: warm paper, with very thin lines a deeper shade of the fill. Organelle fragments number in the thousands, and black line would smother the picture
      const thin = cloneStyle(STYLE_MOLECULE)
      thin.lineWidth = 0.6
      thin.shadow.floor = 0.8
      if (get().drawing === 'painted') {
        thin.background = [0.992, 0.988, 0.976]
        thin.inkTint = 1
        thin.inkShade = 0.42
        thin.lineWidth = 0.45
        thin.shadow.strength = 0
        thin.grain = 0.07
      }
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

  setExaggerate(on) {
    set({ exaggerate: on })
    const id = get().spec?.catalog
    if (id) void get().loadCatalog(id)
  },

  setDrawing(drawing) {
    const sp = get().spec
    // 带“理想化排布”的模型两种画法用的排布不同，要重新载入 / a model with an idealised arrangement uses a different arrangement in each drawing and has to be reloaded
    const entry = sp?.catalog ? (catalog.models as CatalogEntry[]).find((m) => m.id === sp.catalog) : undefined
    // 同样要重新载入的：带示意环境的、小分子画成圆点的、有自己底色的（否则切到 Illustrate 后推断的东西还留在画面里）
    // reloaded likewise: models with a schematic environment, with small molecules as dots, or with a ground of their own (or inferred things would stay in the picture after a switch to Illustrate)
    if (entry?.infer || entry?.respike || entry?.arrange || entry?.twin || entry?.string || entry?.environment || entry?.dots || entry?.ground) {
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
