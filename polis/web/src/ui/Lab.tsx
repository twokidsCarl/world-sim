// 实验台：在回放的此刻加一条干预，分叉重跑，和原来那条世界线对比；或者同一设定换种子看分布。
// Lab: add an intervention at the current replay moment, fork and re-run, and compare against the original world line; or keep the setup and vary the seed to see the distribution.
import { useState } from 'react'
import type { Intervention } from '../contract/types.gen.ts'
import { clockText, type RunData } from '../state/derive.ts'
import { loc, tr } from '../state/lang.ts'
import { useApp } from '../state/store.ts'

type Kind = 'notice' | 'guarantee' | 'rumor' | 'close_venue' | 'silence' | 'convince' | 'insurance'

const KINDS: { key: Kind; name: [string, string]; what: [string, string] }[] = [
  { key: 'notice', name: ['掌柜贴告示', 'The bank posts a notice'], what: ['钱庄自己出面否认。信的人不多。', 'The bank denies it itself. Few believe it.'] },
  { key: 'guarantee', name: ['官银号担保', 'An official guarantee'], what: ['可信的一方公开担保，并把现银摆上柜台。', 'A credible party vouches for the bank in public and puts cash on the counter.'] },
  { key: 'rumor', name: ['再放一条谣言', 'Plant another rumour'], what: ['有人故意散布更重的说法。', 'Someone deliberately spreads a graver version.'] },
  { key: 'close_venue', name: ['关一处场所', 'Close a venue'], what: ['勒令一处人来人往的地方关门。', 'Order a busy meeting place shut.'] },
  { key: 'silence', name: ['带走一个人', 'Take someone away'], what: ['让舞台上选中的人不再开口。', 'Silence the person selected on the stage.'] },
  { key: 'convince', name: ['说服一个人', 'Convince someone'], what: ['请选中的人到柜上看库银，回去替钱庄说话。', 'Show the selected person the vault, so they go back and speak for the bank.'] },
  { key: 'insurance', name: ['存款保险', 'Deposit insurance'], what: ['官府宣布存款有损失照赔。', 'The authorities announce that lost deposits will be made good.'] },
]

export function describe(run: RunData, iv: Intervention): string {
  const person = (i?: number | null) => (i == null ? tr('某人', 'someone') : run.population.persons[i]!.name)
  switch (iv.kind) {
    case 'close_venue': {
      const v = run.population.venues[iv.target ?? 0]!
      return tr(`关闭${v.name}${iv.duration ? ` ${iv.duration} 小时` : ''}`, `Close ${loc(v.name, v.name_en)}${iv.duration ? ` for ${iv.duration} h` : ''}`)
    }
    case 'silence':
      return tr(`带走${person(iv.target)}`, `Take ${person(iv.target)} away`)
    case 'convince':
      return tr(`说服${person(iv.target)}`, `Convince ${person(iv.target)}`)
    case 'insurance':
      return tr(`存款保险，赔付 ${Math.round((iv.value ?? 0) * 100)}%`, `Deposit insurance covering ${Math.round((iv.value ?? 0) * 100)}%`)
    case 'errand':
      return tr('一笔与传闻无关的取款', 'A withdrawal unrelated to the rumour')
    default:
      return iv.valence === 1 ? tr('放出新谣言', 'A new rumour') : (iv.strength ?? 0) >= 2.5 ? tr('官银号担保', 'An official guarantee') : tr('掌柜贴告示', 'The bank posts a notice')
  }
}

