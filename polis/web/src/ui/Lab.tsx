// 实验台：在回放的此刻加一条干预，分叉重跑，和原来那条世界线对比；或者同一设定换种子看分布。
// Lab: add an intervention at the current replay moment, fork and re-run, and compare against the original world line; or keep the setup and vary the seed to see the distribution.
import { useState } from 'react'
import type { Intervention } from '../contract/types.gen.ts'
import { clockText, type RunData } from '../state/derive.ts'
import { useApp } from '../state/store.ts'

type Kind = 'notice' | 'guarantee' | 'rumor' | 'close_venue' | 'silence' | 'convince' | 'insurance'

const KINDS: { key: Kind; name: string; what: string }[] = [
  { key: 'notice', name: '掌柜贴告示', what: '钱庄自己出面否认。信的人不多。' },
  { key: 'guarantee', name: '官银号担保', what: '可信的一方公开担保，并把现银摆上柜台。' },
  { key: 'rumor', name: '再放一条谣言', what: '有人故意散布更重的说法。' },
  { key: 'close_venue', name: '关一处场所', what: '勒令一处人来人往的地方关门。' },
  { key: 'silence', name: '带走一个人', what: '让舞台上选中的人不再开口。' },
  { key: 'convince', name: '说服一个人', what: '请选中的人到柜上看库银，回去替钱庄说话。' },
  { key: 'insurance', name: '存款保险', what: '官府宣布存款有损失照赔。' },
]

export function describe(run: RunData, iv: Intervention): string {
  const person = (i?: number | null) => (i == null ? '某人' : run.population.persons[i]!.name)
  switch (iv.kind) {
    case 'close_venue':
      return `关闭${run.population.venues[iv.target ?? 0]!.name}${iv.duration ? ` ${iv.duration} 小时` : ''}`
    case 'silence':
      return `带走${person(iv.target)}`
    case 'convince':
      return `说服${person(iv.target)}`
    case 'insurance':
      return `存款保险，赔付 ${Math.round((iv.value ?? 0) * 100)}%`
    default:
      return iv.valence === 1 ? '放出新谣言' : (iv.strength ?? 0) >= 2.5 ? '官银号担保' : '掌柜贴告示'
  }
}

