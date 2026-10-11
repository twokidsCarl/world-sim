// 不用浏览器跑一次模拟：给底座、参数、步数、种子，用 CPU 参考实现（f64）推进，
// 返回各层的派生量。和界面走的是同一套底座、同一套派生量定义，只是没有 GPU、没有画面。
// 同样的输入得到同样的输出。
// Run a simulation without a browser: given a substrate, parameters, a step count and a
// seed, advance the CPU reference implementation (f64) and return the derived quantities
// of every level. It goes through the same substrates and quantity definitions as the UI,
// only without a GPU or a picture. The same input gives the same output.

import { defaults, type Knob, type Params } from '../core/params'
import { agreement, isCurve, isField, type Curve, type QuantityDef, type Value } from '../core/quantity'
import type { Frame, Substrate } from '../core/substrate'
import { SUBSTRATES } from '../substrates'
import { MAX_SAMPLES, MAX_SEED, MAX_STAGES, RUN_LIMITS, combinedLimit } from './limits'

/**
 * 请求有错：message 说哪个字段、允许什么值（中文 / 英文），hint 给一个能跑的例子。
 * A bad request: the message names the field and the allowed values (Chinese / English)
 * and the hint gives an example that runs.
 */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    readonly status = 422,
  ) {
    super(message)
  }
}

export interface RunHooks {
  /** 墙上时间的预算（毫秒）；超过就报错而不是给出半截结果。 / Wall-clock budget in ms; exceeding it is an error, never a partial result. */
  budgetMs?: number
  /** 每推进一小段后调用，让服务有机会处理别的请求。 / Called after each short stretch, so a server can attend to other requests. */
  pause?: () => Promise<void>
  now?: () => number
}

export interface Stage {
  from_step: number
  steps: number
  params: Params
}

export interface RunResult {
  substrate: string
  backend: 'cpu'
  seed: number
  step_unit: string
  steps: number
  time: number
  params: Params
  stages: Stage[]
  /** 每个采样点上的标量：series[id][k] 是 series.step[k] 时的瞬时值。 / Scalars at each sample: series[id][k] is the instantaneous value at series.step[k]. */
  series: Record<string, (number | null)[]>
  /** 最后一个阶段后半段的平均。 / Averages over the second half of the last stage. */
  summary: Record<string, { mean: number | null; last: number | null; theory?: number | null; agreement?: 'agree' | 'differ'; theory_voided?: string }>
  curves: Record<string, { x: (number | null)[]; y: (number | null)[]; theory?: (number | null)[]; x_label?: string; agreement?: 'agree' | 'differ' }>
  averaged_over: { samples: number; from_step: number }
  /** 没有给出的量和原因。 / Quantities left out, and why. */
  skipped: { id: string; reason: string }[]
  overflow: boolean
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null)
const list = (a: ArrayLike<number>): (number | null)[] => Array.from(a, finite)

export function substrateOf(id: string): Substrate<Frame> {
  const s = SUBSTRATES.find((x) => x.id === id)
  if (!s) {
    throw new RequestError(
      `没有底座 ${id}；可以用的是 ${SUBSTRATES.map((x) => x.id).join('、')} / unknown substrate ${id}; available: ${SUBSTRATES.map((x) => x.id).join(', ')}`,
      'POST /api/run/md, /api/run/ising, /api/run/potts, /api/run/gravity or /api/run/mesh',
      404,
    )
  }
  return s
}

/** 这个旋钮在 CPU 上允许的最大值。 / The largest value this knob may take on the CPU. */
export const knobMax = (substrate: string, k: Knob): number => Math.min(k.max, RUN_LIMITS[substrate]!.max[k.id] ?? k.max)

/** 对外的旋钮：除了“计算后端”（这里永远是 CPU）。 / The knobs offered: all but the compute backend, which is always the CPU here. */
export const offeredKnobs = (s: Substrate<Frame>): Knob[] => s.knobs.filter((k) => k.id !== 'backend')

/** 对外的量：标量和曲线；场太大，不给。 / The quantities offered: scalars and curves; fields are too large. */
export const offeredQuantities = (s: Substrate<Frame>): QuantityDef<Frame>[] => s.quantities.filter((q) => q.kind !== 'field')

function hint(substrate: string): string {
  return `A working example: POST /api/run/${substrate} ${JSON.stringify(RUN_LIMITS[substrate]!.example)}`
}

function integer(substrate: string, field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new RequestError(`${field} 要是 ${min} 到 ${max} 之间的整数，收到的是 ${JSON.stringify(value)} / ${field} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`, hint(substrate))
  }
  return value
}

