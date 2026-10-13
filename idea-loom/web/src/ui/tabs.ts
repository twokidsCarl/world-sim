// 地址里 ?tab= 的取值：合法就用，空的或乱写的回到默认（allowed 的第一个）。
// The ?tab= value in the address: use it if valid; empty or garbage falls back to the default (the first of allowed).
export function parseTab<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T = allowed[0]!): T {
  const v = (raw ?? '').trim().toLowerCase()
  return allowed.find((a) => a === v) ?? fallback
}

// 左侧栏记在浏览器里的宽窄：只有 'narrow' 算收窄，没记过或乱写的都是宽。
// The saved width of the left navigation: only 'narrow' means collapsed; nothing saved, or garbage, means wide.
export function parseNav(raw: string | null | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'narrow'
}

// 最近的 n 条：按 last_at 倒序取，不依赖传进来的顺序，也不改原数组。
// The n most recent: taken by last_at descending, independent of the incoming order, without mutating the input.
export function recent<T extends { last_at: string }>(items: readonly T[], n: number): T[] {
  return [...items].sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at)).slice(0, Math.max(0, n))
}
