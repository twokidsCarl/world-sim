// "标定对照"对话框（只读）：data/curated/calibration/ 下的对照表。每张表先给摘要——容差内外各多少行、差得最多的几行、
// 参照的名称、版本、许可和网址——整张表点开才画。
// The read-only "Calibration" dialog: the comparison tables under data/curated/calibration/. Each table shows a summary
// first — rows within and outside tolerance, the largest disagreements, each reference's name, version, licence and URL —
// and the full table is drawn only when opened.
//
// 这个文件和那些表（合计近 1 MB）各自是单独的代码块，打开对话框时才下载，主包不受影响。
// This file and the tables (close to 1 MB together) are chunks of their own, fetched when the dialog opens; the main bundle
// is unaffected.

import { useEffect, useMemo, useState } from 'react'
import { countRows, hasBodies, largestDisagreements, rowLabel, rowNote, rowValues, rowsFor, type BodyFilter, type CalibrationRow, type CalibrationTable } from '../calibration/summary.ts'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

const loaders = import.meta.glob<{ default: CalibrationTable }>('../../data/curated/calibration/*.json')

/** 表的排列顺序：先骨架和关节，再肌肉，再器官和面部，量具自检放最后 / Order of the tables: skeleton and joints, muscles, organs and face, with the instrument check last. */
const ORDER = ['segments', 'rom', 'arm-bones', 'muscle-attachments-myo', 'muscle-curves-opensim', 'muscle-curves-myo', 'organ-volumes', 'face-displacement', 'face-coverage', 'instrument-check']

const BODY_LABEL: Record<string, string> = { male: '男 M', female: '女 F' }
const VERDICT: Record<string, { zh: string; cls: string }> = {
  within: { zh: '容差内 within', cls: 'cal-in' },
  outside: { zh: '容差外 outside', cls: 'cal-out' },
  'not comparable': { zh: '不可比 n/c', cls: 'cal-nc' },
}