function object(substrate: string, field: string, value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestError(`${field} 要是一个 JSON 对象 / ${field} must be a JSON object`, hint(substrate))
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RequestError(`${field} 里没有 ${key} 这个字段；可以用的是 ${allowed.join('、')} / ${field} has no field ${key}; allowed: ${allowed.join(', ')}`, hint(substrate))
    }
  }
  return value as Record<string, unknown>
}

/** 校验一组旋钮取值；knobs 是这一处允许改的旋钮。 / Validate a set of knob values; `knobs` are the ones that may be set here. */
function knobValues(s: Substrate<Frame>, field: string, value: unknown, knobs: Knob[]): Params {
  const raw = object(s.id, field, value, knobs.map((k) => k.id))
  const out: Params = {}
  for (const k of knobs) {
    const v = raw[k.id]
    if (v === undefined) continue
    const max = knobMax(s.id, k)
    const where = `${field}.${k.id}`
    if (k.options) {
      const allowed = k.options.map((o) => o.value).filter((o) => o <= max)
      if (typeof v !== 'number' || !allowed.includes(v)) {
        throw new RequestError(`${where}（${k.label}）要是 ${allowed.join('、')} 之一，收到的是 ${JSON.stringify(v)} / ${where} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`, hint(s.id))
      }
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < k.min || v > max) {
      throw new RequestError(`${where}（${k.label}）要在 ${k.min} 到 ${max} 之间，收到的是 ${JSON.stringify(v)} / ${where} must be between ${k.min} and ${max}, got ${JSON.stringify(v)}`, hint(s.id))
    }
    out[k.id] = v
  }
  return out
}

interface Plan {
  seed: number
  samples: number
  quantities: QuantityDef<Frame>[]
  stages: { params: Params; steps: number }[]
  skipped: { id: string; reason: string }[]
}

/** 校验请求并把它整理成各阶段的完整参数。 / Validate a request and turn it into the full parameters of each stage. */
export function plan(s: Substrate<Frame>, request: unknown): Plan {
  const limits = RUN_LIMITS[s.id]!
  const req = object(s.id, '(the request)', request, ['params', 'steps', 'seed', 'samples', 'quantities', 'then'])
  const knobs = offeredKnobs(s)
  const first: Params = { ...defaults(s.knobs), ...knobValues(s, 'params', req.params ?? {}, knobs), backend: 0 }
  const stages = [{ params: first, steps: integer(s.id, 'steps', req.steps, 1, limits.steps) }]

  const live = knobs.filter((k) => k.rebuild !== 'state')
  if (req.then !== undefined) {
    if (!Array.isArray(req.then) || req.then.length > MAX_STAGES) {
      throw new RequestError(`then 要是一个数组，最多 ${MAX_STAGES} 项 / then must be an array of at most ${MAX_STAGES} items`, hint(s.id))
    }
    req.then.forEach((item, i) => {
      const stage = object(s.id, `then[${i}]`, item, ['params', 'steps'])
      // 后面的阶段只能改不需要重建状态的旋钮：重建就是另一次模拟了。
      // Later stages may only change knobs that do not rebuild the state: a rebuild would be a different run.
      for (const key of Object.keys((stage.params ?? {}) as object)) {
        if (knobs.some((k) => k.id === key) && !live.some((k) => k.id === key)) {
          throw new RequestError(
            `then[${i}].params.${key} 会重建整个状态，不能中途改；中途可以改的是 ${live.map((k) => k.id).join('、')} / then[${i}].params.${key} rebuilds the whole state and cannot change mid-run; changeable mid-run: ${live.map((k) => k.id).join(', ')}`,
            hint(s.id),
          )
        }
      }
      const previous = stages[stages.length - 1]!.params
      stages.push({ params: { ...previous, ...knobValues(s, `then[${i}].params`, stage.params ?? {}, live) }, steps: integer(s.id, `then[${i}].steps`, stage.steps, 1, limits.steps) })
    })
  }
  const total = stages.reduce((sum, st) => sum + st.steps, 0)
  if (total > limits.steps) {
    throw new RequestError(`各阶段合计 ${total} 步，超过了上限 ${limits.steps} / the stages add up to ${total} steps, above the limit of ${limits.steps}`, hint(s.id))
  }
  const broken = combinedLimit(s.id, first)
  if (broken) throw new RequestError(`${broken[0]}：${broken[1]} / ${broken[0]}: ${broken[2]}`, hint(s.id))

  const offered = offeredQuantities(s)
  let wanted = offered
  if (req.quantities !== undefined) {
    const names = offered.map((q) => q.id)
    if (!Array.isArray(req.quantities) || req.quantities.some((id) => typeof id !== 'string' || !names.includes(id))) {
      throw new RequestError(`quantities 要是下面这些名字组成的数组：${names.join('、')} / quantities must be an array of these names: ${names.join(', ')}`, hint(s.id))
    }
    wanted = offered.filter((q) => (req.quantities as string[]).includes(q.id))
  }
  // 有些量只在特定参数下才有（比如没有壁面就没有流速剖面）。按最后一个阶段的参数判断。
  // Some quantities exist only for certain parameters (no velocity profile without walls, say). Judged on the last stage's parameters.
  const last = stages[stages.length - 1]!.params
  const skipped = wanted
    .filter((q) => q.when && !q.when(last))
    .map((q) => ({ id: q.id, reason: `在这组参数下没有这个量（${q.label}） / not defined for these parameters` }))
  return {
    seed: req.seed === undefined ? 1 : integer(s.id, 'seed', req.seed, 0, MAX_SEED),
    samples: req.samples === undefined ? 20 : integer(s.id, 'samples', req.samples, 1, MAX_SAMPLES),
    quantities: wanted.filter((q) => !q.when || q.when(last)),
    stages,
    skipped,
  }
}

