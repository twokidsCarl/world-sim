/**
 * Calls the local Claude Code CLI (`claude -p`) for structured answers.
 * No API key and no SDK: the user's own login is used. The call runs in an
 * empty temporary directory with no tools, or with read-only file access
 * when images are attached so the model can look at them.
 */
import { stateDir } from './structures'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class LLMError extends Error {}

export interface AskOptions {
  system: string
  prompt: string
  /** JSON Schema of the answer; `required` keys are checked */
  schema: Record<string, unknown>
  /** files placed next to the prompt for the model to read, e.g. render.png */
  images?: { name: string; data: Uint8Array }[]
  model?: string
  timeoutMs?: number
  cache?: boolean
}

const bin = () => process.env.LIMN_CLAUDE_BIN || 'claude'
const defaultModel = () => process.env.LIMN_MODEL || 'sonnet'
// 模型回答的缓存放在状态目录下 / the cache of model answers lives under the state directory
const cacheDir = () => join(stateDir(), 'llm')

export function buildArgv(o: AskOptions): string[] {
  const look = (o.images?.length ?? 0) > 0
  const argv = [
    bin(), '-p',
    '--output-format', 'json',
    '--model', o.model ?? defaultModel(),
    '--tools', look ? 'Read' : '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--system-prompt', o.system,
    '--json-schema', JSON.stringify(o.schema),
  ]
  if (look) argv.push('--allowedTools', 'Read')
  return argv
}

/** Pull the answer out of `claude -p --output-format json`. */
export function parseOutput(stdout: string, schema: Record<string, unknown>): Record<string, unknown> {
  let data: any
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new LLMError(`claude 的输出不是 JSON / claude did not return JSON: ${stdout.slice(0, 200)}`)
  }
  // Some versions print the event list; the answer is the last "result" event.
  if (Array.isArray(data)) data = data.filter((x: any) => x && x.type === 'result').pop()
  if (!data || typeof data !== 'object') throw new LLMError('claude 的输出里没有结果 / claude returned no result')
  if (data.is_error) throw new LLMError(`claude 报错 / claude reported an error: ${String(data.result ?? data.subtype).slice(0, 300)}`)
  let out = data.structured_output
  if (!out || typeof out !== 'object') out = extractJson(typeof data.result === 'string' ? data.result : '')
  if (!out || typeof out !== 'object' || Array.isArray(out)) throw new LLMError('claude 没有按要求的结构回答 / claude did not answer in the required structure')
  const missing = ((schema.required as string[] | undefined) ?? []).filter((k) => !(k in out))
  if (missing.length) throw new LLMError(`回答缺少字段 / the answer lacks fields: ${missing.join(', ')}`)
  return out
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  for (const c of [fenced?.[1], text]) {
    if (!c) continue
    try {
      return JSON.parse(c)
    } catch {}
  }
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {}
  }
  return null
}

export async function available(): Promise<boolean> {
  try {
    const p = Bun.spawn([bin(), '--version'], { stdout: 'ignore', stderr: 'ignore' })
    return (await p.exited) === 0
  } catch {
    return false
  }
}

export async function ask<T = Record<string, unknown>>(o: AskOptions): Promise<T> {
  const key = createHash('sha256')
  key.update(JSON.stringify([o.model ?? defaultModel(), o.system, o.prompt, o.schema]))
  for (const im of o.images ?? []) key.update(im.name).update(im.data)
  const file = join(cacheDir(), key.digest('hex').slice(0, 32) + '.json')
  if (o.cache !== false) {
    try {
      return JSON.parse(await readFile(file, 'utf8')).value as T
    } catch {}
  }

  const cwd = await mkdtemp(join(tmpdir(), 'limn-llm-'))
  try {
    for (const im of o.images ?? []) await writeFile(join(cwd, im.name), im.data)
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = parseOutput(await run(buildArgv(o), o.prompt, cwd, o.timeoutMs ?? 180_000), o.schema) as T
        if (o.cache !== false) {
          await mkdir(cacheDir(), { recursive: true })
          await writeFile(file + '.tmp', JSON.stringify({ value }))
          await rename(file + '.tmp', file)
        }
        return value
      } catch (e) {
        last = e
      }
    }
    throw last
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function run(argv: string[], prompt: string, cwd: string, timeoutMs: number): Promise<string> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(argv, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  } catch (e) {
    throw new LLMError(`无法启动 claude / could not start claude: ${e instanceof Error ? e.message : e}`)
  }
  proc.stdin.write(prompt)
  proc.stdin.end()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (timedOut) throw new LLMError(`claude 超过 ${Math.round(timeoutMs / 1000)} 秒没有回答 / claude did not answer within ${Math.round(timeoutMs / 1000)} seconds`)
  if (code !== 0 && !stdout.trim()) throw new LLMError(`claude 退出码 ${code} / claude exited with code ${code}: ${stderr.slice(0, 300)}`)
  return stdout
}
