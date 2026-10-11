// 文献页：模拟的依据（理论、案例、事实）和校准结果。每条出处都标明是否核实过。
// Library page: what the simulation rests on (theory, cases, facts) and the calibration results. Every source is marked as verified or not.
import { useEffect, useState } from 'react'
import type { Case, Fact, Source, Theory } from '../contract/types.gen.ts'
import { getLang, loc, tr } from '../state/lang.ts'

type Checked<T> = T & { verified: boolean }
type En = Record<string, unknown>
/** 语料条目里某个字段的英文；没有就退回中文 / The English of one field of a corpus entry, falling back to the Chinese */
const en = (e: { en?: En }, key: string, zh: string): string => loc(zh, e.en?.[key] as string | undefined)
/** 列表字段的第 i 项 / Item i of a list field */
const enAt = (e: { en?: En }, key: string, i: number, zh: string): string => loc(zh, (e.en?.[key] as string[] | undefined)?.[i])
interface Corpus {
  theory: Checked<Theory>[]
  cases: Checked<Case>[]
  facts: Checked<Fact>[]
}
interface Calibration {
  note: string
  note_en?: string
  targets: { metric: string; source: string; lo: number; hi: number; why: string; why_en?: string }[]
  default: { metrics: Record<string, number> }
  calibrated: { metrics: Record<string, number>; params: Record<string, number> }
}

const KIND: Record<string, [string, string]> = { drama: ['戏剧', 'Drama'], novel: ['小说', 'Novel'], idiom: ['典故', 'Idiom'], history: ['史实', 'History'] }
const SECTIONS = [
  { key: 'calibration', name: ['校准', 'Calibration'] },
  { key: 'theory', name: ['理论', 'Theory'] },
  { key: 'cases', name: ['案例', 'Cases'] },
  { key: 'facts', name: ['事实', 'Facts'] },
] as const

