import type { Frame, Substrate } from '../core/substrate'
import { gravitySubstrate } from './gravity'
import { isingSubstrate } from './ising'
import { mdSubstrate } from './md'

// Each substrate has its own frame type; the registry erases it.
export const SUBSTRATES = [mdSubstrate, isingSubstrate, gravitySubstrate] as unknown as Substrate<Frame>[]
