import { create } from 'zustand'
import { loadMolecule } from '../mol/load'
import type { Molecule } from '../mol/types'
import type { View } from '../render/Renderer'
import { cloneStyle, STYLE_MOLECULE, type Style } from '../render/style'
import { defaultAssembly } from '../scene/build'
import { defaultColoring, spreadHues, type Coloring } from '../style/assign'
import type { Role } from '../style/palettes'

interface State {
  mol: Molecule | null
  assembly: string
  coloring: Coloring | null
  style: Style
  /** null = frame the whole scene */
  view: View | null
  /** bumped whenever the atoms on the GPU must be rebuilt */
  sceneRev: number
  busy: string
  error: string
  load(id: string): Promise<void>
  setAssembly(id: string): void
  setRole(entity: number, role: Role): void
  setStyle(patch: (s: Style) => void): void
  setView(v: View | null): void
}

export const useStore = create<State>((set, get) => ({
  mol: null,
  assembly: '',
  coloring: null,
  style: cloneStyle(STYLE_MOLECULE),
  view: null,
  sceneRev: 0,
  busy: '',
  error: '',

  async load(id) {
    const clean = id.trim().toLowerCase()
    if (!/^[0-9][a-z0-9]{3}$/.test(clean)) {
      set({ error: 'PDB 编号是 4 位，以数字开头，例如 2hhb' })
      return
    }
    set({ busy: `正在下载 ${clean.toUpperCase()}…`, error: '' })
    try {
      const mol = await loadMolecule({ kind: 'pdb', id: clean })
      set((s) => ({ mol, assembly: defaultAssembly(mol), coloring: defaultColoring(mol), view: null, busy: '', sceneRev: s.sceneRev + 1 }))
    } catch (e) {
      set({ busy: '', error: e instanceof Error ? e.message : String(e) })
    }
  },

  setAssembly(id) {
    set((s) => ({ assembly: id, view: null, sceneRev: s.sceneRev + 1 }))
  },

  setRole(entity, role) {
    const c = get().coloring
    if (!c) return
    const roles = c.roles.slice()
    roles[entity] = role
    set({ coloring: spreadHues({ ...c, roles }) })
  },

  setStyle(patch) {
    const style = cloneStyle(get().style)
    patch(style)
    set({ style })
  },

  setView(view) {
    set({ view })
  },
}))
