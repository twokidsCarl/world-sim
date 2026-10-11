// 从运行记录到画面所需量的纯函数推导。不碰 DOM，可单测（tests/derive.test.ts）。
import type { Event as SimEvent, Manifest, Message, Person, Population, Series } from '../contract/types.gen.ts'

export type { SimEvent }

export const BELIEF = 0
export const FEAR = 1
export const EXPECT = 2
export const STATUS = 3
export const UNAWARE = 0
export const AWARE = 1
export const QUEUEING = 2
export const WITHDREW = 3
export const LOST = 4
export const STATUS_NAMES = ['未闻', '知情', '排队', '已取', '受损']

export interface RunData {
  manifest: Manifest
  population: Population
  messages: Message[]
  series: Series
  events: SimEvent[]
  frames: Uint8Array
  /** tickStart[k] 是第 k 个 tick 的第一条事件在 events 里的下标，长度 ticks + 2 */
  tickStart: number[]
  /** 每个人第几个去排队；没排过的是 -1 */
  queueOrder: Int32Array
  /** 每个人的邻居下标 */
  neighbors: number[][]
  cast: Person[]
}

export function parseEvents(text: string): SimEvent[] {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as SimEvent)
}

export function indexByTick(events: SimEvent[], ticks: number): number[] {
  const start = new Array<number>(ticks + 2).fill(events.length)
  for (let i = events.length - 1; i >= 0; i--) start[events[i]!.t] = i
  for (let k = ticks; k >= 0; k--) start[k] = Math.min(start[k]!, start[k + 1]!)
  return start
}

export function eventsAt(run: RunData, k: number): SimEvent[] {
  if (k < 0 || k > run.manifest.ticks) return []
  return run.events.slice(run.tickStart[k], run.tickStart[k + 1])
}

export function assemble(
  manifest: Manifest,
  population: Population,
  messages: Message[],
  series: Series,
  events: SimEvent[],
  frames: Uint8Array,
): RunData {
  const n = manifest.n
  const queueOrder = new Int32Array(n).fill(-1)
  let order = 0
  for (const e of events) if (e.k === 'queue' && e.a != null) queueOrder[e.a] = order++
  const neighbors: number[][] = Array.from({ length: n }, () => [])
  for (const t of population.ties) {
    neighbors[t.a]!.push(t.b)
    neighbors[t.b]!.push(t.a)
  }
  const castOrder = Object.values(population.cast)
  return {
    manifest,
    population,
    messages,
    series,
    events,
    frames,
    tickStart: indexByTick(events, manifest.ticks),
    queueOrder,
    neighbors,
    cast: castOrder.map((i) => population.persons[i]!),
  }
}

/** 第 k 帧里某通道某人的值，0..255（status 通道是状态码） */
export function value(run: RunData, k: number, channel: number, i: number): number {
  const n = run.manifest.n
  return run.frames[(k * 4 + channel) * n + i] ?? 0
}

/** 第 k 帧整条通道，零拷贝 */
export function channel(run: RunData, k: number, c: number): Uint8Array {
  const n = run.manifest.n
  return run.frames.subarray((k * 4 + c) * n, (k * 4 + c + 1) * n)
}

/** 第 k 帧正在排队的人各自排第几（0 起）；不在队里的是 -1 */
export function queueRanks(run: RunData, k: number): Int32Array {
  const status = channel(run, k, STATUS)
  const inLine: number[] = []
  for (let i = 0; i < status.length; i++) if (status[i] === QUEUEING) inLine.push(i)
  inLine.sort((a, b) => run.queueOrder[a]! - run.queueOrder[b]!)
  const rank = new Int32Array(status.length).fill(-1)
  inLine.forEach((i, r) => (rank[i] = r))
  return rank
}

/** 队伍里第 rank 个人站在钱庄周围的哪里：向日葵排布，人越多围得越厚 */
export function queueSlot(bank: [number, number], rank: number): [number, number] {
  const r = 16 + 4.2 * Math.sqrt(rank)
  const a = rank * 2.39996
  return [bank[0] + r * Math.cos(a), bank[1] + r * Math.sin(a)]
}

/** 与某人有关的全部事件：他做的，和别人对他说的 */
export function personLog(run: RunData, i: number): SimEvent[] {
  return run.events.filter((e) => e.a === i || (e.k === 'tell' && e.b === i))
}

export function clock(run: RunData, t: number): { day: number; hour: number; night: boolean } {
  const h = (run.manifest.params.start_hour ?? 0) + Math.floor(t)
  const hour = h % 24
  return { day: Math.floor(h / 24) + 1, hour, night: hour >= 23 || hour < 6 }
}

export function dayName(day: number): string {
  return day <= 10 ? `第${'一二三四五六七八九十'[day - 1]}天` : `第 ${day} 天`
}

export function clockText(run: RunData, t: number): string {
  const c = clock(run, t)
  return `${dayName(c.day)} ${String(c.hour).padStart(2, '0')}:00`
}
