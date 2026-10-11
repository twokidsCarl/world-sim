import { useState } from 'react'
import { Link } from 'react-router'
import type { State, ThreadId } from '../contract'
import { maxCell, shade } from '../state/derive'
import { Page, Section } from '../ui/Page'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function MapPage({ state }: { state: State }) {
  const [view, setView] = useState<'grid' | 'kernels'>('grid')
  const max = maxCell(state)
  const title = new Map(state.ideas.map((i) => [i.id, i.title]))
  const ladder = state.frame.levels.filter((l) => l.kind === 'ladder')
  const lanes = state.frame.levels.filter((l) => l.kind !== 'ladder')
  const projectAt = new Map(state.projects.filter((p) => p.level).map((p) => [p.level as string, p]))
  const biggest = Math.max(1, ...state.kernels.map((k) => k.ideas.length))

  return (
    <Page
      title="地图"
      lead={`想法池里现在有 ${state.counts.live} 条。每条 idea 的位置由三样东西定：它在哪一层、在哪几条横线上、底下跑的是哪一种计算。`}
      actions={
        <div className="seg" role="tablist" aria-label="看法">
          <button role="tab" aria-selected={view === 'grid'} onClick={() => setView('grid')}>
            按层和横线
          </button>
          <button role="tab" aria-selected={view === 'kernels'} onClick={() => setView('kernels')}>
            按内核
          </button>
        </div>
      }
    >
      {view === 'grid' ? (
        <>
          <Section title="主干：十层 × 五条横线" note="格子里的数是这一格有几条；点进去看是哪几条">
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col" className="lv">层</th>
                    {THREADS.map((t) => {
                      const info = state.frame.threads.find((x) => x.id === t)
                      return (
                        <th key={t} scope="col" title={info?.desc}>
                          <Link to={`/ideas?threads=${t}`}>
                            <span className={`dot thread-${t}`} aria-hidden="true" /> {t} {info?.name}
                          </Link>
                        </th>
                      )
                    })}
                    <th scope="col" className="total">这一层</th>
                  </tr>
                </thead>
                <tbody>
                  {ladder.map((level) => {
                    const project = projectAt.get(level.id)
                    return (
                      <tr key={level.id}>
                        <th scope="row" className="lv">
                          <Link to={`/ideas?level=${level.id}`}>
                            <span className="lv-id num">{level.id}</span> {level.name}
                          </Link>
                          <div className="muted small">{level.emerges}</div>
                          {project && (
                            <Link className="chip project" to={`/ideas?project=${project.dir}`} title={project.tagline}>
                              {project.dir}
                            </Link>
                          )}
                        </th>
                        {THREADS.map((t) => {
                          const ids = state.coverage.cells[level.id]?.[t] ?? []
                          return (
                            <td key={t} className={`cell s${shade(ids.length, max)}`}>
                              {ids.length ? (
                                <Link to={`/ideas?level=${level.id}&threads=${t}`} aria-label={`${level.id} ${t}：${ids.length} 条`}>
                                  <span className="n num">{ids.length}</span>
                                  <span className="titles">
                                    {ids.slice(0, 3).map((id) => (
                                      <span key={id}>{title.get(id)}</span>
                                    ))}
                                    {ids.length > 3 && <span className="more">还有 {ids.length - 3} 条</span>}
                                  </span>
                                </Link>
                              ) : (
                                <span className="none" aria-label={`${level.id} ${t}：空`}>—</span>
                              )}
                            </td>
                          )
                        })}
                        <td className="total num">
                          <Link to={`/ideas?level=${level.id}`}>{state.coverage.by_level[level.id]?.length ?? 0}</Link>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Section>
          <Section title="阶梯之外" note="纵线穿过所有层；两条支线各有自己的小阶梯">
            <div className="lanes">
              {lanes.map((lane) => {
                const ids = state.coverage.by_level[lane.id] ?? []
                return (
                  <Link key={lane.id} to={`/ideas?level=${lane.id}`} className="lane">
                    <div className="lane-head">
                      <h3>{lane.name}</h3>
                      <span className="n num">{ids.length}</span>
                    </div>
                    <p className="muted small">{lane.intro}</p>
                    <p className="small lane-titles">{ids.map((id) => title.get(id)).join(' · ')}</p>
                  </Link>
                )
              })}
            </div>
          </Section>
        </>
      ) : (
        <Section title="按内核" note="共用一种计算的 idea，做出第一个，后面的主要是换内容">
          <ul className="kernels">
            {state.kernels.map((k) => (
              <li key={k.name}>
                <Link to={`/ideas?kernel=${encodeURIComponent(k.name)}`} className="kernel">
                  <div className="kernel-head">
                    <h3>{k.name}</h3>
                    {k.project ? <span className="chip project">已有：{k.project}</span> : <span className="muted small">还没有项目</span>}
                    <span className="n num">{k.ideas.length}</span>
                  </div>
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${(k.ideas.length / biggest) * 100}%` }} />
                  </div>
                  <p className="muted small">{k.desc}</p>
                  <p className="small lane-titles">{k.ideas.map((id) => title.get(id)).join(' · ')}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Page>
  )
}
