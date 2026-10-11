// 每个底座一个对外的计算；输入的 JSON Schema 由旋钮表和 CPU 上的界限生成，
// 所以它和 run.ts 里的校验说的是同一件事。写进 sim.json 的 agent.capabilities。
// One offered computation per substrate; its input JSON Schema is generated from the knob
// table and the CPU bounds, so it says the same thing as the validation in run.ts. Written
// into agent.capabilities in sim.json.

import type { Knob } from '../core/params'
import type { Frame, Substrate } from '../core/substrate'
import { ENGLISH } from '../agent/english'
import { SUBSTRATES } from '../substrates'
import { MAX_SAMPLES, MAX_SEED, MAX_STAGES, MD_3D_MAX_NX, RUN_LIMITS } from './limits'
import { knobMax, offeredKnobs, offeredQuantities } from './run'

/** 声明给 hub 的大致耗时（秒）；服务自己的时间预算与它相同。 / Rough time declared to the hub, in seconds; the server's own budget is the same. */
export const RUN_SECONDS = 30

type Json = Record<string, unknown>

function knobSchema(s: Substrate<Frame>, k: Knob): Json {
  const [labelEn, optionsEn] = ENGLISH[s.id]!.knobs[k.id]!
  const max = knobMax(s.id, k)
  const whole = Number.isInteger(k.step) && Number.isInteger(k.min)
  let description = `${k.label} / ${labelEn}`
  if (k.options) {
    const shown = k.options.map((o, i) => ({ ...o, en: optionsEn![i]! })).filter((o) => o.value <= max)
    description += `：${shown.map((o) => `${o.value} = ${o.label} / ${o.en}`).join('；')}`
    return { type: 'integer', enum: shown.map((o) => o.value), default: Math.min(k.default, max), description }
  }
  if (s.id === 'md' && k.id === 'nx') description += `（dim = 3 时最多 ${MD_3D_MAX_NX} / at most ${MD_3D_MAX_NX} when dim = 3）`
  return { type: whole ? 'integer' : 'number', minimum: k.min, maximum: max, default: Math.min(k.default, max), description }
}

function knobsSchema(s: Substrate<Frame>, knobs: Knob[], description: string): Json {
  return { type: 'object', additionalProperties: false, description, properties: Object.fromEntries(knobs.map((k) => [k.id, knobSchema(s, k)])) }
}

export function inputSchema(s: Substrate<Frame>): Json {
  const limits = RUN_LIMITS[s.id]!
  const knobs = offeredKnobs(s)
  const live = knobs.filter((k) => k.rebuild !== 'state')
  const steps = (zh: string, en: string): Json => ({ type: 'integer', minimum: 1, maximum: limits.steps, description: `${zh} / ${en}` })
  const unit = ENGLISH[s.id]!.step
  return {
    type: 'object',
    required: ['steps'],
    additionalProperties: false,
    properties: {
      params: knobsSchema(s, knobs, '旋钮取值，没给的用默认值；每个旋钮的含义见 knobs 数据集 / knob values, defaults where omitted; the knobs dataset explains each'),
      steps: steps(`推进多少${s.stepLabel}（各阶段合计不超过 ${limits.steps}）`, `how many ${unit} to advance (all stages together at most ${limits.steps})`),
      seed: { type: 'integer', minimum: 0, maximum: MAX_SEED, default: 1, description: '随机种子；同样的输入和种子得到同样的输出 / random seed; the same input and seed give the same output' },
      samples: { type: 'integer', minimum: 1, maximum: MAX_SAMPLES, default: 20, description: '全程等间隔采样多少次 / how many evenly spaced samples to take over the run' },
      quantities: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: offeredQuantities(s).map((q) => q.id) },
        description: '要哪些量，不给就是全部；每个量的含义见 quantities 数据集 / which quantities to return, all when omitted; the quantities dataset explains each',
      },
      then: {
        type: 'array',
        maxItems: MAX_STAGES,
        description: '后续阶段：改几个旋钮再接着跑（比如降温）。只能改不重建状态的旋钮 / later stages: change some knobs and keep running (cooling, say). Only knobs that do not rebuild the state may change',
        items: {
          type: 'object',
          required: ['params', 'steps'],
          additionalProperties: false,
          properties: {
            params: knobsSchema(s, live, '这一阶段要改的旋钮 / the knobs this stage changes'),
            steps: steps(`这一阶段推进多少${s.stepLabel}`, `how many ${unit} this stage advances`),
          },
        },
      },
    },
  }
}

export function capability(s: Substrate<Frame>): Json {
  const e = ENGLISH[s.id]!
  const limits = RUN_LIMITS[s.id]!
  const sizes = Object.entries(limits.max)
    .map(([id, max]) => `${id} ≤ ${max}`)
    .join(', ')
  return {
    id: `run_${s.id}`,
    title: { zh: `跑一次：${s.label}`, en: `Run once: ${e.label}` },
    description: {
      zh: `不用浏览器，用 CPU 参考实现（双精度）跑一次“${s.label}”：给旋钮取值、步数和种子，返回各层的派生量。和界面用的是同一套规则和同一套派生量定义。CPU 比界面里的 GPU 慢得多，所以体系要小（${sizes}），最多 ${limits.steps} ${s.stepLabel}；超过约 ${RUN_SECONDS} 秒会报错并告诉你大约能跑多少步。不调用模型，不写文件。`,
      en: `Runs the substrate "${e.label}" once without a browser, on the CPU reference implementation (double precision): give knob values, a step count and a seed, and get the derived quantities of every level. The rules and the quantity definitions are the ones the UI uses. The CPU is far slower than the GPU behind the UI, so systems must be small (${sizes}) and at most ${limits.steps} ${e.step}; past about ${RUN_SECONDS} seconds it returns an error saying roughly how many steps fit. No model is called and nothing is written.`,
    },
    http: { method: 'POST', path: `/api/run/${s.id}` },
    input: inputSchema(s),
    output: {
      zh: '一个 JSON 对象：params（最后一个阶段的完整旋钮取值）、stages、series（step、time 和每个标量在各采样点的瞬时值）、summary（每个标量在最后一个阶段后半段的平均 mean、最后一个值 last，有理论时还有 theory 和是否相符 agreement）、curves（每条曲线在同一段上的平均 x、y，有理论时还有 theory）、averaged_over（平均用了几个采样、从哪一步起）、skipped（这组参数下没有的量）、overflow（为 true 表示邻居表满了，结果不可信）。场（密度场、流速场等）不返回。steps 是实际推进的步数：Ising 的 effectiveInformation 每采样一次会多推进一次扫描。',
      en: 'One JSON object: params (the full knob values of the last stage), stages, series (step, time and the instantaneous value of every scalar at each sample), summary (for every scalar the mean over the second half of the last stage, the last value, and where there is a theory, theory and agreement), curves (x and y of every curve averaged over the same stretch, plus theory where there is one), averaged_over (how many samples the averages used and from which step), skipped (quantities that do not exist for these parameters) and overflow (true means a neighbour table filled up and the result cannot be trusted). Fields (density, velocity and so on) are not returned. `steps` is the number actually advanced: effectiveInformation of the Ising model advances one extra sweep per sample.',
    },
    deterministic: true,
    seconds: RUN_SECONDS,
    example: limits.example,
  }
}

export const capabilities = (): Json[] => SUBSTRATES.map(capability)

export const API = {
  dir: '.',
  prepare: [['bun', 'install', '--frozen-lockfile']],
  run: ['bun', '--preload', './server/raw.ts', 'server/api.ts', '--port', '{port}'],
  health: '/api/health',
}
