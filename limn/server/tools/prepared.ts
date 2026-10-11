/**
 * 预处理结果的存放和排队：按一个键存一个文件，同一个键同时只做一次；做的过程比一次请求能等的时间长，
 * 所以另有一个“问一下”的入口，没做完就说还在准备。
 *
 * Where prepared results are kept and how the work is queued: one file per key, made only once at
 * a time. Making one takes longer than a request can wait, so there is also a way to just ask,
 * which says "still preparing" until it is done.
 */
import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../structures'

const pending = new Map<string, Promise<string>>()
const failed = new Map<string, string>()

/** 预处理过的文件的路径；没有就先做 / path of the prepared file, making it first if needed */
export function preparedFile(key: string, make: () => Promise<Uint8Array>): Promise<string> {
  const dir = join(stateDir(), 'prepared')
  const path = join(dir, createHash('sha256').update(key).digest('hex').slice(0, 32))
  const running = pending.get(path)
  if (running) return running
  const job = (async () => {
    if (await stat(path).then((s) => s.size > 0, () => false)) return path
    const data = await make()
    await mkdir(dir, { recursive: true })
    // 先写临时文件再改名，中途断掉不会留下半个文件 / write to a temporary file and rename, so an interruption leaves no partial file
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, path)
    return path
  })().finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}

/**
 * 不等它做完：已经有了就给路径，否则在后台开始做并说“还在准备”。上次失败的原因只报一次，之后再问会重新开始。
 * Without waiting: the path if the file is there, otherwise start the work in the background and
 * say it is still being prepared. A failure is reported once, and asking again starts over.
 */
export async function poll(key: string, make: () => Promise<Uint8Array>): Promise<{ path: string } | { preparing: true }> {
  const error = failed.get(key)
  if (error) {
    failed.delete(key)
    throw new Error(error)
  }
  const job = preparedFile(key, make)
  job.catch((e) => failed.set(key, e instanceof Error ? e.message : String(e)))
  const done = await Promise.race([job.then((path) => ({ path })).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))])
  return done ?? { preparing: true }
}
