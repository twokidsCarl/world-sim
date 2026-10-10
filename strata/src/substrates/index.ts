import type { Frame, Substrate } from '../core/substrate'
import { isingSubstrate } from './ising'
import { mdSubstrate } from './md'

// Each substrate has its own frame type; the registry erases it.
export const SUBSTRATES = [mdSubstrate, isingSubstrate] as unknown as Substrate<Frame>[]
