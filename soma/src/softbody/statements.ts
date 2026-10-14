// 软组织物理在界面上必须明说的事：哪些验证过、哪些没有。界面（按压、体位、嵌入卡片、注意事项）都从这里取。
// What the UI must say plainly about the soft-tissue physics: what was validated and what was not. Every place in the
// UI (press, posture, embed cards, cautions) takes its text from here.

import type { PressSummary } from './protocol.ts'

const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : '—')

export interface Statement {
  zh: string
  en: string
}

/** 按压：验证过的范围 / Pressing: the validated range. */
export const PRESS_VALIDATED: Statement = {
  zh: '按压只在男性前臂上与文献对照过，并且只在下面的范围内：半径 5 mm 的球约到 1 N；直径 26 mm 的平头压头，力为实测（forearm2026）的 0.66–0.83 倍（界面的缺省单元是半径的三分之一，在前臂中段给出 0.65 倍）；压应变验证到 0.4，超过 0.6 不再加深（"压溃闸"）。',
  en: 'Pressing has been compared with the literature on the male forearm only, and only within this range: a 5 mm-radius sphere reaches about 1 N; a 26 mm-diameter flat punch gives 0.66–0.83 of the measured force (forearm2026; the default cell of the UI, a third of the radius, gives 0.65 on the mid-forearm); compressive strain is validated to 0.4 and the press goes no deeper once it passes 0.6 (the "crush gate").',
}

export const PRESS_CAVEATS: Statement[] = [
  PRESS_VALIDATED,
  { zh: '前臂以外的部位（包括胸部和腹部）没有对照数据：结果是模型的推算，没有验证。9 mm 平头压头比 zheng1999 硬约两到三倍；腹部 20 mm 深时力偏大 43%。', en: 'Sites other than the forearm (the chest and the abdomen included) have no reference data: the results are the model\'s extrapolation, not validated. A 9 mm flat punch is about two to three times stiffer than zheng1999; on the abdomen the force at 20 mm is 43 % too high.' },
  { zh: '几牛以上的钝压需要超过 0.6 的压应变，模型到不了：力控会停在闸内最深处，并如实报告达到的力。', en: 'A pressure of more than a few newtons needs compressive strain beyond 0.6, which the model cannot reach: force control stops at the deepest depth inside the gate and reports the force actually reached.' },
  { zh: '皮肤网格太粗（前臂、胸部的边长约 12–17 mm），凹陷画在压入点周围细分到约 1.5 mm（或半个单元）的一层上；它盖住的皮肤三角形和皮下脂肪在显示时向里收。皮肤半透明时不画这一层，凹陷只落在原顶点上，显得浅而宽。数字以求解器为准。松开后的回弹是显示用的过渡，组织的蠕变恢复没有模拟。', en: 'The skin mesh is coarse (edges of about 12–17 mm on the forearm and chest), so the dent is drawn on a layer subdivided to about 1.5 mm (or half a cell) round the site; the skin triangles and subcutaneous fat it covers are drawn inward for display. With a see-through skin the layer is not drawn and the dent falls on the original vertices only, looking shallower and wider. The numbers are the solver\'s. The spring-back after release is a display transition; the tissue\'s creep recovery is not simulated.' },
  { zh: '疼痛模型收到的是算出的平均接触压强（力 ÷ 接触面积），不再是名义上 1 cm² 探头的压强；阈值和增益仍是疼痛模型自己的（多为假设）。', en: 'The pain model receives the computed mean contact pressure (force ÷ contact area) instead of the nominal pressure of a 1 cm² probe; its thresholds and gains are still the pain model\'s own (mostly assumptions).' },
]

export const POSTURE_CAVEATS: Statement[] = [
  { zh: '体位下的重力下垂没有与实测数据对照过，是模型的推算。站立时皮肤落在发布网格 0.3 mm 以内（这一点验证过）；换体位只是转动重力，骨架不动，没有肌张力。', en: 'Gravity sag in a posture has not been compared with measured data; it is the model\'s extrapolation. Standing, the skin lands within 0.3 mm of the shipped mesh (that much is validated); a change of posture only turns gravity, the skeleton stays put, and there is no muscle tone.' },
  { zh: '卧位的支撑面过皮肤在重力方向上最低的点，只接触它 5 cm 以内的皮肤；侧卧时静止姿势的手臂最先碰到它。', en: 'The support plane of a lying posture passes through the skin\'s lowest point along gravity and touches the skin within 5 cm of it only; lying on a side, the arm of the rest pose touches it first.' },
  { zh: '乳房没有验证：俯卧到仰卧的位移在体模上从 6 到 170 mm 都有，边缘有压坏的单元。', en: 'The breast is not validated: the prone-to-supine displacement on the phantom ranges from 6 to 170 mm, with crushed elements at its rim.' },
  { zh: '全身笼子的单元是 27 mm，比皮下脂肪和细小的骨都粗；分开的体表之间没有碰撞。', en: 'The whole-body cage has 27 mm cells, coarser than subcutaneous fat and slender bones; separated skin surfaces do not collide.' },
]

/** 女性：没有跑过 / The female: not run. */
export const FEMALE_UNAVAILABLE: Statement = {
  zh: '女性人体还没有跑过软组织物理（笼子、平衡和按压都没有验证），所以这里关闭。',
  en: 'The soft-tissue physics has not been run on the female body (its cage, equilibrium and pressing are all unvalidated), so it is off here.',
}

/** 放进注意事项的一条短说明 / The short note that goes into the cautions. */
export const SOFT_CAUTION: Statement = {
  zh: '软组织物理（按压、体位）：只有男性前臂的按压在给定范围内与文献对照过；体位的重力下垂没有与实测对照；乳房没有验证；女性没有跑过。',
  en: 'Soft-tissue physics (press, posture): only pressing on the male forearm has been compared with the literature, within the stated range; posture sag has not been compared with measurements; the breast is not validated; the female has not been run.',
}

/** 力控停在哪里、为什么 / Where force control stopped and why. */
export function stopText(r: Pick<PressSummary, 'stoppedBy' | 'gate' | 'depthMm' | 'forceN' | 'target' | 'tissueThicknessMm'>): Statement | null {
  if (r.stoppedBy === 'strain-gate') {
    const why = r.gate === 'strain' ? { zh: '轴线压应变超过 0.6', en: 'axial compressive strain passed 0.6' } : r.gate === 'force-drop' ? { zh: '加深时力反而掉了三成', en: 'the force fell by 30 % while going deeper' } : { zh: '求解不是有限数', en: 'the solve was not finite' }
    return {
      zh: `压溃闸让它停在了 ${fmt(r.depthMm)} mm（${why.zh}）：只到 ${fmt(r.forceN, 3)} N，没有达到要求的 ${'forceN' in r.target ? fmt(r.target.forceN) : '—'} N。疼痛模型收到的是这里的压强。`,
      en: `The crush gate stopped it at ${fmt(r.depthMm)} mm (${why.en}): only ${fmt(r.forceN, 3)} N, short of the ${'forceN' in r.target ? fmt(r.target.forceN) : '—'} N asked for. The pain model receives the pressure reached here.`,
    }
  }
  if (r.stoppedBy === 'tissue-thickness') return { zh: `已压到组织厚度（${fmt(r.tissueThicknessMm ?? 0)} mm）的 85%，没有达到要求的力。`, en: `It reached 85 % of the tissue thickness (${fmt(r.tissueThicknessMm ?? 0)} mm) without reaching the requested force.` }
  return null
}

