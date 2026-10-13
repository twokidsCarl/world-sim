import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 开发用的数据集（示例数据、压力测试）只给开发服务器和测试用，不进正式构建的产物。
// Dev-only datasets (the fixture and the stress set) are for the dev server and the tests; they
// are kept out of the production build output.
const DEV_DATASETS = ['fixture', 'stress']

// 录音包（public/voice/vivae-pain/，VIVAE，CC BY-NC 4.0）只许非商业使用。商业部署用
//   SOMA_COMMERCIAL=1 bunx vite build
// 构建：产物里不带 voice/vivae-pain/（voice/ 下其余目录许可允许商用，照常保留），界面改用参数合成的声音，并且不显示录音的署名。默认构建不变。
// The recorded sound pack (public/voice/vivae-pain/, VIVAE, CC BY-NC 4.0) is for non-commercial use only. For a
// commercial deployment build with
//   SOMA_COMMERCIAL=1 bunx vite build
// which leaves voice/vivae-pain/ out of dist (the other directories under voice/ allow commercial use and stay), makes the app use the parametric voice and hides the recordings'
// attribution. The default build is unchanged.
const COMMERCIAL = /^(1|true|yes)$/i.test(process.env.SOMA_COMMERCIAL ?? '')

function excludeDevDatasets(): Plugin {
  let outDir = 'dist'
  return {
    name: 'soma-exclude-dev-datasets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      for (const name of DEV_DATASETS) await rm(resolve(outDir, 'anatomy', name), { recursive: true, force: true })
      if (COMMERCIAL) await rm(resolve(outDir, 'voice', 'vivae-pain'), { recursive: true, force: true })
    },
  }
}

// 开发时把 /api 转给本机的语音合成后端（soma/server）：端口从环境变量 SOMA_API_PORT 来，不写死；没设就不转，
// 界面按"没有后端"工作。正式使用时由统一入口（idea-loom）在同源下转发 /api。
// In development /api is proxied to the local speech-synthesis backend (soma/server): the port comes from the environment
// variable SOMA_API_PORT and is not hard-coded; when it is unset nothing is proxied and the UI works as "no backend". In hosted
// use the single entry point (idea-loom) proxies /api under the same origin.
const API_PORT = Number(process.env.SOMA_API_PORT)
const apiProxy = Number.isInteger(API_PORT) && API_PORT > 0 && API_PORT < 65536 ? { '/api': { target: `http://127.0.0.1:${API_PORT}` } } : undefined

export default defineConfig({
  plugins: [react(), excludeDevDatasets()],
  define: { __SOMA_VOICE_PACK__: JSON.stringify(!COMMERCIAL) },
  server: { port: 5183, strictPort: true, proxy: apiProxy },
  // 这些测试读入几十兆的真实几何，44 个文件并行跑时，慢机器上单项会超过默认的 5 秒。
  // The tests read tens of megabytes of real geometry; with 44 files in parallel a single test can exceed the default 5 s on a slow machine.
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 300_000 },
})
