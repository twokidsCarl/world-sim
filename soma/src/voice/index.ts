// 疼痛发声合成器的对外接口。/ Public interface of the pain-vocalisation synthesizer.
export { painVocalisation, soundProbability, typeProbabilities, VIVAE_LEVELS, RAINE_LEVELS, RAINE_2019, VOCAL_TRACT_CM } from './control.ts'
export type { Knots, PainVocalisation, PainVocalisationInput } from './control.ts'
export { FITTED } from './fitted.ts'
export { computeTimeline, formants, renderVocalisation, TIMELINE_FRAME_RATE } from './synth.ts'
export { schedulePainVocalisation, toAudioBuffer } from './webaudio.ts'
export type { ScheduledVocalisation } from './webaudio.ts'
export type * from './types.ts'
