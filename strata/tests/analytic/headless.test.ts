import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUN_LIMITS } from '../../src/headless/limits'
import { RequestError, knobMax, offeredKnobs, plan, runHeadless, substrateOf } from '../../src/headless/run'
import { API, capabilities } from '../../src/headless/schema'
import { SUBSTRATES } from '../../src/substrates'
import { onsagerEnergy, onsagerMagnetisation } from '../../src/theory/onsager'

const sim = JSON.parse(readFileSync(new URL('../../sim.json', import.meta.url).pathname, 'utf8')) as {
  api: unknown
  agent: { capabilities: { id: string; example: unknown; input: { properties: { params: { properties: Record<string, { maximum?: number; enum?: number[] }> } } } }[] }
}

// 每个底座一个小而快的请求。 / One small, quick request per substrate.
const SMALL: Record<string, Record<string, unknown>> = {
  md: { params: { nx: 20, thermostat: 1 }, steps: 300, samples: 6, seed: 3 },
  ising: { params: { L: 6, T: 2.4 }, steps: 300, samples: 6, seed: 3 },
  potts: { params: { L: 6, q: 5 }, steps: 300, samples: 6, seed: 3 },
  gravity: { params: { n: 10 }, steps: 40, samples: 4, seed: 3 },
  mesh: { params: { side: 4, grid: 5 }, steps: 20, samples: 4, seed: 3 },
}

async function failure(substrate: string, request: unknown): Promise<RequestError> {
  try {
    await runHeadless(substrate, request)
  } catch (error) {
    if (error instanceof RequestError) return error
    throw error
  }
  throw new Error('the request was accepted')
}

