// 右侧面板：没选人时是场景、主角与此刻的动静；选了人就是这个人的心智与经历。
// Side panel: with nobody selected it shows the scenario, the cast and what is happening right now; with a person selected it shows that person's mind and history.
import { useMemo } from 'react'
import type { Person } from '../contract/types.gen.ts'
import {
  AWARE, BELIEF, EXPECT, FEAR, STATUS, clockText, personLog, statusName, value, type RunData, type SimEvent,
} from '../state/derive.ts' // prettier-ignore
import { loc, tr } from '../state/lang.ts'
import { useApp } from '../state/store.ts'
import { Lab } from './Lab.tsx'

const EDUCATION: [string, string][] = [['不识字', 'No schooling'], ['读过蒙学', 'Elementary'], ['中学', 'Secondary'], ['读过大学', 'Higher']] // prettier-ignore
const TIE: Record<string, [string, string]> = { kin: ['家人', 'family'], neighbor: ['邻居', 'neighbour'], colleague: ['同事', 'colleague'], friend: ['朋友', 'friend'] } // prettier-ignore
const DEPTH: [string, string][] = [
  ['TA只看眼前：亲眼见到几个人去取钱，就当有几个人会取。', 'Looks only at what is in front of them: however many people they have seen withdraw is how many they expect to.'],
  ['TA会多想一步：跟TA说这事的人多半是信的，信的人迟早会去取。', 'Thinks one step further: whoever told them probably believes it, and believers will withdraw sooner or later.'],
  ['TA想的是别人怎么想：人人都在猜别人会不会取，猜的人多了，钱庄没事也会被取空。', 'Thinks about what others think: everyone is guessing whether everyone else will withdraw, and enough guessing empties even a sound bank.'],
]

const ta = (p: Person) => (p.sex === 'f' ? tr('她', 'she') : tr('他', 'he'))
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function Side() {
  const run = useApp((s) => s.run)
  const selected = useApp((s) => s.selected)
  const k = useApp((s) => Math.floor(s.t))
  const tab = useApp((s) => s.tab)
  if (!run) return <aside className="side" />
  return (
    <aside className="side">
      <nav className="tabs" role="tablist">
        {(['city', 'lab'] as const).map((key) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => useApp.getState().setTab(key)}>
            {key === 'city' ? tr('观察', 'Observe') : tr('实验台', 'Lab')}
          </button>
        ))}
      </nav>
      {tab === 'lab' ? (
        <Lab run={run} />
      ) : selected == null ? (
        <Overview run={run} k={k} />
      ) : (
        <PersonView run={run} k={k} person={run.population.persons[selected]!} />
      )}
    </aside>
  )
}

function beliefColor(pct: number): string {
  return `color-mix(in srgb, var(--b2) ${Math.min(100, pct * 1.4)}%, var(--b0))`
}

function Overview({ run, k }: { run: RunData; k: number }) {
  const m = run.manifest
  const recent = useMemo(() => {
    const out: SimEvent[] = []
    for (let i = run.tickStart[k + 1]! - 1; i >= 0 && out.length < 9; i--) {
      const e = run.events[i]!
      if (e.k === 'thought' || e.k === 'mutate' || e.k === 'broadcast' || e.k === 'intervene' || e.k === 'fail') out.push(e)
    }
    return out
  }, [run, k])

  return (
    <>
      <section>
        <h2>{loc(m.title, m.title_en)}</h2>
        <p className="persona" style={{ marginTop: 8 }}>
          {loc(m.setting, m.setting_en)}
        </p>
        {run.population.synthetic && (
          <p className="small muted" style={{ marginTop: 8 }}>
            {loc(run.population.note, run.population.note_en)}
          </p>
        )}
      </section>

      <section>
        <h3>{tr('主角', 'Cast')}</h3>
        {run.cast.map((p) => {
          const st = value(run, k, STATUS, p.idx)
          const pct = Math.round((value(run, k, BELIEF, p.idx) / 255) * 100)
          return (
            <button className="row" key={p.idx} onClick={() => useApp.getState().select(p.idx)}>
              <span className="swatch" style={{ background: beliefColor(pct) }} />
              <span>
                <span className="who">{p.name}</span>
                <span className="role">{p.role}</span>
              </span>
              <span className="small muted num">{st === AWARE ? tr(`信 ${pct}%`, `believes ${pct}%`) : statusName(st)}</span>
            </button>
          )
        })}
      </section>

      <section>
        <h3>{tr('城里的动静', 'What is stirring')}</h3>
        <div className="log">
          {recent.length === 0 && <p className="muted small">{tr('夜还静着。按「播放」，看一句话怎么走遍全城。', 'All quiet so far. Press Play and watch one remark cross the town.')}</p>}
          {recent.map((e, i) => (
            <Entry key={i} run={run} e={e} self={null} />
          ))}
        </div>
      </section>
    </>
  )
}

