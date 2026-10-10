// Application state. The viewer subscribes to this store and mirrors it into the scene;
// React components read it through `useApp`.

import { create } from 'zustand'
import type { AnatomyGraph, TreeKind } from '../anatomy/graph.ts'
import type { SystemId } from '../anatomy/types.ts'
import type { SectionState, SystemState } from './display.ts'

export interface Selection {
  /** Selected part ids, in a stable order. */
  ids: readonly string[]
  set: ReadonlySet<string>
  /** Set when the selection came from choosing a concept (tree, search, breadcrumb). */
  concept: { tree: TreeKind; id: string } | null
}

export const EMPTY_SELECTION: Selection = { ids: [], set: new Set(), concept: null }

export type LeftTab = 'display' | 'tree'

export interface LoadState {
  phase: 'loading' | 'ready' | 'error'
  /** 0..1 */
  progress: number
  message: string
}

export interface AppState {
  load: LoadState
  /** Dataset directory actually in use ("male", "fixture", …). */
  dataset: string
  /** Non-fatal notices shown in a dismissible banner (fallbacks, missing files). */
  notices: string[]
  graph: AnatomyGraph | null

  systems: Partial<Record<SystemId, SystemState>>
  peel: number
  hidden: ReadonlySet<string>
  isolated: ReadonlySet<string> | null
  adjacentMode: boolean
  selection: Selection
  hover: string | null
  explode: number
  explodeSelectionOnly: boolean
  section: SectionState
  /** Bumped to ask the viewer to frame `ids` (or the selection, or everything visible). */
  focusRequest: { nonce: number; ids: readonly string[] | null }
  /** Bumped to ask the viewer to return to the home view. */
  homeRequest: number

  leftTab: LeftTab
  treeTab: TreeKind
  expanded: Record<TreeKind, ReadonlySet<string>>
  /** Concept the tree should scroll to; nonce makes repeated reveals of one concept work. */
  reveal: { tree: TreeKind; id: string; nonce: number } | null
  leftOpen: boolean
  rightOpen: boolean
  aboutOpen: boolean

  setLoad(load: Partial<LoadState>): void
  addNotice(text: string): void
  dismissNotices(): void
  init(graph: AnatomyGraph, dataset: string): void

  selectParts(ids: readonly string[], opts?: { additive?: boolean }): void
  selectConcept(tree: TreeKind, id: string, opts?: { reveal?: boolean }): void
  selectFma(fma: string): boolean
  clearSelection(): void
  setHover(id: string | null): void

  setSystemVisible(id: SystemId, visible: boolean): void
  setSystemOpacity(id: SystemId, opacity: number): void
  soloSystem(id: SystemId): void
  setPeel(depth: number): void
  hideParts(ids: Iterable<string>): void
  showParts(ids: Iterable<string>): void
  hideSelection(): void
  isolateSelection(): void
  clearIsolation(): void
  setAdjacentMode(on: boolean): void
  showAll(): void
  setExplode(amount: number): void
  setExplodeSelectionOnly(on: boolean): void
  setSection(patch: Partial<SectionState>): void
  requestFocus(ids?: readonly string[] | null): void
  requestHome(): void

  setLeftTab(tab: LeftTab): void
  setTreeTab(tab: TreeKind): void
  toggleExpanded(tree: TreeKind, id: string): void
  revealConcept(tree: TreeKind, id: string): void
  setLeftOpen(open: boolean): void
  setRightOpen(open: boolean): void
  setAboutOpen(open: boolean): void
}

function makeSelection(ids: readonly string[], concept: Selection['concept'] = null): Selection {
  const set = new Set(ids)
  return set.size === 0 ? EMPTY_SELECTION : { ids: [...set], set, concept }
}

/** True when exactly one system is visible and it is `id`. */
export function isSolo(systems: Partial<Record<SystemId, SystemState>>, id: SystemId): boolean {
  let n = 0
  for (const s of Object.values(systems)) if (s.visible) n++
  return n === 1 && !!systems[id]?.visible
}

