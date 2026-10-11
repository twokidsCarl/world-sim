import type { IdeaDetail, State } from './contract'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function get<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(path)
  } catch {
    throw new ApiError(0, '连不上后端。先在 idea-loom 目录下运行 uv run idea-loom serve。')
  }
  if (!res.ok) {
    const detail = await res.json().then((b: { detail?: string }) => b.detail, () => undefined)
    throw new ApiError(res.status, detail ?? `请求失败（${res.status}）`)
  }
  return (await res.json()) as T
}

export const api = {
  state: () => get<State>('/api/state'),
  idea: (id: string) => get<IdeaDetail>(`/api/ideas/${encodeURIComponent(id)}`),
}
