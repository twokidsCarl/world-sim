// 数据契约的入口。types.gen.ts 由 `bun run gen:types` 从后端的 pydantic 模型生成，不要手改。
// Entry point of the data contract. types.gen.ts is generated from the backend's
// pydantic models by `bun run gen:types`; do not edit it by hand.
export type {
  State,
  Frame,
  LevelInfo,
  ThreadInfo,
  KernelInfo,
  KernelCount,
  Idea,
  IdeaDetail,
  HistoryItem,
  Version,
  Link,
  Coverage,
  Project1 as Project,
} from './types.gen'

export type LevelId = import('./types.gen').LevelInfo['id']
export type ThreadId = import('./types.gen').ThreadInfo['id']
export type Status = import('./types.gen').Idea['status']
