// 构建后从产物里删掉的目录（vite.config.ts 用；单独放一个文件，测试不必载入 vite 的配置）。
// The directories removed from the build output afterwards (used by vite.config.ts; kept in a file of its own so that the tests
// need not load the vite configuration).

/**
 * 开发用的数据集（示例数据、压力测试）只给开发服务器和测试用，不进正式构建的产物。
 * Dev-only datasets (the fixture and the stress set) are for the dev server and the tests; they are kept out of the production
 * build output.
 */
export const DEV_DATASETS = ['fixture', 'stress']

/**
 * 相对 dist 的目录。商业构建（SOMA_COMMERCIAL=1）另外去掉 voice/vivae-pain（VIVAE，CC BY-NC 4.0）；voice/ 下其余的包
 * （tts-demo：Apache-2.0 模型的输出；librispeech-demo：CC BY 4.0）允许商用，保留。tests/voice-librispeech.test.ts 核对这一点。
 * Directories relative to dist. A commercial build (SOMA_COMMERCIAL=1) also drops voice/vivae-pain (VIVAE, CC BY-NC 4.0); the
 * other packs under voice/ (tts-demo: output of Apache-2.0 models; librispeech-demo: CC BY 4.0) allow commercial use and stay.
 * tests/voice-librispeech.test.ts checks this.
 */
export function buildRemovals(commercial: boolean): string[] {
  return [...DEV_DATASETS.map((name) => `anatomy/${name}`), ...(commercial ? ['voice/vivae-pain'] : [])]
}
