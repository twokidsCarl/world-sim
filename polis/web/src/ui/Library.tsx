// 文献页：模拟的依据（理论、案例、事实）和校准结果。每条出处都标明是否核实过。
// Library page: what the simulation rests on (theory, cases, facts) and the calibration results. Every source is marked as verified or not.
import { useEffect, useState } from 'react'
import type { Case, Fact, Source, Theory } from '../contract/types.gen.ts'

type Checked<T> = T & { verified: boolean }
interface Corpus {
  theory: Checked<Theory>[]
  cases: Checked<Case>[]
  facts: Checked<Fact>[]
}
interface Calibration {
  note: string
  targets: { metric: string; source: string; lo: number; hi: number; why: string }[]
  default: { metrics: Record<string, number> }
  calibrated: { metrics: Record<string, number>; params: Record<string, number> }
}

const KIND: Record<string, string> = { drama: '戏剧', novel: '小说', idiom: '典故', history: '史实' }
const SECTIONS = [
  { key: 'calibration', name: '校准' },
  { key: 'theory', name: '理论' },
  { key: 'cases', name: '案例' },
  { key: 'facts', name: '事实' },
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
      .catch((e) => setError(`读不到语料：${String(e)}`))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const names = new Map((corpus?.theory ?? []).map((t) => [t.id, t.title]))

  return (
    <div className="library" role="dialog" aria-label="文献与校准">
      <header>
        <h2>依据</h2>
        <nav className="tabs" role="tablist">
          {SECTIONS.map((s) => (
            <button key={s.key} role="tab" aria-selected={section === s.key} onClick={() => setSection(s.key)}>
              {s.name}
              {corpus && s.key !== 'calibration' && <span className="count num">{corpus[s.key].length}</span>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button onClick={onClose}>回到舞台</button>
      </header>
      <div className="library-body">
        {error && <p className="error">{error}</p>}
        {!corpus && !error && <p className="muted">正在读取…</p>}
        {corpus && section === 'calibration' && <CalibrationView cal={cal} />}
        {corpus && section === 'theory' && (
          <div className="cards">
            {corpus.theory.map((t) => (
              <article className="card" key={t.id}>
                <Head title={t.title} sub={`${t.title_en} · ${t.field}`} verified={t.verified} />
                <p>{t.claim}</p>
                {t.formal && <p className="formal">{t.formal}</p>}
                <h4>如果成立，应当看到</h4>
                <ul>
                  {t.predicts.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
                <h4>在引擎里</h4>
                <p className={t.in_engine ? '' : 'muted'}>{t.in_engine || '尚未实现。'}</p>
                <Sources sources={t.sources} />
              </article>
            ))}
          </div>
        )}
        {corpus && section === 'cases' && (
          <div className="cards">
            {corpus.cases.map((c) => (
              <article className="card" key={c.id}>
                <Head title={c.title} sub={`${KIND[c.kind]} · ${c.setting}`} verified={c.verified} />
                <p>{c.summary}</p>
                <h4>人物</h4>
                <ul>
                  {c.people.map((p) => (
                    <li key={p.name}>
                      <b>{p.name}</b>，{p.role}
                      {p.traits && <span className="muted">——{p.traits}</span>}
                    </li>
                  ))}
                </ul>
                <h4>依次发生了什么</h4>
                <ol>
                  {c.events.map((e, i) => (
                    <li key={i}>{e.what}</li>
                  ))}
                </ol>
                <h4>结局</h4>
                <p>{c.outcome}</p>
                <Refs ids={c.theories} names={names} />
                <Sources sources={c.sources} />
              </article>
            ))}
          </div>
        )}
        {corpus && section === 'facts' && (
          <div className="cards">
            {corpus.facts.map((f) => (
              <article className="card" key={f.id}>
                <Head title={f.title} sub={f.metric ? `已接入校准：${f.metric}` : '尚未接入校准'} verified={f.verified} />
                <p>{f.statement}</p>
                {(f.value != null || f.range) && (
                  <p className="figure num">
                    {f.value != null && <b>{f.value}</b>}
                    {f.range && <span>{f.value != null ? ' · ' : ''}范围 {f.range[0]} – {f.range[1]}</span>}
                    <span className="muted small"> {f.unit}</span>
                  </p>
                )}
                <h4>得出条件</h4>
                <p>{f.conditions}</p>
                {f.caveats && (
                  <>
                    <h4>要当心的地方</h4>
                    <p>{f.caveats}</p>
                  </>
                )}
                <Refs ids={f.theories ?? []} names={names} />
                <Sources sources={f.sources} />
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
      <span className={verified ? 'badge ok' : 'badge'}>{verified ? '出处已核实' : '有出处未核实'}</span>
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

function Sources({ sources }: { sources: Source[] }) {
  return (
    <details className="sources">
      <summary>出处 {sources.length} 条</summary>
      {sources.map((s, i) => (
        <div className="source" key={i}>
          <p>
            {s.verified ? '✓' : '？'} {s.author}
            {s.year ? `（${s.year}）` : ''}：
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.work}
              </a>
            ) : (
              s.work
            )}
            {s.locator && <span className="muted">，{s.locator}</span>}
          </p>
          {s.checked && <p className="small muted">{s.checked}</p>}
        </div>
      ))}
    </details>
  )
}

function CalibrationView({ cal }: { cal: Calibration | null }) {
  if (!cal) return <p className="muted">还没有校准结果。在 polis/ 下执行 uv run polis calibrate --save。</p>
  const inside = (v: number, t: { lo: number; hi: number }) => v >= t.lo && v <= t.hi
  const fmt = (v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(3).replace(/\.?0+$/, ''))
  return (
    <div className="calibration">
      <p className="persona">
        把语料里能算出来的事实变成指标，看模拟落在不在范围里。左边是手调的默认参数，右边是搜索之后的参数。
      </p>
      <table className="compare">
        <thead>
          <tr>
            <th>要对上的事实</th>
            <th>目标范围</th>
            <th>默认参数</th>
            <th>校准后</th>
            <th>出处</th>
          </tr>
        </thead>
        <tbody>
          {cal.targets.map((t) => {
            const a = cal.default.metrics[t.metric]!
            const b = cal.calibrated.metrics[t.metric]!
            return (
              <tr key={t.metric}>
                <td>{t.why}</td>
                <td className="num">{t.lo === t.hi ? fmt(t.lo) : `${fmt(t.lo)} – ${fmt(t.hi)}`}</td>
                <td className="num">
                  {fmt(a)} <span className={inside(a, t) ? 'hit' : 'missed'}>{inside(a, t) ? '在范围内' : '偏离'}</span>
                </td>
                <td className="num">
                  {fmt(b)} <span className={inside(b, t) ? 'hit' : 'missed'}>{inside(b, t) ? '在范围内' : '偏离'}</span>
                </td>
                <td className="small muted">{t.source}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h4>校准后的参数</h4>
      <div className="chips">
        {Object.entries(cal.calibrated.params).map(([k, v]) => (
          <span className="chip num" key={k}>
            {k} = {v}
          </span>
        ))}
      </div>
      <p className="depth" style={{ marginTop: 16 }}>
        {cal.note}这里的“校准后”只说明存在一组与这几条事实不矛盾的参数，不等于模型被验证过。
      </p>
    </div>
  )
}
