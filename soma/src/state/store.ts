// Application state. The viewer subscribes to this store and mirrors it into the scene;
// React components read it through `useApp`.

import { create } from 'zustand'
import { mapPartsBetween, type AnatomyGraph, type TreeKind } from '../anatomy/graph.ts'
import type { Provenance, SystemId } from '../anatomy/types.ts'
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

/** 'tissue': anatomical colours; 'source': colour by where the geometry came from. */
export type ColorMode = 'tissue' | 'source'

export interface LoadState {
  phase: 'loading' | 'ready' | 'error'
  /** 0..1 */
  progress: number
  message: string
  /** Systems whose geometry has arrived (for the per-system loading status). */
  loaded: readonly SystemId[]
}

/** Remembers, per body, that its caution list has been read. Storage may be unavailable. */
export function cautionsSeenKey(dataset: string, count: number): string {
  return `soma.cautions.${dataset}.${count}`
}

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // private mode / blocked storage: the list simply shows again next time
  }
}

export interface AppState {
  load: LoadState
  /** Dataset directory actually in use ("male", "fixture", …). */
  dataset: string
  /** Dataset the user asked for; the app loads it and then `dataset` follows. */
  requestedBody: string
  cautionsOpen: boolean
  /** Side-by-side comparison with the other body, restricted to one system. */
  compare: { system: SystemId } | null
  systemsBeforeCompare: Partial<Record<SystemId, SystemState>> | null
  /** Non-fatal notices shown in a dismissible banner (fallbacks, missing files). */
  notices: string[]
  graph: AnatomyGraph | null

  systems: Partial<Record<SystemId, SystemState>>
  peel: number
  hidden: ReadonlySet<string>
  isolated: ReadonlySet<string> | null
  adjacentMode: boolean
  colorMode: ColorMode
  provenanceHidden: ReadonlySet<Provenance>
  /** Draw nerves at a minimum on-screen width so they can be seen at body scale. */
  nerveBoost: boolean
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
  /** Switch to another body, carrying over selection, toggles and the camera. */
  switchBody(body: string): void
  setCautionsOpen(open: boolean): void
  /** Close the caution list and remember that this body's list has been read. */
  dismissCautions(): void
  setCompare(system: SystemId | null): void

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
  setColorMode(mode: ColorMode): void
  setProvenanceVisible(p: Provenance, visible: boolean): void
  setNerveBoost(on: boolean): void
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
  load: { phase: 'loading', progress: 0, message: '', loaded: [] },
  dataset: '',
  requestedBody: '',
  cautionsOpen: false,
  compare: null,
  systemsBeforeCompare: null,
  notices: [],
  graph: null,

  systems: {},
  peel: 0,
  hidden: new Set(),
  isolated: null,
  adjacentMode: false,
  colorMode: 'tissue',
  provenanceHidden: new Set(),
  nerveBoost: true,
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
    const prev = get()
    const from = prev.graph
    // switching bodies keeps what the user set up; a first load starts clean
    const carry = !!from && from !== graph
    const systems: Partial<Record<SystemId, SystemState>> = {}
    for (const sys of graph.data.systems) {
      systems[sys.id] = (carry && prev.systemsBeforeCompare?.[sys.id]) || (carry && prev.systems[sys.id]) || { visible: true, opacity: 1 }
    }
    // open the first level of each tree so the panel is not a single collapsed row
    const expanded = {
      isa: new Set(graph.roots('isa').map((c) => c.id)),
      partOf: new Set(graph.roots('partOf').map((c) => c.id)),
    }
    let selection = EMPTY_SELECTION
    let hidden = new Set<string>()
    let isolated: Set<string> | null = null
    if (carry && from) {
      const c = prev.selection.concept
      if (c && graph.concept(c.tree, c.id)) {
        const ids = graph.descendantParts(c.tree, c.id)
        selection = ids.length ? makeSelection(ids, c) : { ids: [], set: new Set(), concept: c }
      } else {
        selection = makeSelection(mapPartsBetween(from, graph, prev.selection.ids))
      }
      hidden = new Set(mapPartsBetween(from, graph, prev.hidden))
      if (prev.isolated) {
        const mapped = mapPartsBetween(from, graph, prev.isolated)
        isolated = mapped.length ? new Set(mapped) : null
      }
    }
    const cautions = graph.cautions.length
    set({
      graph,
      dataset,
      requestedBody: prev.requestedBody || dataset,
      systems,
      expanded,
      peel: carry ? Math.min(prev.peel, Math.max(0, graph.data.layers.length - 1)) : 0,
      hidden,
      isolated,
      adjacentMode: carry ? prev.adjacentMode : false,
      provenanceHidden: carry ? prev.provenanceHidden : new Set(),
      selection,
      hover: null,
      compare: null,
      systemsBeforeCompare: null,
      cautionsOpen: cautions > 0 && storageGet(cautionsSeenKey(dataset, cautions)) === null,
    })
  },

  switchBody: (body) => {
    if (body === get().requestedBody) return
    set({ requestedBody: body })
  },

  setCautionsOpen: (cautionsOpen) => set({ cautionsOpen }),
  dismissCautions: () => {
    const { graph, dataset } = get()
    if (graph?.cautions.length) storageSet(cautionsSeenKey(dataset, graph.cautions.length), '1')
    set({ cautionsOpen: false })
  },

  setCompare: (system) =>
    set((s) => {
      const base = s.systemsBeforeCompare ?? s.systems
      if (system === null) return { compare: null, systems: base, systemsBeforeCompare: null }
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(base) as [SystemId, SystemState][]) systems[k] = { ...v, visible: k === system }
      return { compare: { system }, systems, systemsBeforeCompare: base, isolated: null }
    }),

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
  setColorMode: (colorMode) => set({ colorMode }),
  setProvenanceVisible: (p, visible) =>
    set((s) => {
      const next = new Set(s.provenanceHidden)
      if (visible) next.delete(p)
      else next.add(p)
      return { provenanceHidden: next }
    }),
  setNerveBoost: (nerveBoost) => set({ nerveBoost }),
  showAll: () =>
    set((s) => {
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) systems[k] = { ...v, visible: true }
      return { systems, hidden: new Set(), isolated: null, adjacentMode: false, peel: 0, provenanceHidden: new Set() }
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
