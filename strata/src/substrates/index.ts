import type { Frame, Substrate } from '../core/substrate'
import { gravitySubstrate } from './gravity'
import { isingSubstrate } from './ising'
import { mdSubstrate } from './md'

// 各基底的帧类型各不相同；注册表把这一类型擦除。
// Each substrate has its own frame type; the registry erases it.
export const SUBSTRATES = [mdSubstrate, isingSubstrate, gravitySubstrate] as unknown as Substrate<Frame>[]
