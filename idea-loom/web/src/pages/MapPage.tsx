import { useState } from 'react'
import { Link } from 'react-router'
import type { State, ThreadId } from '../contract'
import { pick, plural } from '../i18n'
import { maxCell, shade } from '../state/derive'
import { useLang, useT } from '../state/store'
import { Page, Section } from '../ui/Page'
import { ideaTitle } from '../ui/bits'

const THREADS: ThreadId[] = ['A', 'B', 'C', 'D', 'E']

export function MapPage({ state }: { state: State }) {
  const [view, setView] = useState<'grid' | 'kernels'>('grid')
  const lang = useLang()
  const t = useT()
  const max = maxCell(state)
  const title = new Map(state.ideas.map((i) => [i.id, ideaTitle(lang, i)]))
  const ladder = state.frame.levels.filter((l) => l.kind === 'ladder')
  const lanes = state.frame.levels.filter((l) => l.kind !== 'ladder')
  const projectAt = new Map(state.projects.filter((p) => p.level).map((p) => [p.level as string, p]))
  const biggest = Math.max(1, ...state.kernels.map((k) => k.ideas.length))

  return (
    <Page
      title={t('地图', 'Map')}
      lead={t(
        `想法池里现在有 ${state.counts.live} 条。每条 idea 的位置由三样东西定：它在哪一层、在哪几条横线上、底下跑的是哪一种计算。`,
        `The idea pool holds ${plural(state.counts.live, 'idea')} now. Three things place each idea: its level, the threads it sits on, and the kind of computation running underneath.`,
      )}
      actions={
        <div className="seg" role="tablist" aria-label={t('看法', 'View')}>
          <button role="tab" aria-selected={view === 'grid'} onClick={() => setView('grid')}>
            {t('按层和横线', 'By level and thread')}
          </button>
          <button role="tab" aria-selected={view === 'kernels'} onClick={() => setView('kernels')}>
            {t('按内核', 'By kernel')}
          </button>
        </div>
      }
    >
      {view === 'grid' ? (
        <>
          <Section
            title={t('主干：十层 × 五条横线', 'Trunk: ten levels × five threads')}
            note={t('格子里的数是这一格有几条；点进去看是哪几条', 'The number in a cell is how many ideas it holds; click to see which')}
          >
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col" className="lv">{t('层', 'Level')}</th>
                    {THREADS.map((id) => {
                      const info = state.frame.threads.find((x) => x.id === id)
                      return (
                        <th key={id} scope="col" title={pick(lang, info?.desc, info?.desc_en)}>
                          <Link to={`/ideas?threads=${id}`}>
                            <span className={`dot thread-${id}`} aria-hidden="true" /> {id} {pick(lang, info?.name, info?.name_en)}
                          </Link>
                        </th>
                      )
                    })}
                    <th scope="col" className="total">{t('这一层', 'This level')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ladder.map((level) => {
                    const project = projectAt.get(level.id)
                    return (
                      <tr key={level.id}>
                        <th scope="row" className="lv">
                          <Link to={`/ideas?level=${level.id}`}>
                            <span className="lv-id num">{level.id}</span> {pick(lang, level.name, level.name_en)}
                          </Link>
                          <div className="muted small">{pick(lang, level.emerges, level.emerges_en)}</div>
                          {project && (
                            <Link className="chip project" to={`/ideas?project=${project.dir}`} title={pick(lang, project.tagline, project.tagline_en)}>
                              {project.dir}
                            </Link>
                          )}
                        </th>
                        {THREADS.map((id) => {
                          const ids = state.coverage.cells[level.id]?.[id] ?? []
                          return (
                            <td key={id} className={`cell s${shade(ids.length, max)}`}>
                              {ids.length ? (
                                <Link to={`/ideas?level=${level.id}&threads=${id}`} aria-label={t(`${level.id} ${id}：${ids.length} 条`, `${level.id} ${id}: ${plural(ids.length, 'idea')}`)}>
                                  <span className="n num">{ids.length}</span>
                                  <span className="titles">
                                    {ids.slice(0, 3).map((x) => (
                                      <span key={x} title={title.get(x)}>{title.get(x)}</span>
                                    ))}
                                    {ids.length > 3 && <span className="more">{t(`还有 ${ids.length - 3} 条`, `${ids.length - 3} more`)}</span>}
                                  </span>
                                </Link>
                              ) : (
                                <Link
                                  className="none"
                                  to={`/inbox?level=${level.id}&thread=${id}`}
                                  aria-label={t(`${level.id} ${id}：空，去生成`, `${level.id} ${id}: empty, go and generate`)}
                                  title={t('这一格是空的，去生成', 'This cell is empty; go and generate')}
                                >
                                  —
                                </Link>
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
          <Section
            title={t('阶梯之外', 'Off the ladder')}
            note={t('纵线穿过所有层；两条支线各有自己的小阶梯', 'The verticals run through every level; each of the two branches has a small ladder of its own')}
          >
            <div className="lanes">
              {lanes.map((lane) => {
                const ids = state.coverage.by_level[lane.id] ?? []
                return (
                  <Link key={lane.id} to={`/ideas?level=${lane.id}`} className="lane">
                    <div className="lane-head">
                      <h3>{pick(lang, lane.name, lane.name_en)}</h3>
                      <span className="n num">{ids.length}</span>
                    </div>
                    <p className="muted small">{pick(lang, lane.intro, lane.intro_en)}</p>
                    <p className="small lane-titles">{ids.map((x) => title.get(x)).join(' · ')}</p>
                  </Link>
                )
              })}
            </div>
          </Section>
        </>
      ) : (
        <Section
          title={t('按内核', 'By kernel')}
          note={t('共用一种计算的 idea，做出第一个，后面的主要是换内容', 'Ideas sharing one computation: once the first is built, the rest is mostly a change of content')}
        >
          <ul className="kernels">
            {state.kernels.map((k) => (
              <li key={k.name}>
                <Link to={`/ideas?kernel=${encodeURIComponent(k.name)}`} className="kernel">
                  <div className="kernel-head">
                    <h3>{pick(lang, k.name, k.name_en)}</h3>
                    {k.project ? (
                      <span className="chip project">{t(`已有：${k.project}`, `Built: ${k.project}`)}</span>
                    ) : (
                      <span className="muted small">{t('还没有项目', 'No project yet')}</span>
                    )}
                    <span className="n num">{k.ideas.length}</span>
                  </div>
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${(k.ideas.length / biggest) * 100}%` }} />
                  </div>
                  <p className="muted small">{pick(lang, k.desc, k.desc_en)}</p>
                  <p className="small lane-titles">{k.ideas.map((x) => title.get(x)).join(' · ')}</p>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Page>
  )
}