export function Lab({ run }: { run: RunData }) {
  const t = useApp((s) => Math.max(1, Math.ceil(s.t)))
  const selected = useApp((s) => s.selected)
  const pending = useApp((s) => s.pending)
  const busy = useApp((s) => s.busy)
  const error = useApp((s) => s.labError)
  const compare = useApp((s) => s.compare)
  const ensemble = useApp((s) => s.ensemble)
  const [kind, setKind] = useState<Kind>('guarantee')
  const [venue, setVenue] = useState(1)
  const [hours, setHours] = useState(24)
  const [cover, setCover] = useState(0.8)

  const m = run.manifest
  const needsPerson = kind === 'silence' || kind === 'convince'
  const failed = m.summary.failed_at
  const tooLate = failed != null && t >= failed

  const build = (): Intervention => {
    switch (kind) {
      case 'notice':
        return { t, kind: 'broadcast', actor: run.population.cast.banker, valence: -1, strength: 1.2, reach: 0.35, text: '通和钱庄告示：本号银根充足，照常兑付，切勿听信谣言。' } // prettier-ignore
      case 'guarantee':
        return { t, kind: 'broadcast', valence: -1, strength: 3, reach: 0.9, text: '官银号告示：通和钱庄银根充足，本号担保照常兑付。现银已运抵柜上。' } // prettier-ignore
      case 'rumor':
        return { t, kind: 'broadcast', valence: 1, strength: 1.5, reach: 0.3, text: '街上到处有人说：通和的东家已经跑了，明天就关门！' } // prettier-ignore
      case 'close_venue':
        return { t, kind: 'close_venue', target: venue, duration: hours }
      case 'silence':
        return { t, kind: 'silence', target: selected }
      case 'convince':
        return { t, kind: 'convince', target: selected }
      case 'insurance':
        return { t, kind: 'insurance', value: cover }
    }
  }

  return (
    <>
      <section className="stack">
        <h3>在{clockText(run, t)}介入</h3>
        <select aria-label="干预方式" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.name}
            </option>
          ))}
        </select>
        <p className="small muted">{KINDS.find((k) => k.key === kind)!.what}</p>
        {kind === 'close_venue' && (
          <div className="fields">
            <select aria-label="场所" value={venue} onChange={(e) => setVenue(Number(e.target.value))}>
              {run.population.venues.filter((v) => v.idx !== run.population.bank).map((v) => (
                <option key={v.idx} value={v.idx}>
                  {v.name}
                </option>
              ))}
            </select>
            <select aria-label="关多久" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={24}>关一天</option>
              <option value={48}>关两天</option>
              <option value={0}>一直关</option>
            </select>
          </div>
        )}
        {kind === 'insurance' && (
          <label className="fields small">
            赔付 {Math.round(cover * 100)}%
            <input type="range" min={0.2} max={1} step={0.1} value={cover} onChange={(e) => setCover(Number(e.target.value))} />
          </label>
        )}
        {needsPerson && (
          <p className="small">{selected == null ? '先在舞台上点一个人。' : `对象：${run.population.persons[selected]!.name}`}</p>
        )}
        {tooLate && <p className="small muted">这一刻钱庄已经倒了，把时间拖回倒闭之前再介入。</p>}
        <button disabled={tooLate || (needsPerson && selected == null)} onClick={() => useApp.getState().addPending(build())}>
          加入这条干预
        </button>
      </section>

      {pending.length > 0 && (
        <section className="stack">
          <h3>待执行</h3>
          {pending.map((iv, i) => (
            <div className="pending" key={i}>
              <span>
                <span className="muted small num">{clockText(run, iv.t)}</span> {describe(run, iv)}
              </span>
              <button aria-label="移除" onClick={() => useApp.getState().removePending(i)}>
                ×
              </button>
            </div>
          ))}
          <button className="primary" disabled={busy !== ''} onClick={() => void useApp.getState().branch()}>
            {busy === 'branch' ? '正在重跑…' : '分叉重跑'}
          </button>
        </section>
      )}
      {error && <p className="small error">{error}</p>}

      <section className="stack">
        <h3>这条世界线</h3>
        {(m.params.interventions ?? []).length === 0 && <p className="small muted">没有任何干预。</p>}
        {(m.params.interventions ?? []).map((iv, i) => (
          <div className="small" key={i}>
            <span className="muted num">{clockText(run, iv.t)}</span> {describe(run, iv)}
          </div>
        ))}
        {compare && (
          <table className="compare">
            <thead>
              <tr>
                <th />
                <th>这一条</th>
                <th>分叉前（虚线）</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>结局</td>
                <td>{outcome(run, m.summary.failed_at)}</td>
                <td>{outcome(run, compare.manifest.summary.failed_at)}</td>
              </tr>
              <tr>
                <td>取出存款</td>
                <td className="num">{m.summary.withdrew} 人</td>
                <td className="num">{compare.manifest.summary.withdrew} 人</td>
              </tr>
              <tr>
                <td>钱没取出来</td>
                <td className="num">{m.summary.lost} 人</td>
                <td className="num">{compare.manifest.summary.lost} 人</td>
              </tr>
              <tr>
                <td>最多相信</td>
                <td className="num">{m.summary.peak_believers} 人</td>
                <td className="num">{compare.manifest.summary.peak_believers} 人</td>
              </tr>
            </tbody>
          </table>
        )}
        {compare && (
          <button onClick={() => void useApp.getState().open(compare.manifest.run_id, true)}>回到分叉前那一条</button>
        )}
      </section>

      <section className="stack">
        <h3>换个种子还会这样吗</h3>
        <p className="small muted">同样的设定和干预，换 20 座随机生成的城各跑一遍。时间轴上的色带是中间八成的范围。</p>
        {ensemble && (
          <p>
            <span className="big num">{ensemble.failed}</span>
            <span className="muted"> / {ensemble.k} 座城里钱庄倒了</span>
          </p>
        )}
        <button disabled={busy !== ''} onClick={() => void useApp.getState().runEnsemble()}>
          {busy === 'ensemble' ? '正在跑 20 座城…' : ensemble ? '已算过' : '跑 20 个种子'}
        </button>
      </section>
    </>
  )
}

function outcome(run: RunData, failedAt: number | null): string {
  return failedAt == null ? '钱庄撑住了' : `${clockText(run, failedAt)}倒闭`
}
