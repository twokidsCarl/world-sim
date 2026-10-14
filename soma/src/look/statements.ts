// 写实外观在界面上必须明说的事。注意事项对话框、"显示"页的提示和 README 都用这里的话。
// What the UI must say plainly about the lifelike look. The cautions dialog, the Display-tab hint and the README use
// the wording here.

export interface Statement {
  zh: string
  en: string
}

/** 写实外观藏起皮肤下面的部件；大姿势下的穿出是真实的几何缺陷 / The lifelike look hides the parts under the skin; poke-through in large poses is a real geometry defect. */
export const LOOK_HIDES_INTERNAL: Statement = {
  zh: '写实外观只画皮肤和它外面的东西：不透明皮肤下面的部件不画（选中的、在刺激通路上的、单独隔离的、透过眼和口的开口看到的除外，它们仍在结构树和搜索里）。大幅度姿势（如肩外展 90°、160°）时肌肉和皮下脂肪会从腋窝、胸和肩部的皮肤穿出来，这是几何的真实缺陷，写实视图把它藏住了；关掉写实外观（look=0）仍然能看到。',
  en: 'The lifelike look draws only the skin and what lies outside it: parts under the opaque skin are not drawn (except those selected, on the stimulus pathway, isolated, or seen through the eye and mouth openings; they all stay in the tree and search). In large poses (such as 90° or 160° of shoulder abduction) muscle and subcutaneous fat poke through the skin at the axilla, chest and shoulder; this is a real geometry defect, which the lifelike view hides and which is still visible with the lifelike look off (look=0).',
}

/** "显示"页写实外观开关下的短提示 / The short hint under the lifelike switch on the Display tab. */
export const LOOK_HIDES_HINT: Statement = {
  zh: '写实外观不画皮肤下面的部件；大姿势时肌肉和脂肪从皮肤穿出是几何缺陷，关掉写实外观可以看到。',
  en: 'The lifelike look does not draw the parts under the skin; muscle and fat poking through the skin in large poses is a geometry defect, visible with the lifelike look off.',
}