function Rows({ rows, bodies }: { rows: readonly CalibrationRow[]; bodies: boolean }) {
  return (
    <div className="cal-scroll">
      <table className="cal-table">
        <thead>
          <tr>
            {bodies && <th>人体 Body</th>}
            <th>项目 Item</th>
            <th>我们 Ours</th>
            <th>参照 Reference</th>
            <th>差 Difference</th>
            <th>容差 Tolerance</th>
            <th>判定 Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const v = rowValues(r)
            const note = rowNote(r)
            const verdict = r.verdict ? VERDICT[r.verdict] : undefined
            return (
              <tr key={i}>
                {bodies && <td>{r.body ? (BODY_LABEL[r.body] ?? r.body) : '–'}</td>}
                <td title={note ? `${note.zh}\n${note.en}` : undefined}>
                  {rowLabel(r)}
                  {note && <span className="cal-note"> {note.zh === note.en ? note.en : `${note.zh} ${note.en}`}</span>}
                </td>
                <td className="num">{v.ours}</td>
                <td className="num">{v.ref}</td>
                <td className="num">{v.diff}</td>
                <td className="num">{v.tolerance}</td>
                <td className={verdict?.cls}>{verdict?.zh ?? (r.verdict ? String(r.verdict) : '–')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const FULL_STEP = 150

function TableCard({ table, body }: { table: CalibrationTable; body: BodyFilter }) {
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(FULL_STEP)
  const [method, setMethod] = useState(false)
  const bodies = hasBodies(table)
  const rows = useMemo(() => rowsFor(table, body), [table, body])
  const counts = useMemo(() => countRows(rows), [rows])
  const worst = useMemo(() => largestDisagreements(rows, 5), [rows])
  const judged = counts.rows - counts.unjudged
  return (
    <section className="cal-card">
      <h3>
        {table.title.zh} <span className="en">{table.title.en}</span>
      </h3>
      <p className="cal-counts">
        <span>
          {counts.rows} 行 <span className="en">rows</span>
        </span>
        {judged > 0 ? (
          <>
            <span className="cal-in">
              容差内 {counts.within} <span className="en">within</span>
            </span>
            <span className="cal-out">
              容差外 {counts.outside} <span className="en">outside</span>
            </span>
            {counts.notComparable > 0 && (
              <span className="cal-nc">
                不可比 {counts.notComparable} <span className="en">not comparable</span>
              </span>
            )}
          </>
        ) : (
          <span className="cal-nc">
            这张表不作判定 <span className="en">no verdict in this table</span>
          </span>
        )}
        {!bodies && body !== 'all' && (
          <span className="cal-nc">
            不分人体 <span className="en">not split by body</span>
          </span>
        )}
      </p>
      {judged > 0 && (
        <div className="cal-bar" role="img" aria-label={`容差内 ${counts.within}，容差外 ${counts.outside}，不可比 ${counts.notComparable} / within ${counts.within}, outside ${counts.outside}, not comparable ${counts.notComparable}`}>
          <div className="in" style={{ flexGrow: counts.within }} />
          <div className="out" style={{ flexGrow: counts.outside }} />
          <div className="nc" style={{ flexGrow: counts.notComparable }} />
        </div>
      )}
      <p className="hint">
        <strong>容差 Tolerance：</strong>
        {table.tolerance.zh} <span className="en">{table.tolerance.en}</span>
      </p>
      <button className="link-btn" aria-expanded={method} onClick={() => setMethod(!method)}>
        {method ? '收起' : '展开'}方法和说明 <span className="en">Method and notes</span>
      </button>
      {method && (
        <>
          <p className="hint">
            {table.method.zh} <span className="en">{table.method.en}</span>
          </p>
          {(table.notes ?? []).map((n, i) => (
            <p className="hint" key={i}>
              {n.zh} <span className="en">{n.en}</span>
            </p>
          ))}
        </>
      )}
      <h4>
        参照 <span className="en">References</span>
      </h4>
      <ul className="sources cal-refs">
        {table.references.map((r) => (
          <li key={r.id}>
            <a href={r.url} target="_blank" rel="noreferrer noopener">
              {r.name}
            </a>
            <span className="tag">{r.licence}</span>
            <p>
              版本 <span className="en">Version</span>：{r.version}
              <br />
              <span className="cal-url">{r.url}</span>
            </p>
          </li>
        ))}
      </ul>
      {worst.length > 0 && (
        <>
          <h4>
            差得最多的 {worst.length} 行 <span className="en">Largest disagreements</span>
          </h4>
          <Rows rows={worst} bodies={bodies} />
        </>
      )}
      {judged > 0 && counts.outside === 0 && <p className="hint">所选范围内没有容差外的行。 No row outside tolerance in this selection.</p>}
      <button className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}全部 {rows.length} 行 <span className="en">All rows</span>
      </button>
      {open && (
        <>
          <Rows rows={rows.slice(0, limit)} bodies={bodies} />
          {rows.length > limit && (
            <button className="link-btn" onClick={() => setLimit(limit + FULL_STEP * 4)}>
              再显示一些（已显示 {limit} / {rows.length}） <span className="en">Show more</span>
            </button>
          )}
        </>
      )}
    </section>
  )
}

export default function CalibrationDialog() {
  const setOpen = useApp((s) => s.setCalibrationOpen)
  const dataset = useApp((s) => s.dataset)
  const [tables, setTables] = useState<CalibrationTable[] | null>(null)
  const [error, setError] = useState('')
  const [body, setBody] = useState<BodyFilter>(dataset === 'male' || dataset === 'female' ? dataset : 'all')
  useEffect(() => {
    let cancelled = false
    Promise.all(Object.values(loaders).map((load) => load()))
      .then((mods) => {
        if (cancelled) return
        const list = mods.map((m) => m.default).filter((t) => t && Array.isArray(t.rows))
        const rank = (id: string): number => (ORDER.indexOf(id) < 0 ? ORDER.length : ORDER.indexOf(id))
        list.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
        setTables(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])
  const total = useMemo(() => (tables ? countRows(tables.flatMap((t) => rowsFor(t, body))) : null), [tables, body])
  return (
    <div className="dialog-backdrop" onClick={() => setOpen(false)}>
      <div className="dialog cal-dialog" role="dialog" aria-modal="true" aria-labelledby="cal-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="cal-title">
            标定对照 <span className="en">Calibration</span>
          </h2>
          <button className="icon-btn" aria-label="关闭 / close" onClick={() => setOpen(false)}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">
          <p className="disclaimer">
            <strong>这些表是与外部开放模型和已发表统计的对照：它们被当作量具使用，不是临床人员的审核。</strong>
            “容差内”只说明两边算出的同一个量相差不大，参照本身也是模型或群体平均，不是真值；容差是本项目定的。
            <span className="en">
              {' '}
              <strong>These tables are comparisons with open external models and published statistics, used as measuring instruments. They are not validation by a clinician.</strong> “Within tolerance” only says that one quantity computed on both sides differs little; the references are models or population averages themselves, not ground truth, and the tolerances were set by this project.
            </span>
          </p>
          <div className="cal-filter">
            <span>
              人体 <span className="en">Body</span>
            </span>
            <div className="segmented" role="radiogroup" aria-label="按人体筛选 / filter by body">
              {(
                [
                  ['all', '全部', 'All'],
                  ['male', '男性', 'Male'],
                  ['female', '女性', 'Female'],
                ] as const
              ).map(([id, zh, en]) => (
                <button key={id} role="radio" aria-checked={body === id} className={body === id ? 'active' : ''} onClick={() => setBody(id)}>
                  {zh} <span className="en">{en}</span>
                </button>
              ))}
            </div>
            {total && (
              <span className="hint">
                {tables!.length} 张表 · {total.rows} 行 · 容差内 {total.within} · 容差外 {total.outside} · 不可比 {total.notComparable}
                <span className="en">
                  {' '}
                  {tables!.length} tables · {total.rows} rows · within {total.within} · outside {total.outside} · not comparable {total.notComparable}
                </span>
              </span>
            )}
          </div>
          {!tables && !error && <p className="hint">正在加载对照表… Loading the tables…</p>}
          {error && (
            <p className="hint">
              <strong>无法加载对照表。</strong> The tables could not be loaded. {error}
            </p>
          )}
          {tables?.map((t) => <TableCard key={t.id} table={t} body={body} />)}
        </div>
      </div>
    </div>
  )
}
