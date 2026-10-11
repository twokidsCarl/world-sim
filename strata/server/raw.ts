// 让 Bun 认识 Vite 的 `?raw` 导入：把着色器文件当作一段文本。
// Teach Bun about Vite's `?raw` imports: a shader file is loaded as a string.
import { plugin } from 'bun'

plugin({
  name: 'raw-text',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: new URL(args.path.replace(/\?raw$/, ''), `file://${args.importer}`).pathname,
      namespace: 'raw',
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
      exports: { default: await Bun.file(args.path).text() },
      loader: 'object',
    }))
  },
})
