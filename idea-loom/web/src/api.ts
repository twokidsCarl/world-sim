import { note } from './assistant/trail'
import type { IdeaDetail, Proposal, State, SyncResult, SyncStatus } from './contract'
import { currentLang, tr } from './i18n'

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
    throw new ApiError(0, tr(currentLang(), '连不上后端。先在 idea-loom 目录下运行 uv run idea-loom serve。', 'Cannot reach the backend. Run uv run idea-loom serve in the idea-loom directory first.'))
  }
  if (!res.ok) {
    const detail = await res.json().then(
      (b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : undefined),
      () => undefined,
    )
    note('error', `${path.split('?')[0]}${tr(currentLang(), '：', ': ')}${detail ?? res.status}`)
    throw new ApiError(res.status, detail ?? tr(currentLang(), `请求失败（${res.status}）`, `Request failed (${res.status})`))
  }
  return (await res.json()) as T
}

const idea = (id: string, action = '') => `/api/ideas/${encodeURIComponent(id)}${action && `/${action}`}`

// 现在是谁在用。auth_enabled 为假是本地模式：不用登录，就是主人。
// Who is using it now. auth_enabled false means local mode: no sign-in, you are the owner.
export type Me = { role: 'guest' | 'member' | 'owner'; login: string; name: string; avatar: string; auth_enabled: boolean }
export type GenTarget = { level?: string; thread?: string; kernel?: string; like?: string; text?: string }
export type Proposals = { proposals: Proposal[]; open: number; model_ready: boolean }
export type Wish = {
  wish_id: string; title: string; kind: string; kind_label: string; stuck: string; suggestion: string
  where: { url: string; title: string } | null; status: string; status_label: string; status_note: string | null
  pr: number | null; source: string; occurrences: number; created_at: string; updated_at: string
}
export type WishDetail = Wish & {
  copy_text: string
  seen: { at: string; question: string }[]
  notes: { at: string; by?: string; by_label: string; text: string }[]
  links: { at: string; kind: string; pr: number | null; url: string | null; title: string }[]
  history: { at: string; event?: string; event_label: string; by?: string; by_label: string; text: string }[]
}
export type WishList = { wishes: Wish[]; counts: Record<string, number>; kinds: Record<string, number>; statuses: Record<string, string>; kind_labels: Record<string, string>; unreadable: number }
export type PullRequest = { number: number; title: string; scope: string; state: string; created_at: string; merged_at: string | null; additions: number; deletions: number; url: string }
export type ProjectView = {
  dir: string; tagline: string; level: string | null; ideas: string[]; linked: string[]; ui_url: string | null; ui_up: boolean
  prs: number; merged: number; last_merged_at: string | null; recent: PullRequest[]; has_readme: boolean
}
export type Task = {
  task_id: string; idea_id: string | null; project: string; title: string; brief: string; status: string; status_label: string
  pr: number | null; pr_url: string | null; job_id: string | null; created_at: string; updated_at: string; notes: { at: string; by: string; text: string }[]
}
export type Tokens = { input: number; output: number; cache_read: number; cache_write: number; messages: number }
export type Segment = { start: string; end: string; seconds: number; output_tokens: number }
export type Session = { id: string; project: string; title: string; first_at: string; last_at: string; active_seconds: number; prompts: number; tool_calls: number; subagents: number; tokens: Tokens; segments: Segment[] }
export type ProjectStats = {
  dir: string; tokens: Tokens; sessions: number; active_seconds: number; prs: number; merged: number; first_pr_at: string | null; last_pr_at: string | null
  median_merge_seconds: number | null; additions: number; deletions: number; lines: number; files: number; by_language: Record<string, number>
  tokens_per_line: number | null; tokens_per_pr: number | null
}
export type Attention = {
  total_seconds: number; by_page: Record<string, number>; ideas: { id: string; title: string; seconds: number; opens: number; last_at: string | null }[]
  never_opened: string[]; cells: Record<string, Record<string, number>>; by_level: Record<string, number>; by_kernel: Record<string, number>
  clicks: number; questions: number; feature_uses: Record<string, number>; proposals_kept: number; proposals_dropped: number; days: number
}
export type Stats = {
  generated_at: string; projects: ProjectStats[]; sessions: Session[]; days: { day: string; project: string; merged: number; additions: number; output_tokens: number }[]
  totals: Tokens; attention: Attention; own: { calls: number; cost_usd: number; output_tokens: number; by_purpose: Record<string, number> }
  transcripts_found: boolean; notes: string[]
}
export type Job = {
  job_id: string; kind: 'wish' | 'task'; ref: string; directory: string; title: string; what: string; phase: string; phase_label: string
  plan: string; feedback: string[]; error: string | null; summary: Record<string, unknown>; changed: string[]; test_log: string; denied: string[]; repairs: number
  pr: number | null; pr_url: string | null; restart_needed: boolean; cost_usd: number; created_at: string; updated_at: string
  queued: string | null; waiting: string | null
}
export type JobEvent = { seq: number; at: string; type: string; text?: string; label?: string; state?: string; id?: string; message?: string }
export type Suggestion = { title: string; kind: string; stuck: string; suggestion: string; evidence: string }
export type Text2 = { zh: string; en: string }
export type SimView = {
  name: string; title: Text2; level: string | null; ready: boolean; source: string; origin: string; status: string; playable: boolean
  stale: boolean; version: string; log: string; built_at: string | null; has_api: boolean; api_running: boolean; cards: number
}
export type CardView = { key: string; sim: string; sim_title: Text2; level: string | null; id: string; title: Text2; hint: Text2; idea: string | null; url: string; status: string }
export type CardHistory = { views: number; seconds: number; quick_skips: number; liked: boolean; last_at: string }
export type PlayView = { sims: SimView[]; cards: CardView[]; problems: { name: string; source: string; error: string }[]; history: Record<string, CardHistory> }
export type NewIdea = { title: string; body: string; level: string; threads: string[]; kernel: string | null }

