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
export type VisitorWish = { id: string; by: string; title: string; stuck: string; where_url: string; where_title: string; status: 'waiting' | 'accepted' | 'dismissed'; kind: 'wish' | 'idea'; idea: { body?: string; level?: string; why?: string }; wish_id: string | null; note: string; created_at: string; updated_at: string }
export type WorkerStatus = {
  queued: { job_id: string; title: string; step: string | null; waiting: string | null }[]
  active: { job_id: string; title: string; phase: string }[]
  review: { job_id: string; title: string; pr_url: string | null }[]
  started_today: number; per_day: number; paused: string | null; worker_alive: boolean
  usage: { windows?: Record<string, { utilization: number | null; resets_at: number | null }> }
  chains: Record<string, number>
  maintenance: { enabled: boolean; below: number; window_minutes: number; check_seconds: number; per_day: number; last_check: { at?: number; why_not?: string | null }; recent: { at: number; item: string; directory: string; job_id: string }[] }
}
export type AgentToken = { id: string; name: string; scopes: string[]; created_at: number; revoked: boolean; token?: string }
// 会话、作业用掉的 token，四项和 Claude Code 的 usage 同名。 / Tokens used by a session or job; the four names are those of Claude Code's usage.
export type TokenUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
export type SessionMeta = { id: string; title: string; wish_id: string | null; mode: string; model: string; effort: string; model_used: string | null; status: 'idle' | 'running' | 'waiting' | 'closed' | 'error'; cost_usd: number; tokens?: TokenUsage; turns: number; waiting_for: string | null; created_at: number; updated_at: number; live: boolean; stale?: boolean; pid?: number | null; agents?: Subagent[] }
// 列表里会话下面的一个子 Agent。 / A subagent under its session in the list.
export type Subagent = { id: string; label: string; state: 'running' | 'done' | 'failed' | 'stopped' }
export type SessionList = { sessions: SessionMeta[]; unavailable: string | null; billing: 'subscription' | 'api_key'; modes: string[]; models: string[]; efforts: string[]; default_model: string }
export type GenTarget = { level?: string; thread?: string; kernel?: string; like?: string; text?: string }
export type Proposals = { proposals: Proposal[]; open: number; model_ready: boolean }
export type Wish = {
  wish_id: string; title: string; kind: string; kind_label: string; stuck: string; suggestion: string
  // 按记下的先后从 1 起的序号，给人叫的名字是 wish-N。 / The sequence number in recording order, from 1; people call it wish-N.
  number: number
  where: { url: string; title: string } | null; status: string; status_label: string; status_note: string | null
  pr: number | null; source: string; occurrences: number; created_at: string; updated_at: string
  // 正在做这条愿望的作业走到哪一步；没有作业在做时为空。
  // Where the job working on this wish has got to; empty when no job is.
  job_id?: string | null; job_phase?: string | null; job_label?: string | null; job_queued?: boolean
  // 有 Claude Code 会话在给它出计划时：谁、从什么时候起、到什么时候自动失效。没人认领时为空。
  // While a Claude Code session is planning it: who, since when and until when it lapses. Empty when unclaimed.
  claimed_by?: string | null; claimed_by_label?: string | null; claimed_at?: string | null; claim_until?: string | null; claim_note?: string | null
}
export type WishDetail = Wish & {
  copy_text: string
  seen: { at: string; question: string }[]
  notes: { at: string; by?: string; by_label: string; text: string }[]
  links: { at: string; kind: string; pr: number | null; url: string | null; title: string }[]
  history: { at: string; event?: string; event_label: string; by?: string; by_label: string; text: string }[]
}
export type WishList = { wishes: Wish[]; counts: Record<string, number>; kinds: Record<string, number>; statuses: Record<string, string>; kind_labels: Record<string, string>; groups?: Record<string, string[]>; unreadable: number }
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
  totals: Tokens; attention: Attention; own: { calls: number; cost_usd: number; output_tokens: number; tokens?: Tokens; by_purpose: Record<string, number>; in_transcripts?: number }
  transcripts_found: boolean; notes: string[]
}
export type Job = {
  job_id: string; kind: 'wish' | 'task'; ref: string; directory: string; title: string; what: string; phase: string; phase_label: string
  plan: string; feedback: string[]; error: string | null; summary: Record<string, unknown>; changed: string[]; test_log: string; denied: string[]; repairs: number
  pr: number | null; pr_url: string | null; restart_needed: boolean; cost_usd: number; tokens?: TokenUsage; created_at: string; updated_at: string
  queued: string | null; waiting: string | null
}
export type JobEvent = { seq: number; at: string; type: string; text?: string; label?: string; state?: string; id?: string; message?: string }
// 回看的一条发现：模型打了重要程度，够分的直接记进了许愿池（wish_id），其余的丢掉了。
// One finding of a review: the model rated its importance; those that scored high enough were recorded (wish_id), the rest dropped.
export type ReviewFinding = {
  title: string; kind: string; stuck: string; suggestion: string; evidence: string
  importance: number; reason: string; wish_id: string | null; rescued: boolean
}
export type ReviewRun = { id: string; at: string; trigger: 'auto' | 'manual'; actions: number; findings: ReviewFinding[]; error: string }
export type ReviewStatus = {
  actions_since: number; due: boolean; due_after: number; record_at: number; running: boolean; auto: boolean
  last_at: string | null; runs: ReviewRun[]
}
export type Text2 = { zh: string; en: string }
export type SimView = {
  name: string; title: Text2; level: string | null; ready: boolean; source: string; origin: string; status: string; playable: boolean
  stale: boolean; version: string; log: string; built_at: string | null; attempts: number; next_retry: string | null; has_api: boolean; api_running: boolean; cards: number
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
  wishes: (status = '', group = '') => call<WishList>(`/api/wishes?${new URLSearchParams({ ...(status && { status }), ...(group && { group }) }).toString()}`),
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
  agentTokens: () => call<AgentToken[]>('/api/agent-tokens'),
  createAgentToken: (name: string, scopes: string[]) => call<AgentToken>('/api/agent-tokens', { name, scopes }),
  revokeAgentToken: (id: string) => call<{ revoked: boolean }>(`/api/agent-tokens/${id}/revoke`, {}),
  sessions: () => call<SessionList>('/api/sessions'),
  session: (id: string) => call<SessionMeta>(`/api/sessions/${id}`),
  startSession: (body: { text: string; mode: string; title?: string; wish_id?: string; model?: string; effort?: string }) => call<SessionMeta>('/api/sessions', body),
  sessionSay: (id: string, text: string, images: { media_type: string; data: string; name: string }[] = []) => call<SessionMeta>(`/api/sessions/${id}/message`, { text, images }),
  sessionAnswer: (id: string, request_id: string, decision: string, note = '', answers: Record<string, string | string[]> = {}) => call<SessionMeta>(`/api/sessions/${id}/answer`, { request_id, decision, note, answers }),
  sessionInterrupt: (id: string) => call<SessionMeta>(`/api/sessions/${id}/interrupt`, {}),
  sessionMode: (id: string, mode: string) => call<SessionMeta>(`/api/sessions/${id}/mode`, { mode }),
  sessionEngine: (id: string, model: string, effort: string) => call<SessionMeta>(`/api/sessions/${id}/engine`, { model, effort }),
  sessionClose: (id: string) => call<SessionMeta>(`/api/sessions/${id}/close`, {}),
  // 立即重启后端（在下一个安全的时刻）。 / Restart the backend now (at the next safe moment).
  restart: () => call<{ restarting: boolean; waiting: string | null }>('/api/restart', {}),
  worker: () => call<WorkerStatus>('/api/worker'),
  chain: (directory: string, steps: number) => call<Record<string, number>>('/api/chains', { directory, steps }),
  advance: (dir: string) => call<Task>(`/api/projects/${dir}/advance`, {}),
  reviewStatus: () => call<ReviewStatus>('/api/review'),
  review: () => call<ReviewStatus>('/api/review', {}),
  rescueFinding: (runId: string, index: number) => call<WishDetail>(`/api/review/${runId}/rescue/${index}`, {}),
  play: (fresh = false) => call<PlayView>(`/api/play${fresh ? '?fresh=true' : ''}`),
  sendSuggestion: (body: { title: string; stuck: string; where_url: string; where_title: string }) => call<VisitorWish>('/api/suggestions', body),
  mySuggestions: () => call<VisitorWish[]>('/api/suggestions/mine'),
  suggestions: () => call<VisitorWish[]>('/api/suggestions'),
  acceptSuggestion: (id: string) => call<VisitorWish>(`/api/suggestions/${id}/accept`, {}),
  dismissSuggestion: (id: string) => call<VisitorWish>(`/api/suggestions/${id}/dismiss`, { note: '' }),
  syncStatus: () => call<SyncStatus>('/api/sync'),
  sync: () => call<SyncResult>('/api/sync', {}),
}
