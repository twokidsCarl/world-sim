import { create } from 'zustand'
import * as api from '../api'
import { loadMolecule } from '../mol/load'
import { superpose } from '../mol/superpose'
import type { Molecule } from '../mol/types'
import { axisAngle, identity3, mul3, type Mat3 } from '../render/camera'
import { cloneStyle, STYLE_MOLECULE, type Style } from '../render/style'
import type { Edit } from '../refine/edits'
import { defaultAssembly } from '../scene/build'
import type { PanelSpec, SceneSpec } from '../scene/spec'
import { defaultColoring, spreadHues, type Coloring } from '../style/assign'
import { parseHex } from '../style/oklab'
import type { Role } from '../style/palettes'

export interface Panel {
  spec: PanelSpec
  mol: Molecule
  coloring: Coloring
  /** turns this panel to match the first one, when they share a protein */
  align: Float32Array | null
}

/** Everything a reviewer or the user can change about how the scene looks. */
export interface Look {
  rot: Mat3
  /** 1 = subject framed with the standard margin */
  zoom: number
  /** subject moved right/up by this share of the frame */
  shift: [number, number]
  style: Style
  colorings: Coloring[]
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
  /** bumped whenever the atoms on the GPU must be rebuilt */
  sceneRev: number
  /** bumped to ask the stage to draw again */
  drawRev: number
  busy: string
  error: string
  rounds: Round[]
  refining: string
  resolveTopic(topic: string): Promise<void>
  loadId(id: string): Promise<void>
  setAssembly(panel: number, id: string): void
  setRole(panel: number, entity: number, role: Role): void
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

const freshLook = (): Pick<Look, 'rot' | 'zoom' | 'shift'> => ({ rot: identity3(), zoom: 1, shift: [0, 0] })

export const useStore = create<State>((set, get) => ({
  spec: null,
  panels: [],
  ...freshLook(),
  style: cloneStyle(STYLE_MOLECULE),
  colorings: [],
  sceneRev: 0,
  drawRev: 0,
  busy: '',
  error: '',
  rounds: [],
  refining: '',

  async resolveTopic(topic) {
    set({ busy: '正在理解主题并检索结构数据库（约半分钟）…', error: '' })
    try {
      const { spec } = await api.resolve(topic)
      set({ busy: `正在下载 ${spec.panels.map((p) => p.source.id).join('、')}…` })
      const panels = await Promise.all(spec.panels.map(loadPanel))
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
      set((s) => ({ spec, panels, colorings: panels.map((p) => p.coloring), ...freshLook(), style: cloneStyle(STYLE_MOLECULE), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  async loadId(id) {
    const clean = id.trim().toUpperCase()
    if (!/^[0-9][A-Z0-9]{3}$/.test(clean)) {
      set({ error: 'PDB 编号是 4 位，以数字开头，例如 2HHB' })
      return
    }
    set({ busy: `正在下载 ${clean}…`, error: '' })
    try {
      const mol = await loadMolecule({ kind: 'pdb', id: clean })
      const coloring = defaultColoring(mol)
      const spec: PanelSpec = {
        label: clean,
        source: { id: clean, kind: 'pdb', title: mol.title, method: '', resolution: null, year: null },
        assembly: defaultAssembly(mol),
        entities: mol.entities.map((e, i) => ({ entityId: e.id, role: coloring.roles[i]!, name: e.description || e.kind, description: e.description, organism: '' })),
        reason: '',
      }
      const scene: SceneSpec = { topic: clean, kind: 'molecule', title: mol.title || clean, caption: '', panels: [spec], notes: [] }
      set((s) => ({ spec: scene, panels: [{ spec, mol, coloring, align: null }], colorings: [coloring], ...freshLook(), rounds: [], busy: '', sceneRev: s.sceneRev + 1 }))
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
    return structuredClone({ rot: s.rot, zoom: s.zoom, shift: s.shift, style: s.style, colorings: s.colorings })
  },

  resetView() {
    set(freshLook())
  },

  applyEdits(edits) {
    const s = get()
    let rot = s.rot, zoom = s.zoom
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
        case 'line_width': style.lineWidth = e.value; break
        case 'inner_lines': style.contour.diffMax = e.value; break
        case 'shadow_strength': style.shadow.strength = e.value; break
        case 'shadow_floor': style.shadow.floor = e.value; break
        case 'fog_back': style.fog.back = e.value; break
        case 'background': style.background = parseHex(e.hex); break
      }
    }
    set({ rot, zoom, shift, style, colorings })
  },
}))
