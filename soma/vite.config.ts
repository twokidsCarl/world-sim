import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// 开发用的数据集（示例数据、压力测试）只给开发服务器和测试用，不进正式构建的产物。
// Dev-only datasets (the fixture and the stress set) are for the dev server and the tests; they
// are kept out of the production build output.
const DEV_DATASETS = ['fixture', 'stress']

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
    },
  }
}

export default defineConfig({
  plugins: [react(), excludeDevDatasets()],
  server: { port: 5183, strictPort: true },
  test: { include: ['tests/**/*.test.ts'] },
})
