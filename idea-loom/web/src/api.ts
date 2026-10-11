import type { IdeaDetail, Proposal, State, SyncResult, SyncStatus } from './contract'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new ApiError(0, '连不上后端。先在 idea-loom 目录下运行 uv run idea-loom serve。')
  }
  if (!res.ok) {
    const detail = await res.json().then(
      (b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : undefined),
      () => undefined,
    )
    throw new ApiError(res.status, detail ?? `请求失败（${res.status}）`)
  }
  return (await res.json()) as T
}

const idea = (id: string, action = '') => `/api/ideas/${encodeURIComponent(id)}${action && `/${action}`}`

export type GenTarget = { level?: string; thread?: string; kernel?: string; like?: string; text?: string }
export type Proposals = { proposals: Proposal[]; open: number; model_ready: boolean }
export type NewIdea = { title: string; body: string; level: string; threads: string[]; kernel: string | null }

export const api = {
  state: () => call<State>('/api/state'),
  idea: (id: string) => call<IdeaDetail>(idea(id)),
  create: (body: NewIdea) => call<IdeaDetail>('/api/ideas', body),
  edit: (id: string, body: { title?: string; body?: string }) => call<IdeaDetail>(idea(id, 'edit'), body),
  move: (id: string, body: { threads?: string[]; kernel?: string; clear_kernel?: boolean }) => call<IdeaDetail>(idea(id, 'move'), body),
  merge: (id: string, target: string, reason: string) => call<IdeaDetail>(idea(id, 'merge'), { target, reason }),
  discard: (id: string, reason: string) => call<IdeaDetail>(idea(id, 'discard'), { reason }),
  restore: (id: string) => call<IdeaDetail>(idea(id, 'restore'), {}),
  setStatus: (id: string, status: string) => call<IdeaDetail>(idea(id, 'status'), { status }),
  proposals: () => call<Proposals>('/api/proposals'),
  generate: (target: GenTarget, n: number) => call<Proposal[]>('/api/ops/generate', { target, n }),
  refine: (idea_id: string, hint: string, n = 3) => call<Proposal[]>('/api/ops/refine', { idea_id, hint, n }),
  fuse: (idea_ids: string[]) => call<Proposal>('/api/ops/fuse', { idea_ids }),
  classify: (idea_ids?: string[]) => call<Proposal[]>('/api/ops/classify', { idea_ids: idea_ids ?? null }),
  dedupe: (scope: { level?: string; kernel?: string }) => call<Proposal[]>('/api/ops/dedupe', scope),
  translate: () => call<{ translated: string[] }>('/api/ops/translate', { idea_ids: null }),
  accept: (id: string, body: { as_new?: boolean; title?: string; body?: string } = {}) => call<Proposal>(`/api/proposals/${id}/accept`, body),
  dismiss: (id: string) => call<Proposal>(`/api/proposals/${id}/dismiss`, {}),
  syncStatus: () => call<SyncStatus>('/api/sync'),
  sync: () => call<SyncResult>('/api/sync', {}),
}
