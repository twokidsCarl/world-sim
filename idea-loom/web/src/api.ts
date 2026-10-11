import type { IdeaDetail, State, SyncResult, SyncStatus } from './contract'

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
  syncStatus: () => call<SyncStatus>('/api/sync'),
  sync: () => call<SyncResult>('/api/sync', {}),
}