export const api = {
  me: () => call<Me>('/api/me'),
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
  wishes: (status = '') => call<WishList>(`/api/wishes${status && `?status=${status}`}`),
  wish: (id: string) => call<WishDetail>(`/api/wishes/${id}`),
  editWish: (id: string, body: { title?: string; kind?: string; stuck?: string; suggestion?: string }) => call<WishDetail>(`/api/wishes/${id}/edit`, body),
  withdrawWish: (id: string) => call<WishDetail>(`/api/wishes/${id}/withdraw`, {}),
  restoreWish: (id: string) => call<WishDetail>(`/api/wishes/${id}/restore`, {}),
  projects: () => call<ProjectView[]>('/api/projects'),
  tasks: () => call<Task[]>('/api/tasks'),
  createTask: (body: { project: string; title: string; brief: string; idea_id: string | null }) => call<Task>('/api/tasks', body),
  taskStatus: (id: string, status: string, note = '') => call<Task>(`/api/tasks/${id}/status`, { status, note }),
  linkProject: (dir: string, idea_id: string, linked: boolean) => call<{ ok: boolean }>(`/api/projects/${dir}/link`, { idea_id, linked }),
  stats: (refresh = false) => call<Stats>(`/api/stats${refresh ? '?refresh=true' : ''}`),
  jobs: () => call<Job[]>('/api/jobs'),
  job: (id: string, after = 0) => call<{ job: Job; events: JobEvent[] }>(`/api/jobs/${id}?after=${after}`),
  startJob: (kind: 'wish' | 'task', ref: string) => call<Job>('/api/jobs', { kind, ref }),
  jobAction: (id: string, action: 'approve' | 'cancel' | 'revert' | 'resume') => call<unknown>(`/api/jobs/${id}/${action}`, {}),
  jobText: (id: string, action: 'revise' | 'decline', text: string) => call<Job>(`/api/jobs/${id}/${action}`, { text }),
  advance: (dir: string) => call<Task>(`/api/projects/${dir}/advance`, {}),
  reviewStatus: () => call<{ actions_since: number; due: boolean; last_at: string | null }>('/api/review'),
  review: () => call<Suggestion[]>('/api/review', {}),
  recordWish: (body: { title: string; kind: string; stuck: string; suggestion: string }) => call<WishDetail>('/api/wishes', body),
  play: () => call<PlayView>('/api/play'),
  rebuildSim: (name: string) => call<{ status: string }>(`/api/play/${name}/build`, {}),
  syncStatus: () => call<SyncStatus>('/api/sync'),
  sync: () => call<SyncResult>('/api/sync', {}),
}
