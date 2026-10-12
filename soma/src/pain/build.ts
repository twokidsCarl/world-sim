// 构建开关：这次构建是否带有录音包（VIVAE，CC BY-NC 4.0，仅限非商业使用）。
// 用 `SOMA_COMMERCIAL=1 bunx vite build` 构建时不带：产物里没有 voice/，界面改用参数合成的声音，也不显示录音的署名。
// Build switch: whether this build ships the recorded sound pack (VIVAE, CC BY-NC 4.0, non-commercial
// only). A build made with `SOMA_COMMERCIAL=1 bunx vite build` does not: dist has no voice/, the app
// uses the parametric voice, and the recordings' attribution is not shown.

declare const __SOMA_VOICE_PACK__: boolean | undefined

/** 由 vite.config.ts 的 define 注入；没有注入时（例如直接跑测试）按带录音包处理。 Injected by `define` in vite.config.ts; treated as present when not injected (e.g. in tests). */
export const VOICE_PACK: boolean = typeof __SOMA_VOICE_PACK__ === 'undefined' ? true : __SOMA_VOICE_PACK__
