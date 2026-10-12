// 刺激可视化的颜色（界面的图例和三维视图共用；单独成文件，界面不必为它引入 three.js）。
// Colours of the stimulus visuals (shared by the UI legend and the 3D view; a file of its own so the UI
// need not pull in three.js for it).

/** 疼痛分布层的三档、两种纤维的标记、通路 / the pain layer's three levels, the two fibre markers, the pathway */
export const PAIN_COLORS = { focus: '#ff3b30', territory: '#ffb020', dermatome: '#ffe27a', fast: '#7fe9ff', slow: '#ff8a3d', path: '#ff5a7a' } as const