function PersonView({ run, k, person: p }: { run: RunData; k: number; person: Person }) {
  const log = useMemo(() => personLog(run, p.idx), [run, p.idx])
  const shown = useMemo(() => log.filter((e) => e.t <= k).reverse().slice(0, 80), [log, k]) // prettier-ignore
  const st = value(run, k, STATUS, p.idx)
  const belief = value(run, k, BELIEF, p.idx) / 255
  const fear = value(run, k, FEAR, p.idx) / 255
  const expect = value(run, k, EXPECT, p.idx) / 255
  const d = run.population.districts[p.district]!
  const district = loc(d.name, d.name_en)
  const b = run.population.venues[run.population.bank]!
  const bank = loc(b.name, b.name_en)

  return (
    <>
      <button className="back" onClick={() => useApp.getState().select(null)}>
        {tr('← 全城', '← The town')}
      </button>
      <section className="stack">
        <h2>
          {p.name}
          {p.role && <span className="role" style={{ fontSize: 13, marginLeft: 10, color: 'var(--ink-2)' }}>{p.role}</span>}
        </h2>
        {p.persona && <p className="persona">{p.persona}</p>}
        <div className="chips">
          <span className="chip">
            {tr(`${p.age} 岁 · ${p.sex === 'f' ? '女' : '男'}`, `${p.age} · ${p.sex === 'f' ? 'woman' : 'man'}`)}
          </span>
          <span className="chip">{tr(...EDUCATION[p.education]!)}</span>
          <span className="chip">{tr(`住${district}`, `Lives in ${district}`)}</span>
          <span className="chip">{p.deposit > 0 ? tr(`在${bank}存了 ${p.deposit} 元`, `${p.deposit} on deposit at ${bank}`) : tr(`在${bank}没有存款`, `No deposit at ${bank}`)}</span>
          {/* 旧记录里没有这三项 / records made before these fields existed lack them */}
          {p.deposit > 0 && p.tenure != null && <span className="chip">{tr(`往来 ${Math.round(p.tenure)} 年`, `${Math.round(p.tenure)} years with the bank`)}</span>}
          {p.borrower && <span className="chip">{tr('有贷款', 'Has a loan')}</span>}
          {p.deposit > 0 && (p.insured ?? 0) > 0 && <span className="chip">{(p.insured ?? 0) >= 1 ? tr('存款全额受保', 'Fully insured') : tr(`存款 ${Math.round((p.insured ?? 0) * 100)}% 受保`, `${Math.round((p.insured ?? 0) * 100)}% insured`)}</span>}
        </div>
      </section>

      <section className="stack">
        <h3>{tr('此刻', 'Now')} · {statusName(st)}</h3>
        <Meter label={tr('信钱庄要倒', 'Believes the bank will fail')} v={belief} belief />
        <Meter label={tr('心里的怕', 'Fear')} v={fear} />
        <Meter label={tr('估计会去取的人', 'Expects others to withdraw')} v={expect} />
        <BeliefSpark run={run} i={p.idx} k={k} />
        <p className="depth">{tr(DEPTH[p.depth]![0].replaceAll('TA', ta(p)), DEPTH[p.depth]![1])}</p>
      </section>

      <section className="stack">
        <h3>{tr('这个人', 'This person')}</h3>
        <Meter label={tr('信人', 'Trusts people')} v={p.trust_general} />
        <Meter label={tr('信官面文章', 'Trusts officialdom')} v={p.trust_institution} />
        <Meter label={tr('怕吃亏', 'Fears loss')} v={p.risk_aversion} />
        <Meter label={tr('随大流', 'Follows the crowd')} v={p.conformity} />
        <Meter label={tr('读报听讯', 'Follows the news')} v={p.media_use} />
        {p.deposit > 0 && <Meter label={tr('这笔钱多要紧', 'How much the money matters')} v={p.stake} />}
      </section>

      <section>
        <h3>{tr('经历', 'History')}</h3>
        <div className="log">
          {shown.length === 0 && <p className="muted small">{tr(`到这一刻为止，这件事还没找上${ta(p)}。`, 'So far none of this has reached them.')}</p>}
          {shown.map((e, i) => (
            <Entry key={i} run={run} e={e} self={p.idx} />
          ))}
        </div>
      </section>
    </>
  )
}

function Meter({ label, v, belief }: { label: string; v: number; belief?: boolean }) {
  return (
    <div className="meter">
      <span className="muted">{label}</span>
      <span className="track">
        <span className={belief ? 'fill belief' : 'fill'} style={{ display: 'block', width: `${Math.round(v * 100)}%` }} />
      </span>
      <span className="val num">{Math.round(v * 100)}%</span>
    </div>
  )
}

/**
 * 这个人的信念从头到尾怎么走，竖线是此刻
 * This person's belief over the whole run; the vertical line marks the current moment
 */