export async function runHeadless(substrateId: string, request: unknown, hooks: RunHooks = {}): Promise<RunResult> {
  const s = substrateOf(substrateId)
  const { seed, samples, quantities, stages, skipped } = plan(s, request)
  const now = hooks.now ?? (() => performance.now())
  const started = now()
  const reducers = [...new Set(quantities.flatMap((q) => q.reducers))]
  const total = stages.reduce((sum, st) => sum + st.steps, 0)
  const every = Math.max(1, Math.ceil(total / samples))

  const backend = s.create(stages[0]!.params, seed, null)
  try {
    const series: RunResult['series'] = { step: [], time: [] }
    const scalars = quantities.filter((q) => q.kind === 'scalar')
    const curveDefs = quantities.filter((q) => q.kind === 'curve')
    for (const q of scalars) series[q.id] = []
    // 最后一个阶段的采样：[步数, 各标量, 各曲线]。 / Samples of the last stage: [step, scalars, curves].
    let tail: { step: number; values: Map<string, Value>; theory: Map<string, Value | null> }[] = []
    let overflow = false
    let done = 0
    // 每次连续推进的步数：从小开始，按实测调到每段约 20 毫秒，好让服务不被占死。
    // 分段不影响结果：推进 a 步再推进 b 步，与一次推进 a + b 步相同。
    // Steps advanced in one go: starts small and is tuned to about 20 ms per stretch so a server
    // stays responsive. Splitting does not change the result: a steps then b equals a + b at once.
    let stretch = 1

    const advance = async (n: number): Promise<void> => {
      let left = n
      while (left > 0) {
        const m = Math.min(left, stretch)
        const t0 = now()
        backend.step(m)
        const elapsed = now() - t0
        left -= m
        done += m
        if (elapsed < 10) stretch = Math.min(stretch * 2, 4096)
        else if (elapsed > 40) stretch = Math.max(1, stretch >> 1)
        const spent = now() - started
        if (hooks.budgetMs !== undefined && spent > hooks.budgetMs) {
          const fits = Math.floor((done * hooks.budgetMs) / spent / 100) * 100
          throw new RequestError(
            `算了 ${Math.round(spent / 1000)} 秒只推进了 ${done} / ${total} 步，超过了时间预算。这组参数在这台机器上大约能跑 ${fits} 步；请减少步数，或者减小体系（粒子数、晶格边长、截断半径） / ran out of time after ${done} of ${total} steps in ${Math.round(spent / 1000)} s. These parameters manage about ${fits} steps here; ask for fewer steps or a smaller system (particle count, lattice side, cutoff radius)`,
            hint(s.id),
          )
        }
        await hooks.pause?.()
      }
    }

    const sample = async (params: Params, lastStage: boolean): Promise<void> => {
      const frame = await backend.reduce(reducers)
      overflow ||= Boolean(frame.overflow)
      series.step!.push(frame.step)
      // 模拟时间是逐段累加出来的，末位会随分段方式不同；取十二位有效数字，结果才与机器快慢无关。
      // Simulated time is accumulated stretch by stretch, so its last bits depend on the splitting;
      // twelve significant digits make the result independent of how fast the machine is.
      series.time!.push(finite(Number((frame.time ?? frame.step).toPrecision(12))))
      const values = new Map<string, Value>()
      const theory = new Map<string, Value | null>()
      for (const q of quantities) {
        const value = q.compute(frame, params)
        if (isField(value)) continue
        values.set(q.id, value)
        theory.set(q.id, q.voided?.(params) ? null : (q.theory?.(frame, params) ?? null))
        if (typeof value === 'number') series[q.id]!.push(finite(value))
      }
      if (lastStage) tail.push({ step: frame.step, values, theory })
    }

    const out: Stage[] = []
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!
      if (i > 0) backend.setParams(stage.params)
      out.push({ from_step: done, steps: stage.steps, params: stage.params })
      const end = done + stage.steps
      const lastStage = i === stages.length - 1
      while (done < end) {
        // 采样点落在全程的等间隔处，另外每个阶段的末尾一定采一次。
        // Samples fall at even intervals over the whole run, and the end of every stage is always sampled.
        const next = Math.min(end, (Math.floor(done / every) + 1) * every)
        await advance(next - done)
        await sample(stage.params, lastStage)
      }
    }

    // 只对最后一个阶段的后半段取平均：前半段留给系统适应新参数。
    // Average over the second half of the last stage only: the first half is left for the system to adapt.
    const finalStage = out[out.length - 1]!
    const cut = finalStage.from_step + finalStage.steps / 2
    const kept = tail.filter((t) => t.step >= cut)
    tail = kept.length > 0 ? kept : tail.slice(-1)
    const lastParams = finalStage.params
    const summary: RunResult['summary'] = {}
    for (const q of scalars) {
      const values = tail.map((t) => t.values.get(q.id) as number).filter(Number.isFinite)
      const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null
      const lastValue = tail[tail.length - 1]!.values.get(q.id) as number
      const entry: RunResult['summary'][string] = { mean, last: finite(lastValue) }
      const voided = q.voided?.(lastParams)
      // 理论值也在同一段上取平均：有的理论随时间变（比如增长模的幅度），拿平均值去对最后一刻的理论是不公平的。
      // The theory is averaged over the same stretch: some theories change in time (the amplitude of a
      // growing mode, say), and comparing a mean with the theory at the last instant would be unfair.
      const theories = tail.map((t) => t.theory.get(q.id)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (voided) entry.theory_voided = voided
      else if (theories.length > 0) {
        const th = theories.reduce((a, b) => a + b, 0) / theories.length
        entry.theory = th
        const verdict = mean === null || theories.length !== values.length ? 'none' : agreement(q as never, mean, th)
        if (verdict !== 'none') entry.agreement = verdict
      }
      summary[q.id] = entry
    }
    const curves: RunResult['curves'] = {}
    for (const q of curveDefs) {
      const samplesOf = tail.map((t) => t.values.get(q.id) ?? null).filter(isCurve)
      const latest = samplesOf[samplesOf.length - 1]
      if (!latest) continue
      // 长度会变的曲线（比如聚集数分布）只取与最后一条等长的那些来平均。
      // For curves whose length can change (the aggregate-size distribution, say) only those as long as the last are averaged.
      const same = samplesOf.filter((c) => c.y.length === latest.y.length)
      const y = new Float64Array(latest.y.length)
      for (const c of same) for (let k = 0; k < y.length; k++) y[k]! += c.y[k]! / same.length
      const entry: RunResult['curves'][string] = { x: list(latest.x), y: list(y) }
      if (q.xLabel) entry.x_label = q.xLabel
      const theories = tail.map((t) => t.theory.get(q.id) ?? null).filter((c): c is Curve => isCurve(c) && c.y.length === y.length)
      if (theories.length > 0 && !q.voided?.(lastParams)) {
        const th = new Float64Array(y.length)
        for (const c of theories) for (let k = 0; k < th.length; k++) th[k]! += c.y[k]! / theories.length
        entry.theory = list(th)
        const verdict = agreement(q as never, { x: latest.x, y }, { x: latest.x, y: th })
        if (verdict !== 'none') entry.agreement = verdict
      }
      curves[q.id] = entry
    }

    return {
      substrate: s.id,
      backend: 'cpu',
      seed,
      step_unit: s.stepLabel,
      // 后端自己数的步数。Ising 的“有效信息”每采样一次要多推进一次扫描，所以它可以比请求的多几步。
      // The backend's own count. Ising's effective information advances one extra sweep per sample, so
      // this can exceed the request by a few.
      steps: series.step![series.step!.length - 1]!,
      time: series.time![series.time!.length - 1] ?? 0,
      params: lastParams,
      stages: out,
      series,
      summary,
      curves,
      averaged_over: { samples: tail.length, from_step: tail[0]!.step },
      skipped,
      overflow,
    }
  } finally {
    backend.dispose()
  }
}
