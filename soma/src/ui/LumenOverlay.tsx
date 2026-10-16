// 舞台上的"腔"图例和内镜漫游的控制条；嵌入模式下也在（那里它就是全部的控件）。
// The lumina legend and the fly-through controls over the stage; present in embed mode too (where they are
// all the controls there are).

import { useEffect } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { LUMEN_COLOR } from '../lumen/colors.ts'
import { CANAL_ROUTE, FLY_SPEED, FLY_SPEEDS, registerLumenUrlWriter, routesOf, syncLumenUrl, useLumen } from '../lumen/state.ts'
import { FLY_RULE, LUMEN_FEMALE_NOTE, LUMEN_STATEMENT } from '../lumen/statements.ts'
import { ORIGIN_BOUNDED, ORIGIN_CONSTRUCTION, ORIGIN_DERIVED, ORIGIN_MIXED } from '../lumen/core.ts'
import { useApp } from '../state/store.ts'
import { setPassthroughParam } from '../state/urlSync.ts'
import './lumen.css'

registerLumenUrlWriter(setPassthroughParam)

const KINDS = [
  { kind: ORIGIN_DERIVED, color: LUMEN_COLOR.derived, zh: '由壁推导', en: 'derived from the wall' },
  { kind: ORIGIN_BOUNDED, color: LUMEN_COLOR.bounded, zh: '以真实部件为界 / 标本自己的腔', en: 'bounded by real parts / the specimen’s own' },
  { kind: ORIGIN_MIXED, color: LUMEN_COLOR.mixed, zh: '部分构造（数据里没有逐顶点的标记，整件一个颜色）', en: 'partly construction (no per-vertex marking in the data, so one colour for the part)' },
  { kind: ORIGIN_CONSTRUCTION, color: LUMEN_COLOR.construction, zh: '构造', en: 'construction' },
] as const