function BeliefSpark({ run, i, k }: { run: RunData; i: number; k: number }) {
  const ticks = run.manifest.ticks
  const W = 326
  const H = 44
  const d = useMemo(() => {
    let out = ''
    for (let t = 0; t <= ticks; t++) {
      out += `${t ? 'L' : 'M'}${((t / ticks) * W).toFixed(1)},${(H - 2 - (value(run, t, BELIEF, i) / 255) * (H - 4)).toFixed(1)}`
    }
    return out
  }, [run, i, ticks])
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={tr('对谣言的相信程度随时间的变化', 'Belief in the rumour over time')}>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke="var(--rumor)" strokeWidth={2} strokeLinejoin="round" />
      <line x1={(k / ticks) * W} x2={(k / ticks) * W} y1={0} y2={H} stroke="var(--ink)" strokeWidth={1.2} />
    </svg>
  )
}

function Entry({ run, e, self }: { run: RunData; e: SimEvent; self: number | null }) {
  const me = self == null ? tr('他', 'he') : ta(run.population.persons[self]!)
  const Me = cap(me)
  const name = (i: number | null | undefined) => (i == null ? tr('有人', 'someone') : i === self ? me : run.population.persons[i]!.name)
  const msg = e.m != null ? run.messages[e.m] : undefined
  const place = e.via?.startsWith('venue:') ? run.population.venues[Number(e.via.slice(6))]! : null
  const via = place ? tr(`在${place.name}`, `at ${loc(place.name, place.name_en)}`) : e.via && TIE[e.via] ? tr(...TIE[e.via]!) : ''
  const pick = (i: number | null | undefined) => (i != null && i !== self ? () => useApp.getState().select(i) : undefined)
  const who = (i: number | null | undefined) =>
    pick(i) ? (
      <a role="button" tabIndex={0} onClick={pick(i)} style={{ textDecoration: 'underline', cursor: 'pointer' }}>
        {name(i)}
      </a>
    ) : (
      name(i)
    )
  const tag = msg && <span className={`tag ${msg.valence === 1 ? 'rumor' : 'rebut'}`}>{msg.valence === 1 ? tr('谣言', 'Rumour') : tr('辟谣', 'Rebuttal')}</span>

  let body: React.ReactNode
  switch (e.k) {
    case 'thought':
      body = (
        <span className="thought">
          {self == null && <b>{name(e.a)}{tr('：', ': ')}</b>}
          {String(e.x)}
          {e.via === 'llm' && <span className="tag llm">{tr('模型所写', 'Written by the model')}</span>}
        </span>
      )
      break
    case 'tell':
      body =
        e.b === self ? (
          <span>
            {tag}
            {who(e.a)}
            {via && <span className="muted">{tr(`（${via}）`, ` (${via})`)}</span>}{tr('说：', ' said: ')}<q>{msg?.text}</q>
            <span className="muted num">
              {' '}
              {tr('信', 'belief')} {e.p0}% → {e.p1}%
            </span>
          </span>
        ) : (
          <span className="muted">
            {tr(`${me}把话传给了`, `${Me} passed it on to `)}{who(e.b)}
            {via && tr(`（${via}）`, ` (${via})`)}
          </span>
        )
      break
    case 'mutate':
      body = (
        <span>
          {tag}
          {who(e.a)}{tr('把话说成了：', ' turned it into: ')}<q>{msg?.text}</q>
        </span>
      )
      break
    case 'seed':
      body = <span>{tag}{tr(`${me}亲眼看见了。`, `${Me} saw it with their own eyes.`)}</span>
      break
    case 'queue':
      body = <span>{tr(`${me}去钱庄门口排队了。`, `${Me} joined the queue at the bank.`)}</span>
      break
    case 'withdraw':
      body = <span>{tr(`${me}取出了 ${String(e.x)} 元。`, `${Me} withdrew ${String(e.x)}.`)}</span>
      break
    case 'verify':
      body = (
        <span>
          {tr(`${me}自己去柜上看了。`, `${Me} went to the counter to see.`)}
          <span className="muted num">
            {' '}
            {tr('信', 'belief')} {e.p0}% → {e.p1}%
          </span>
        </span>
      )
      break
    case 'broadcast':
      body = (
        <span>
          {tag}
          <q>{msg?.text}</q>
          <span className="muted">{tr(`（${Math.round(Number(e.x) * 100)}% 的人看到了）`, ` (seen by ${Math.round(Number(e.x) * 100)}%)`)}</span>
        </span>
      )
      break
    case 'intervene':
      body = (
        <b>
          {e.a != null && (e.a === self ? me : run.population.persons[e.a]!.name)}
          {String(e.x)}
        </b>
      )
      break
    case 'fail':
      body = <b>{tr(`${run.population.venues[run.population.bank]!.name}付不出钱，关门了。还有 ${String(e.x)} 元存款没取出来。`, `The bank cannot pay and has shut. ${String(e.x)} in deposits was never withdrawn.`)}</b>
      break
  }
  return (
    <div className="entry">
      <span className="when num">{clockText(run, e.t).replace('天 ', '天')}</span>
      {body}
    </div>
  )
}