/** 时间轴上的短标记 / The short label on the timeline */
export function short(run: RunData, iv: Intervention): string {
  switch (iv.kind) {
    case 'close_venue':
      return tr('关场所', 'Closure')
    case 'silence':
      return tr('带走', 'Silenced')
    case 'convince':
      return tr('说服', 'Convinced')
    case 'insurance':
      return tr('保险', 'Insurance')
    case 'errand':
      return tr('取款', 'Errand')
    default:
      return describe(run, iv).slice(0, 5)
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
        return { t, kind: 'broadcast', valence: -1, strength: 3, reach: 0.9, cash: 0.5, text: '官银号告示：通和钱庄银根充足，本号担保照常兑付。现银已运抵柜上。' } // prettier-ignore
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
        <h3>{tr(`在${clockText(run, t)}介入`, `Intervene at ${clockText(run, t)}`)}</h3>
        <select aria-label={tr('干预方式', 'Kind of intervention')} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {tr(...k.name)}
            </option>
          ))}
        </select>
        <p className="small muted">{tr(...KINDS.find((k) => k.key === kind)!.what)}</p>
        {kind === 'close_venue' && (
          <div className="fields">
            <select aria-label={tr('场所', 'Venue')} value={venue} onChange={(e) => setVenue(Number(e.target.value))}>
              {run.population.venues.filter((v) => v.idx !== run.population.bank).map((v) => (
                <option key={v.idx} value={v.idx}>
                  {loc(v.name, v.name_en)}
                </option>
              ))}
            </select>
            <select aria-label={tr('关多久', 'For how long')} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              <option value={24}>{tr('关一天', 'One day')}</option>
              <option value={48}>{tr('关两天', 'Two days')}</option>
              <option value={0}>{tr('一直关', 'For good')}</option>
            </select>
          </div>
        )}
        {kind === 'insurance' && (
          <label className="fields small">
            {tr('赔付', 'Covers')} {Math.round(cover * 100)}%
            <input type="range" min={0.2} max={1} step={0.1} value={cover} onChange={(e) => setCover(Number(e.target.value))} />
          </label>
        )}
        {needsPerson && (
          <p className="small">{selected == null ? tr('先在舞台上点一个人。', 'Click a person on the stage first.') : tr('对象：', 'Target: ') + run.population.persons[selected]!.name}</p>
        )}
        {tooLate && <p className="small muted">{tr('这一刻钱庄已经倒了，把时间拖回倒闭之前再介入。', 'The bank has already failed at this moment. Drag time back to before the failure.')}</p>}
        <button disabled={tooLate || (needsPerson && selected == null)} onClick={() => useApp.getState().addPending(build())}>
          {tr('加入这条干预', 'Add this intervention')}
        </button>
      </section>

      {pending.length > 0 && (
        <section className="stack">
          <h3>{tr('待执行', 'Pending')}</h3>
          {pending.map((iv, i) => (
            <div className="pending" key={i}>
              <span>
                <span className="muted small num">{clockText(run, iv.t)}</span> {describe(run, iv)}
              </span>
              <button aria-label={tr('移除', 'Remove')} onClick={() => useApp.getState().removePending(i)}>
                ×
              </button>
            </div>
          ))}
          <button className="primary" disabled={busy !== ''} onClick={() => void useApp.getState().branch()}>
            {busy === 'branch' ? tr('正在重跑…', 'Re-running…') : tr('分叉重跑', 'Fork and re-run')}
          </button>
        </section>
      )}
      {error && <p className="small error">{error}</p>}

      <section className="stack">
        <h3>{tr('这条世界线', 'This world')}</h3>
        {(m.params.interventions ?? []).length === 0 && <p className="small muted">{tr('没有任何干预。', 'No interventions.')}</p>}
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
                <th>{tr('这一条', 'This one')}</th>
                <th>{tr('分叉前（虚线）', 'Before the fork (dashed)')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{tr('结局', 'Outcome')}</td>
                <td>{outcome(run, m.summary.failed_at)}</td>
                <td>{outcome(run, compare.manifest.summary.failed_at)}</td>
              </tr>
              <tr>
                <td>{tr('取出存款', 'Withdrew')}</td>
                <td className="num">{m.summary.withdrew}{tr(' 人', '')}</td>
                <td className="num">{compare.manifest.summary.withdrew}{tr(' 人', '')}</td>
              </tr>
              <tr>
                <td>{tr('钱没取出来', 'Lost their money')}</td>
                <td className="num">{m.summary.lost}{tr(' 人', '')}</td>
                <td className="num">{compare.manifest.summary.lost}{tr(' 人', '')}</td>
              </tr>
              <tr>
                <td>{tr('最多相信', 'Peak believers')}</td>
                <td className="num">{m.summary.peak_believers}{tr(' 人', '')}</td>
                <td className="num">{compare.manifest.summary.peak_believers}{tr(' 人', '')}</td>
              </tr>
            </tbody>
          </table>
        )}
        {compare && (
          <button onClick={() => void useApp.getState().open(compare.manifest.run_id, true)}>{tr('回到分叉前那一条', 'Back to the world before the fork')}</button>
        )}
      </section>

      <section className="stack">
        <h3>{tr('换个种子还会这样吗', 'Would another seed do the same?')}</h3>
        <p className="small muted">{tr('同样的设定和干预，换 20 座随机生成的城各跑一遍。时间轴上的色带是中间八成的范围。', 'The same setup and interventions, run in 20 randomly generated towns. The bands on the timeline cover the middle 80%.')}</p>
        {ensemble && (
          <p>
            <span className="big num">{ensemble.failed}</span>
            <span className="muted"> / {ensemble.k}{tr(' 座城里钱庄倒了', ' towns saw the bank fail')}</span>
          </p>
        )}
        <button disabled={busy !== ''} onClick={() => void useApp.getState().runEnsemble()}>
          {busy === 'ensemble' ? tr('正在跑 20 座城…', 'Running 20 towns…') : ensemble ? tr('已算过', 'Done') : tr('跑 20 个种子', 'Run 20 seeds')}
        </button>
      </section>
    </>
  )
}

function outcome(run: RunData, failedAt: number | null): string {
  return failedAt == null ? tr('钱庄撑住了', 'The bank held') : tr(`${clockText(run, failedAt)}倒闭`, `Failed at ${clockText(run, failedAt)}`)
}