export function LumenOverlay({ graph }: { graph: AnatomyGraph }) {
  const mode = useLumen((s) => s.mode)
  const fill = useLumen((s) => s.fill)
  const fly = useLumen((s) => s.fly)
  const data = useLumen((s) => s.data)
  const status = useLumen((s) => s.status)
  const flyS = useLumen((s) => s.flyS)
  const flyTotal = useLumen((s) => s.flyTotal)
  const flySegment = useLumen((s) => s.flySegment)
  const flyRadius = useLumen((s) => s.flyRadius)
  const flyRoute = useLumen((s) => s.flyRoute)
  const flyGap = useLumen((s) => s.flyGap)
  const embed = useApp((s) => s.embed)
  const isolated = useApp((s) => s.isolated)
  const lumen = useLumen.getState()
  // 隔离的集合变了，lumen=canal 可能要改回 lumen=1 / when the isolated set changes, lumen=canal may have to turn back into lumen=1
  useEffect(() => syncLumenUrl(), [isolated])
  if (!mode && !fly) return null
  const kinds = new Set(data ? [...data.origin.values()].map((o) => o.kind) : [])
  const none = !!data && data.derived.length === 0
  const seg = flySegment ? graph.part(flySegment) : undefined
  const segName = seg ? graph.partName(seg) : null
  const routes = data ? routesOf(graph, data) : []
  const route = routes.find((r) => r.key === (flyRoute ?? CANAL_ROUTE)) ?? routes[0]
  const segments = route?.parts ?? data?.path?.canal ?? []
  const nameOf = (id: string): string => {
    const p = graph.part(id)
    return p ? graph.partName(p).primary : id
  }
  const routeTitle = (key: string, parts: readonly string[]): { zh: string; en: string } =>
    key === CANAL_ROUTE ? { zh: '消化道：口 → 肛门', en: 'Alimentary canal: mouth to anus' } : { zh: parts.map(nameOf).join(' → '), en: parts.map((id) => graph.part(id)?.name ?? id).join(' → ') }
  const diameter = flyRadius * 2000
  return (
    <>
      {!fly && (
        <div className="lumen-legend" role="note" aria-label="腔的图例 / lumina legend">
          <strong>
            腔 <span className="en">Lumina</span>
          </strong>
          <ul className="lumen-keys">
            {KINDS.filter((k) => kinds.has(k.kind)).map((k) => (
              <li key={k.kind}>
                <span className="swatch" style={{ background: k.color }} />
                {k.zh} <span className="en">{k.en}</span>
              </li>
            ))}
          </ul>
          {none ? (
            <p className="lumen-warn">
              {LUMEN_FEMALE_NOTE.zh} <span className="en">{LUMEN_FEMALE_NOTE.en}</span>
            </p>
          ) : (
            LUMEN_STATEMENT.map((x) => (
              <p key={x.en}>
                {x.zh} <span className="en">{x.en}</span>
              </p>
            ))
          )}
          {status === 'loading' && <p>加载腔的数据… Loading…</p>}
        </div>
      )}
      {fly && (
        <div className="lumen-fly" role="group" aria-label="内镜漫游 / fly-through">
          <div className="lumen-fly-where">
            <strong>{segName ? segName.primary : '内镜漫游'}</strong> <span className="en">{seg ? seg.name : 'Fly-through'}</span>
            <span className="mono">
              {flyTotal > 0 ? `${Math.round(flyS * 1000)} / ${Math.round(flyTotal * 1000)} mm` : status === 'error' ? '没有数据 no data' : '加载中… loading…'}
              {flyGap ? ' · 段间空隙 gap between segments' : flyRadius > 0 ? ` · ⌀ ${diameter < 10 ? diameter.toFixed(1) : diameter.toFixed(0)} mm` : ''}
            </span>
          </div>
          <div className="lumen-fly-track" title="沿路线的位置（毫米）/ position along the route (mm)">
            <input type="range" min={0} max={Math.max(1, Math.round(flyTotal * 1000))} step={1} value={Math.round(flyS * 1000)} aria-label="漫游位置（毫米）/ fly-through position (mm)" onChange={(e) => lumen.seekFly(Number(e.target.value) / 1000)} />
          </div>
          <div className="lumen-fly-buttons">
            <button className={`tool-btn${fly.playing ? ' on' : ''}`} aria-pressed={fly.playing} onClick={() => lumen.setFly({ playing: !fly.playing })}>
              {fly.playing ? '暂停' : '播放'} <span className="en">{fly.playing ? 'Pause' : 'Play'}</span>
            </button>
            <button className={`tool-btn${fly.reverse ? ' on' : ''}`} aria-pressed={fly.reverse} onClick={() => lumen.setFly({ reverse: !fly.reverse })} title="反向：朝路线的起点走（消化道是从肛门往口），朝行进方向看 / reverse: back towards the route's start (anus to mouth on the canal), looking the way of travel">
              反向 <span className="en">Reverse</span>
            </button>
            <select className="tool-btn" value={fly.speed} aria-label="速度 / speed" onChange={(e) => lumen.setFly({ speed: Number(e.target.value) })}>
              {FLY_SPEEDS.map((x) => (
                <option key={x} value={x}>
                  {x}×（{Math.round(x * FLY_SPEED * 1000)} mm/s）
                </option>
              ))}
            </select>
            {routes.length > 1 && (
              <select className="tool-btn" value={route?.key ?? ''} aria-label="路线 / route" title={route ? `${routeTitle(route.key, route.parts).zh} / ${routeTitle(route.key, route.parts).en}` : undefined} onChange={(e) => e.target.value && lumen.startFly(e.target.value, e.target.value)}>
                {routes.map((r) => (
                  <option key={r.key} value={r.key}>
                    {routeTitle(r.key, r.parts).zh}
                  </option>
                ))}
              </select>
            )}
            <select className="tool-btn" value={flySegment ?? ''} aria-label="跳到某一段 / jump to a segment" onChange={(e) => e.target.value && lumen.startFly(e.target.value, route?.key ?? null)}>
              {segments.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </select>
            <button className="tool-btn" onClick={() => lumen.stopFly()}>
              退出 <span className="en">Leave</span>
            </button>
          </div>
          <p className="lumen-fly-rule">
            {FLY_RULE.zh} <span className="en">{FLY_RULE.en}</span>
          </p>
        </div>
      )}
      {embed && !fly && !none && (
        <div className="lumen-embed-fill">
          <label className="embed-slider" title="充盈：0 静止，1 壁允许的最大；壁不随充盈移动 / filling: 0 resting, 1 as full as the wall allows; walls do not move">
            <span>充盈 {fill === 0 ? '静止 rest' : fill.toFixed(2)}</span>
            <input type="range" min={0} max={1} step={0.01} value={fill} aria-label="充盈 / filling" onChange={(e) => lumen.setFill(Number(e.target.value))} />
          </label>
        </div>
      )}
    </>
  )
}