export function Library({ onClose }: { onClose: () => void }) {
  const [corpus, setCorpus] = useState<Corpus | null>(null)
  const [cal, setCal] = useState<Calibration | null>(null)
  const [error, setError] = useState('')
  const [section, setSection] = useState<(typeof SECTIONS)[number]['key']>('calibration')

  useEffect(() => {
    Promise.all([fetch('/api/corpus').then((r) => r.json()), fetch('/api/calibration').then((r) => r.json())])
      .then(([c, k]) => {
        setCorpus(c as Corpus)
        setCal(k as Calibration | null)
      })
      .catch((e) => setError(tr('读不到语料：', 'Could not load the corpus: ') + String(e)))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const names = new Map((corpus?.theory ?? []).map((t) => [t.id, loc(t.title, t.title_en)]))

  return (
    <div className="library" role="dialog" aria-label={tr('文献与校准', 'Literature and calibration')}>
      <header>
        <h2>{tr('依据', 'Evidence')}</h2>
        <nav className="tabs" role="tablist">
          {SECTIONS.map((s) => (
            <button key={s.key} role="tab" aria-selected={section === s.key} onClick={() => setSection(s.key)}>
              {tr(s.name[0], s.name[1])}
              {corpus && s.key !== 'calibration' && <span className="count num">{corpus[s.key].length}</span>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button onClick={onClose}>{tr('回到舞台', 'Back to the stage')}</button>
      </header>
      <div className="library-body">
        {error && <p className="error">{error}</p>}
        {!corpus && !error && <p className="muted">{tr('正在读取…', 'Loading…')}</p>}
        {corpus && section === 'calibration' && <CalibrationView cal={cal} />}
        {corpus && section === 'theory' && (
          <div className="cards">
            {corpus.theory.map((t) => (
              <article className="card" key={t.id}>
                <Head title={loc(t.title, t.title_en)} sub={getLang() === 'en' ? en(t, 'field', t.field) : `${t.title_en} · ${t.field}`} verified={t.verified} />
                <p>{en(t, 'claim', t.claim)}</p>
                {t.formal && <p className="formal">{en(t, 'formal', t.formal)}</p>}
                <h4>{tr('如果成立，应当看到', 'If it holds, we should see')}</h4>
                <ul>
                  {t.predicts.map((p, i) => (
                    <li key={i}>{enAt(t, 'predicts', i, p)}</li>
                  ))}
                </ul>
                <h4>{tr('在引擎里', 'In the engine')}</h4>
                <p className={t.in_engine ? '' : 'muted'}>{t.in_engine ? en(t, 'in_engine', t.in_engine) : tr('尚未实现。', 'Not implemented yet.')}</p>
                <Sources sources={t.sources} entry={t} />
              </article>
            ))}
          </div>
        )}
        {corpus && section === 'cases' && (
          <div className="cards">
            {corpus.cases.map((c) => (
              <article className="card" key={c.id}>
                <Head title={en(c, 'title', c.title)} sub={`${tr(...KIND[c.kind]!)} · ${en(c, 'setting', c.setting)}`} verified={c.verified} />
                <p>{en(c, 'summary', c.summary)}</p>
                <h4>{tr('人物', 'People')}</h4>
                <ul>
                  {c.people.map((p, i) => {
                    const q = getLang() === 'en' ? ((c.en?.people as typeof c.people | undefined)?.[i] ?? p) : p
                    return (
                      <li key={p.name}>
                        <b>{q.name}</b>
                        {tr('，', ', ')}
                        {q.role}
                        {q.traits && <span className="muted">{tr('——', ' — ')}{q.traits}</span>}
                      </li>
                    )
                  })}
                </ul>
                <h4>{tr('依次发生了什么', 'What happened, in order')}</h4>
                <ol>
                  {c.events.map((e, i) => (
                    <li key={i}>{enAt(c, 'events', i, e.what)}</li>
                  ))}
                </ol>
                <h4>{tr('结局', 'Outcome')}</h4>
                <p>{en(c, 'outcome', c.outcome)}</p>
                <Refs ids={c.theories} names={names} />
                <Sources sources={c.sources} entry={c} />
              </article>
            ))}
          </div>
        )}
        {corpus && section === 'facts' && (
          <div className="cards">
            {corpus.facts.map((f) => (
              <article className="card" key={f.id}>
                <Head title={en(f, 'title', f.title)} sub={f.metric ? tr('已接入校准：', 'Used in calibration: ') + f.metric : tr('尚未接入校准', 'Not used in calibration yet')} verified={f.verified} />
                <p>{en(f, 'statement', f.statement)}</p>
                {(f.value != null || f.range) && (
                  <p className="figure num">
                    {f.value != null && <b>{f.value}</b>}
                    {f.range && <span>{f.value != null ? ' · ' : ''}{tr('范围', 'range')} {f.range[0]} – {f.range[1]}</span>}
                    <span className="muted small"> {en(f, 'unit', f.unit ?? '')}</span>
                  </p>
                )}
                <h4>{tr('得出条件', 'Conditions')}</h4>
                <p>{en(f, 'conditions', f.conditions)}</p>
                {f.caveats && (
                  <>
                    <h4>{tr('要当心的地方', 'Caveats')}</h4>
                    <p>{en(f, 'caveats', f.caveats)}</p>
                  </>
                )}
                <Refs ids={f.theories ?? []} names={names} />
                <Sources sources={f.sources} entry={f} />
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Head({ title, sub, verified }: { title: string; sub: string; verified: boolean }) {
  return (
    <header className="card-head">
      <h3>{title}</h3>
      <span className={verified ? 'badge ok' : 'badge'}>{verified ? tr('出处已核实', 'Sources verified') : tr('有出处未核实', 'Some sources unverified')}</span>
      <p className="small muted">{sub}</p>
    </header>
  )
}

function Refs({ ids, names }: { ids: string[]; names: Map<string, string> }) {
  if (ids.length === 0) return null
  return (
    <div className="chips">
      {ids.map((id) => (
        <span className="chip" key={id}>
          {names.get(id) ?? id}
        </span>
      ))}
    </div>
  )
}

function Sources({ sources, entry }: { sources: Source[]; entry: { en?: En } }) {
  return (
    <details className="sources">
      <summary>{tr(`出处 ${sources.length} 条`, `${sources.length} source${sources.length === 1 ? '' : 's'}`)}</summary>
      {sources.map((s, i) => (
        <div className="source" key={i}>
          <p>
            {s.verified ? '✓' : '？'} {s.author}
            {s.year ? tr(`（${s.year}）`, ` (${s.year})`) : ''}{tr('：', ': ')}
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.work}
              </a>
            ) : (
              s.work
            )}
            {s.locator && <span className="muted">{tr('，', ', ')}{s.locator}</span>}
          </p>
          {s.checked && <p className="small muted">{enAt(entry, 'checked', i, s.checked)}</p>}
        </div>
      ))}
    </details>
  )
}

function CalibrationView({ cal }: { cal: Calibration | null }) {
  if (!cal) return <p className="muted">{tr('还没有校准结果。在 polis/ 下执行 uv run polis calibrate --save。', 'No calibration yet. Run `uv run polis calibrate --save` in polis/.')}</p>
  const inside = (v: number, t: { lo: number; hi: number }) => v >= t.lo && v <= t.hi
  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3).replace(/\.?0+$/, ''))
  return (
    <div className="calibration">
      <p className="persona">
        {tr('把语料里能算出来的事实变成指标，看模拟落在不在范围里。左边是手调的默认参数，右边是搜索之后的参数。', 'Facts in the corpus that can be computed are turned into metrics, and the simulation is checked against their ranges. Hand-tuned defaults on the left, parameters after the search on the right.')}
      </p>
      <table className="compare">
        <thead>
          <tr>
            <th>{tr('要对上的事实', 'Fact to match')}</th>
            <th>{tr('目标范围', 'Target range')}</th>
            <th>{tr('默认参数', 'Defaults')}</th>
            <th>{tr('校准后', 'Calibrated')}</th>
            <th>{tr('出处', 'Source')}</th>
          </tr>
        </thead>
        <tbody>
          {cal.targets.map((t) => {
            const a = cal.default.metrics[t.metric]!
            const b = cal.calibrated.metrics[t.metric]!
            return (
              <tr key={t.metric}>
                <td>{loc(t.why, t.why_en)}</td>
                <td className="num">{t.lo === t.hi ? fmt(t.lo) : `${fmt(t.lo)} – ${fmt(t.hi)}`}</td>
                <td className="num">
                  {fmt(a)} <span className={inside(a, t) ? 'hit' : 'missed'}>{inside(a, t) ? tr('在范围内', 'in range') : tr('偏离', 'off')}</span>
                </td>
                <td className="num">
                  {fmt(b)} <span className={inside(b, t) ? 'hit' : 'missed'}>{inside(b, t) ? tr('在范围内', 'in range') : tr('偏离', 'off')}</span>
                </td>
                <td className="small muted">{t.source}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h4>{tr('校准后的参数', 'Calibrated parameters')}</h4>
      <div className="chips">
        {Object.entries(cal.calibrated.params).map(([k, v]) => (
          <span className="chip num" key={k}>
            {k} = {v}
          </span>
        ))}
      </div>
      <p className="depth" style={{ marginTop: 16 }}>
        {loc(cal.note, cal.note_en)}{tr('这里的“校准后”只说明存在一组与这几条事实不矛盾的参数，不等于模型被验证过。', ' “Calibrated” here means only that a parameter set exists which does not contradict these few facts; it does not mean the model has been validated.')}
      </p>
    </div>
  )
}