export const useApp = create<AppState>()((set, get) => ({
  load: { phase: 'loading', progress: 0, message: '' },
  dataset: '',
  notices: [],
  graph: null,

  systems: {},
  peel: 0,
  hidden: new Set(),
  isolated: null,
  adjacentMode: false,
  selection: EMPTY_SELECTION,
  hover: null,
  explode: 0,
  explodeSelectionOnly: false,
  section: { enabled: false, axis: 'axial', position: 0.6, flip: false },
  focusRequest: { nonce: 0, ids: null },
  homeRequest: 0,

  leftTab: 'display',
  treeTab: 'isa',
  expanded: { isa: new Set(), partOf: new Set() },
  reveal: null,
  leftOpen: false,
  rightOpen: false,
  aboutOpen: false,

  setLoad: (load) => set((s) => ({ load: { ...s.load, ...load } })),
  addNotice: (text) => set((s) => (s.notices.includes(text) ? s : { notices: [...s.notices, text] })),
  dismissNotices: () => set({ notices: [] }),

  init: (graph, dataset) => {
    const systems: Partial<Record<SystemId, SystemState>> = {}
    for (const sys of graph.data.systems) systems[sys.id] = { visible: true, opacity: 1 }
    // open the first level of each tree so the panel is not a single collapsed row
    const expanded = {
      isa: new Set(graph.roots('isa').map((c) => c.id)),
      partOf: new Set(graph.roots('partOf').map((c) => c.id)),
    }
    set({
      graph,
      dataset,
      systems,
      expanded,
      peel: 0,
      hidden: new Set(),
      isolated: null,
      adjacentMode: false,
      selection: EMPTY_SELECTION,
      hover: null,
    })
  },

  selectParts: (ids, opts) => {
    const { graph, selection } = get()
    if (!graph) return
    const valid = ids.filter((id) => graph.part(id))
    if (opts?.additive) {
      const next = new Set(selection.set)
      for (const id of valid) {
        if (next.has(id) && valid.length === 1) next.delete(id)
        else next.add(id)
      }
      set({ selection: makeSelection([...next]) })
    } else {
      set({ selection: makeSelection(valid) })
    }
  },

  selectConcept: (tree, id, opts) => {
    const { graph } = get()
    if (!graph || !graph.concept(tree, id)) return
    const ids = graph.descendantParts(tree, id)
    set({
      selection: ids.length ? makeSelection(ids, { tree, id }) : { ids: [], set: new Set(), concept: { tree, id } },
    })
    if (opts?.reveal) get().revealConcept(tree, id)
  },

  selectFma: (fma) => {
    const { graph } = get()
    if (!graph) return false
    const direct = graph.partsByFma(fma)
    if (direct.length) {
      get().selectParts(direct.map((p) => p.id))
      return true
    }
    for (const tree of ['isa', 'partOf'] as const) {
      if (graph.partCount(tree, fma) > 0) {
        get().selectConcept(tree, fma)
        return true
      }
    }
    return false
  },

  clearSelection: () => set({ selection: EMPTY_SELECTION }),
  setHover: (id) => {
    if (get().hover !== id) set({ hover: id })
  },

  setSystemVisible: (id, visible) =>
    set((s) => ({ systems: { ...s.systems, [id]: { opacity: s.systems[id]?.opacity ?? 1, visible } } })),
  setSystemOpacity: (id, opacity) =>
    set((s) => ({
      systems: { ...s.systems, [id]: { visible: s.systems[id]?.visible ?? true, opacity: Math.min(1, Math.max(0, opacity)) } },
    })),
  soloSystem: (id) =>
    set((s) => {
      const restore = isSolo(s.systems, id)
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) {
        systems[k] = { ...v, visible: restore || k === id }
      }
      return { systems }
    }),
  setPeel: (depth) => set({ peel: Math.max(0, Math.round(depth)) }),

  hideParts: (ids) =>
    set((s) => {
      const hidden = new Set(s.hidden)
      for (const id of ids) hidden.add(id)
      return { hidden }
    }),
  showParts: (ids) =>
    set((s) => {
      const hidden = new Set(s.hidden)
      for (const id of ids) hidden.delete(id)
      return { hidden }
    }),
  hideSelection: () => {
    const { selection } = get()
    if (!selection.ids.length) return
    get().hideParts(selection.ids)
    // a selected part is always drawn, so hiding has to drop the selection too
    set((s) => ({
      selection: EMPTY_SELECTION,
      isolated: s.isolated ? new Set([...s.isolated].filter((id) => !selection.set.has(id))) : null,
    }))
  },
  isolateSelection: () => {
    const { selection } = get()
    if (selection.ids.length) set({ isolated: new Set(selection.ids) })
  },
  clearIsolation: () => set({ isolated: null }),
  setAdjacentMode: (on) => set({ adjacentMode: on }),
  showAll: () =>
    set((s) => {
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) systems[k] = { ...v, visible: true }
      return { systems, hidden: new Set(), isolated: null, adjacentMode: false, peel: 0 }
    }),

  setExplode: (amount) => set({ explode: Math.min(1, Math.max(0, amount)) }),
  setExplodeSelectionOnly: (on) => set({ explodeSelectionOnly: on }),
  setSection: (patch) => set((s) => ({ section: { ...s.section, ...patch } })),
  requestFocus: (ids = null) => set((s) => ({ focusRequest: { nonce: s.focusRequest.nonce + 1, ids } })),
  requestHome: () => set((s) => ({ homeRequest: s.homeRequest + 1 })),

  setLeftTab: (leftTab) => set({ leftTab }),
  setTreeTab: (treeTab) => set({ treeTab }),
  toggleExpanded: (tree, id) =>
    set((s) => {
      const next = new Set(s.expanded[tree])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: { ...s.expanded, [tree]: next } }
    }),
  revealConcept: (tree, id) => {
    const { graph } = get()
    if (!graph?.concept(tree, id)) return
    set((s) => {
      const next = new Set(s.expanded[tree])
      for (const a of graph.ancestors(tree, id)) next.add(a.id)
      return {
        expanded: { ...s.expanded, [tree]: next },
        treeTab: tree,
        leftTab: 'tree',
        reveal: { tree, id, nonce: (s.reveal?.nonce ?? 0) + 1 },
      }
    })
  },
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
}))
