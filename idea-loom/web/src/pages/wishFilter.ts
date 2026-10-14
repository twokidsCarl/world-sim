// 许愿池的筛选分两层：先选组（待处理、已完结、全部），再在组里选一个状态。
// 「待处理」是「未处理」加「已采纳」的合计，原来和它的组成部分并排放着，看不出谁包含谁。
// The wish pool filter has two tiers: a group first (pending, closed, all), then one status within it.
// "Pending" is the sum of open and accepted; it used to sit beside its own parts with nothing showing which contains which.

export type WishGroup = 'pending' | 'closed' | 'all'

export const WISH_GROUPS: readonly WishGroup[] = ['pending', 'closed', 'all']

// 后端没给分组时（旧后端）用这一份。 / Used when the backend sends no groups (an old backend).
export const DEFAULT_GROUPS: Record<WishGroup, readonly string[]> = {
  pending: ['open', 'accepted'],
  closed: ['done', 'declined', 'withdrawn'],
  all: ['open', 'accepted', 'done', 'declined', 'withdrawn'],
}

export type WishFilter = { group: WishGroup; status: string }

/**
 * 从地址里读出筛选。只有 ?status= 的旧链接照常能用：组取包含这个状态的那一组。状态不在所选的组里时不算。
 * Read the filter from the address. Old links carrying only ?status= go on working: the group is the one holding that status. A status outside the chosen group does not count.
 */
export function readFilter(params: URLSearchParams, groups: Record<string, readonly string[]> = DEFAULT_GROUPS): WishFilter {
  const status = params.get('status') ?? ''
  const asked = params.get('group') ?? ''
  const known = (WISH_GROUPS as readonly string[]).includes(asked)
  const group = (known ? asked : (WISH_GROUPS.find((g) => g !== 'all' && (groups[g] ?? []).includes(status)) ?? 'pending')) as WishGroup
  return { group, status: (groups[group] ?? []).includes(status) ? status : '' }
}

/** 筛选写回地址：缺省的（待处理、不限状态）什么都不写。 / The filter back into the address: the default (pending, any status) writes nothing. */
export function writeFilter(filter: WishFilter): Record<string, string> {
  const out: Record<string, string> = {}
  if (filter.group !== 'pending') out.group = filter.group
  if (filter.status) out.status = filter.status
  return out
}

/** 一组里一共多少条。 / How many wishes a group holds. */
export function groupCount(group: WishGroup, counts: Record<string, number>, groups: Record<string, readonly string[]> = DEFAULT_GROUPS): number {
  return (groups[group] ?? []).reduce((sum, status) => sum + (counts[status] ?? 0), 0)
}
