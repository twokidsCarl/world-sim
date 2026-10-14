// 愿望给人叫的名字是 wish-N：N 是按记下的先后从 1 起的序号，后端算好了给出来。
// 旧的记录（比如回放的小助手对话）里没有序号时返回空串，界面就不显示名字。
// People call a wish wish-N: N is its sequence number in recording order, from 1, computed by the backend.
// Old records (such as a replayed assistant conversation) carry no number; then this returns an empty string and the UI shows no name.

export function wishName(number: number | null | undefined): string {
  return typeof number === 'number' && number > 0 ? `wish-${number}` : ''
}

// 交给 Claude Code 的命令：/wishes wish-N；没有序号（旧后端）时退回完整编号。
// The command for Claude Code: /wishes wish-N; without a number (an old backend) it falls back to the full id.
export function wishCommand(wish: { number?: number | null; wish_id: string }): string {
  return `/wishes ${wishName(wish.number) || wish.wish_id}`
}
