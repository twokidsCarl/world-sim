// 右侧面板：没选人时是场景、主角与此刻的动静；选了人就是这个人的心智与经历。
import { useMemo } from 'react'
import type { Person } from '../contract/types.gen.ts'
import {
  AWARE, BELIEF, EXPECT, FEAR, STATUS, STATUS_NAMES, clockText, personLog, value, type RunData, type SimEvent,
} from '../state/derive.ts' // prettier-ignore
import { useApp } from '../state/store.ts'
import { Lab } from './Lab.tsx'

const EDUCATION = ['不识字', '读过蒙学', '中学', '读过大学']
const TIE: Record<string, string> = { kin: '家人', neighbor: '邻居', colleague: '同事', friend: '朋友' }
const DEPTH = [
  'TA只看眼前：亲眼见到几个人去取钱，就当有几个人会取。',
  'TA会多想一步：跟TA说这事的人多半是信的，信的人迟早会去取。',
  'TA想的是别人怎么想：人人都在猜别人会不会取，猜的人多了，钱庄没事也会被取空。',
]

const ta = (p: Person) => (p.sex === 'f' ? '她' : '他')

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
            {key === 'city' ? '观察' : '实验台'}
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
        <h2>{m.title}</h2>
        <p className="persona" style={{ marginTop: 8 }}>
          {m.setting}
        </p>
        {run.population.synthetic && (
          <p className="small muted" style={{ marginTop: 8 }}>
            {run.population.note}
          </p>
        )}
      </section>

      <section>
        <h3>主角</h3>
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
              <span className="small muted num">{st === AWARE ? `信 ${pct}%` : STATUS_NAMES[st]}</span>
            </button>
          )
        })}
      </section>

      <section>
        <h3>城里的动静</h3>
        <div className="log">
          {recent.length === 0 && <p className="muted small">夜还静着。按「播放」，看一句话怎么走遍全城。</p>}
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
  const district = run.population.districts[p.district]!.name

  return (
    <>
      <button className="back" onClick={() => useApp.getState().select(null)}>
        ← 全城
      </button>
      <section className="stack">
        <h2>
          {p.name}
          {p.role && <span className="role" style={{ fontSize: 13, marginLeft: 10, color: 'var(--ink-2)' }}>{p.role}</span>}
        </h2>
        {p.persona && <p className="persona">{p.persona}</p>}
        <div className="chips">
          <span className="chip">
            {p.age} 岁 · {p.sex === 'f' ? '女' : '男'}
          </span>
          <span className="chip">{EDUCATION[p.education]}</span>
          <span className="chip">住{district}</span>
          <span className="chip">{p.deposit > 0 ? `在通和存了 ${p.deposit} 元` : '在通和没有存款'}</span>
        </div>
      </section>

      <section className="stack">
        <h3>此刻 · {STATUS_NAMES[st]}</h3>
        <Meter label="信钱庄要倒" v={belief} belief />
        <Meter label="心里的怕" v={fear} />
        <Meter label="估计会去取的人" v={expect} />
        <BeliefSpark run={run} i={p.idx} k={k} />
        <p className="depth">{DEPTH[p.depth]!.replaceAll('TA', ta(p))}</p>
      </section>

      <section className="stack">
        <h3>这个人</h3>
        <Meter label="信人" v={p.trust_general} />
        <Meter label="信官面文章" v={p.trust_institution} />
        <Meter label="怕吃亏" v={p.risk_aversion} />
        <Meter label="随大流" v={p.conformity} />
        <Meter label="读报听讯" v={p.media_use} />
        {p.deposit > 0 && <Meter label="这笔钱多要紧" v={p.stake} />}
      </section>

      <section>
        <h3>经历</h3>
        <div className="log">
          {shown.length === 0 && <p className="muted small">到这一刻为止，这件事还没找上{ta(p)}。</p>}
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

/** 这个人的信念从头到尾怎么走，竖线是此刻 */
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
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="对谣言的相信程度随时间的变化">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke="var(--rumor)" strokeWidth={2} strokeLinejoin="round" />
      <line x1={(k / ticks) * W} x2={(k / ticks) * W} y1={0} y2={H} stroke="var(--ink)" strokeWidth={1.2} />
    </svg>
  )
}

function Entry({ run, e, self }: { run: RunData; e: SimEvent; self: number | null }) {
  const me = self == null ? '他' : ta(run.population.persons[self]!)
  const name = (i: number | null | undefined) => (i == null ? '有人' : i === self ? me : run.population.persons[i]!.name)
  const msg = e.m != null ? run.messages[e.m] : undefined
  const via = e.via?.startsWith('venue:') ? `在${run.population.venues[Number(e.via.slice(6))]!.name}` : e.via ? `${TIE[e.via]}` : ''
  const pick = (i: number | null | undefined) => (i != null && i !== self ? () => useApp.getState().select(i) : undefined)
  const who = (i: number | null | undefined) =>
    pick(i) ? (
      <a role="button" tabIndex={0} onClick={pick(i)} style={{ textDecoration: 'underline', cursor: 'pointer' }}>
        {name(i)}
      </a>
    ) : (
      name(i)
    )
  const tag = msg && <span className={`tag ${msg.valence === 1 ? 'rumor' : 'rebut'}`}>{msg.valence === 1 ? '谣言' : '辟谣'}</span>

  let body: React.ReactNode
  switch (e.k) {
    case 'thought':
      body = (
        <span className="thought">
          {self == null && <b>{name(e.a)}：</b>}
          {String(e.x)}
        </span>
      )
      break
    case 'tell':
      body =
        e.b === self ? (
          <span>
            {tag}
            {who(e.a)}
            {via && <span className="muted">（{via}）</span>}说：<q>{msg?.text}</q>
            <span className="muted num">
              {' '}
              信 {e.p0}% → {e.p1}%
            </span>
          </span>
        ) : (
          <span className="muted">
            {me}把话传给了{who(e.b)}
            {via && `（${via}）`}
          </span>
        )
      break
    case 'mutate':
      body = (
        <span>
          {tag}
          {who(e.a)}把话说成了：<q>{msg?.text}</q>
        </span>
      )
      break
    case 'seed':
      body = <span>{tag}{me}亲眼看见了。</span>
      break
    case 'queue':
      body = <span>{me}去钱庄门口排队了。</span>
      break
    case 'withdraw':
      body = <span>{me}取出了 {String(e.x)} 元。</span>
      break
    case 'verify':
      body = (
        <span>
          {me}自己去柜上看了。
          <span className="muted num">
            {' '}
            信 {e.p0}% → {e.p1}%
          </span>
        </span>
      )
      break
    case 'broadcast':
      body = (
        <span>
          {tag}
          <q>{msg?.text}</q>
          <span className="muted">（{Math.round(Number(e.x) * 100)}% 的人看到了）</span>
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
      body = <b>通和钱庄兑不出银子，关门了。还有 {String(e.x)} 元存款没取出来。</b>
      break
  }
  return (
    <div className="entry">
      <span className="when num">{clockText(run, e.t).replace('天 ', '天')}</span>
      {body}
    </div>
  )
}