describe('running without a browser', () => {
  it('sim.json carries the api and capabilities the source generates (run `bun run agent` to refresh)', () => {
    expect(sim.api).toEqual(API)
    expect(sim.agent.capabilities).toEqual(JSON.parse(JSON.stringify(capabilities())))
  })

  it('every declared example is accepted, and the declared bounds are the ones enforced', () => {
    for (const s of SUBSTRATES) {
      const cap = sim.agent.capabilities.find((c) => c.id === `run_${s.id}`)!
      expect(cap.example).toEqual(RUN_LIMITS[s.id]!.example)
      expect(() => plan(substrateOf(s.id), cap.example)).not.toThrow()
      for (const k of offeredKnobs(s)) {
        const declared = cap.input.properties.params.properties[k.id]!
        expect(declared.maximum ?? Math.max(...declared.enum!), `${s.id}.${k.id}`).toBe(k.options ? Math.max(...k.options.map((o) => o.value).filter((v) => v <= knobMax(s.id, k))) : knobMax(s.id, k))
      }
    }
  })

  for (const s of SUBSTRATES) {
    it(`${s.id}: the same request gives the same result, however the steps are split up`, async () => {
      const first = await runHeadless(s.id, SMALL[s.id])
      // 假时钟让每一段都“很慢”，于是每次只推进一步；结果必须逐位相同。
      // A fake clock makes every stretch look slow, so it advances one step at a time; the result must be bit-identical.
      let t = 0
      const second = await runHeadless(s.id, SMALL[s.id], { now: () => (t += 50), pause: async () => {} })
      expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      // Ising 的“有效信息”每采样一次多推进一次扫描；不要它时步数与请求的相同。
      // Ising's effective information advances one extra sweep per sample; without it the count is as requested.
      const requested = SMALL[s.id]!.steps as number
      expect(first.steps).toBe(s.id === 'ising' ? requested + first.series.step!.length : requested)
      expect(first.series.step!.at(-1)).toBe(first.steps)
      if (s.id === 'ising') expect((await runHeadless('ising', { ...SMALL.ising, quantities: ['magnetisation'] })).steps).toBe(requested)
      expect(Object.keys(first.summary).length).toBeGreaterThan(0)
      for (const [id, entry] of Object.entries(first.summary)) expect(entry.last === null || Number.isFinite(entry.last), id).toBe(true)
      // 换一个种子，结果不同。 / Another seed gives a different result.
      const other = await runHeadless(s.id, { ...SMALL[s.id], seed: 4 })
      expect(JSON.stringify(other.series)).not.toBe(JSON.stringify(first.series))
    })
  }

  it('an Ising lattice below Tc reaches the Onsager magnetisation and energy', async () => {
    const r = await runHeadless('ising', RUN_LIMITS.ising!.example)
    expect(r.summary.magnetisation!.mean).toBeCloseTo(onsagerMagnetisation(2.1), 1)
    expect(Math.abs(r.summary.energy!.mean! - onsagerEnergy(2.1))).toBeLessThan(0.02)
    expect(r.summary.magnetisation!.agreement).toBe('agree')
    expect(r.summary.energy!.agreement).toBe('agree')
  })

  it('a later stage changes knobs mid-run: a thermostatted fluid follows the bath to a new temperature', async () => {
    const r = await runHeadless('md', {
      params: { nx: 20, density: 0.5, temperature: 1.5, thermostat: 1 },
      steps: 600,
      samples: 12,
      quantities: ['temperature'],
      then: [{ params: { temperature: 0.8 }, steps: 1200 }],
    })
    expect(r.stages.map((st) => [st.from_step, st.steps])).toEqual([[0, 600], [600, 1200]])
    const at = (step: number) => r.series.temperature![r.series.step!.indexOf(step)]!
    expect(at(600)).toBeGreaterThan(1.2)
    expect(Math.abs(r.summary.temperature!.mean! - 0.8)).toBeLessThan(0.08)
    expect(r.averaged_over.from_step).toBeGreaterThanOrEqual(1200)
    expect(r.params.temperature).toBe(0.8)
  })

  it('quantities that do not exist for the parameters are listed as skipped, and fields are never offered', async () => {
    const r = await runHeadless('md', { params: { nx: 20 }, steps: 20, samples: 1 })
    expect(r.skipped.map((x) => x.id)).toContain('flowProfile')
    expect(Object.keys(r.summary)).not.toContain('flowProfile')
    expect((await failure('md', { steps: 5, quantities: ['densityField'] })).message).toContain('quantities')
  })

  it('a bad request says which field is wrong and what is allowed', async () => {
    const cases: [string, unknown, string][] = [
      ['md', { steps: 10, params: { nx: 400 } }, 'params.nx must be between 20 and 70'],
      ['md', { steps: 10, params: { dim: 3, nx: 40 } }, 'nx may be at most 32'],
      ['md', { steps: 10, paramz: {} }, 'no field paramz; allowed: params, steps, seed, samples, quantities, then'],
      ['md', {}, 'steps must be an integer from 1 to 20000'],
      ['md', { steps: 10, params: { temperature: '1' } }, 'params.temperature must be between 0.05 and 3'],
      ['ising', { steps: 10, params: { L: 9 } }, 'params.L must be one of 6, 7, 8'],
      ['ising', { steps: 10, params: { backend: 1 } }, 'no field backend'],
      ['md', { steps: 10, then: [{ params: { density: 0.5 }, steps: 5 }] }, 'then[0].params.density rebuilds the whole state'],
      ['md', { steps: 15000, then: [{ params: {}, steps: 15000 }] }, 'above the limit of 20000'],
      ['potts', { steps: 10, seed: -1 }, 'seed must be an integer from 0 to 2147483647'],
      ['potts', [1], 'must be a JSON object'],
    ]
    for (const [substrate, request, text] of cases) {
      const error = await failure(substrate, request)
      expect(error.message, JSON.stringify(request)).toContain(text)
      expect(error.status).toBe(422)
      expect(error.hint).toContain(`POST /api/run/${substrate}`)
    }
    expect((await failure('nope', { steps: 1 })).status).toBe(404)
  })

  it('running past the time budget is an error that says how many steps fit, never a partial result', async () => {
    let t = 0
    const error = await (async () => {
      try {
        await runHeadless('ising', { params: { L: 6 }, steps: 5000 }, { budgetMs: 1000, now: () => (t += 200) })
      } catch (e) {
        return e as RequestError
      }
      throw new Error('finished')
    })()
    expect(error).toBeInstanceOf(RequestError)
    expect(error.message).toMatch(/ran out of time after \d+ of 5000 steps/)
    expect(error.message).toMatch(/manage about \d+ steps/)
  })
})
