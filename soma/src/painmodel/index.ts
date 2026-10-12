// 疼痛输入模型的入口。这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。
// Entry point of the pain input model. A computational model of pain physiology and behaviour
// for teaching: the simulated body has no subjective experience.

export { DISCLAIMER, evaluateStimulus, locate, nearestSkinVertex, painMapWeights, prepareStimulus, sideOf, stimulusDrive, type PainEvaluation } from './model.ts'
export { buildNerveIndex, nervePath, type NerveIndex } from './path.ts'
export { AUTONOMIC, AUTONOMIC_SIGNS, NOCICEPTION, REFLEX, REGIONS, SOURCES, siteThreshold, sourcesById, type AutonomicSignId, type Quantity } from './tables.ts'
export type * from './types.ts'
