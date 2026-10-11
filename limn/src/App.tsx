import { useEffect, useState } from 'react'
import * as api from './api'
import { refine } from './refine/loop'
import { download, renderFigure } from './render/export'
import { placedAtomCount } from './scene/build'
import { CATALOG, useStore } from './state/store'
import { TIER_LABEL } from './scene/spec'
import { entityLch } from './style/assign'
import { hex, oklch } from './style/oklab'
import { ROLE_LABEL, ROLES, TONE_MOLECULE, type Role } from './style/palettes'
import { Stage, stage } from './ui/Stage'

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="row">
      <label>{p.label}</label>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <output>{p.value}</output>
    </div>
  )
}

export function App() {
  const s = useStore()
  const params = new URLSearchParams(location.search)
  const [mode, setMode] = useState<'topic' | 'id' | 'model'>(params.get('id') ? 'id' : params.get('model') ? 'model' : 'topic')
  const [topic, setTopic] = useState(params.get('topic') ?? '')
  const [id, setId] = useState(params.get('id') ?? '')
  const [feedback, setFeedback] = useState('')
  const [exporting, setExporting] = useState(false)
  const [server, setServer] = useState<{ ok: boolean; claude: boolean } | null>(null)

  useEffect(() => {
    void api.health().then(setServer)
    if (params.get('model')) void s.loadCatalog(params.get('model')!)
    else if (params.get('id')) void s.loadId(params.get('id')!)
    else if (params.get('topic')) void s.resolveTopic(params.get('topic')!)
  }, [])

  const save = async (longSide: number) => {
    const r = stage.renderer
    if (!r || s.panels.length === 0) return
    setExporting(true)
    try {
      const look = s.getLook()
      const name = s.panels.map((p) => p.mol.id).join('-')
      download(await renderFigure(r, look, longSide).canvas.convertToBlob({ type: 'image/png' }), `${name}-${longSide}.png`)
      // 离屏渲染按它自己的画幅排布了面板
      useStore.setState((x) => ({ drawRev: x.drawRev + 1 })) // the off-screen render laid the panels out for its own frame
    } finally {
      setExporting(false)
    }
  }

  const canAsk = server?.ok && server.claude
  const working = !!s.busy || !!s.refining

  return (
    <div className="app">
      <div className="side">
        <h1>limn</h1>
        <div className="tabs">
          <button className={mode === 'topic' ? 'on' : ''} onClick={() => setMode('topic')}>按主题</button>
          <button className={mode === 'model' ? 'on' : ''} onClick={() => setMode('model')}>现成模型</button>
          <button className={mode === 'id' ? 'on' : ''} onClick={() => setMode('id')}>PDB 编号</button>
        </div>
        {mode === 'topic' ? (
          <form onSubmit={(e) => (e.preventDefault(), void s.resolveTopic(topic))}>
            <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="一个病毒、基因、蛋白或机理，例如：CRISPR-Cas9 切割 DNA" />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" disabled={working || !canAsk || !topic.trim()}>生成</button>
              {server && !canAsk && <span className="muted">{server.ok ? '本机没有找到 claude 命令' : '本地服务未启动（bun run dev）'}</span>}
            </div>
          </form>
        ) : mode === 'model' ? (
          <div className="catalog">
            {CATALOG.map((m) => (
              <button key={m.id} disabled={working} className={s.spec?.topic === m.title ? 'on' : ''} title={m.titleEn} onClick={() => void s.loadCatalog(m.id)}>
                {m.title}
              </button>
            ))}
          </div>
        ) : (
          <form className="row" onSubmit={(e) => (e.preventDefault(), void s.loadId(id))}>
            <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="例如 2hhb" spellCheck={false} />
            <button className="primary" disabled={working}>载入</button>
          </form>
        )}
        {s.error && <div className="error">{s.error}</div>}

        {s.spec && s.panels.length > 0 && (
          <>
            <div className="caption">
              <b>{s.spec.title}</b>
              {s.spec.caption && <div>{s.spec.caption}</div>}
            </div>

            <div>
              <h2>数据来源</h2>
              {s.panels.map((p, pi) => (
                <div className="source" key={pi}>
                  <div>
                    <b>{p.spec.source.id}</b> {p.spec.label !== p.spec.source.id && p.spec.label}
                  </div>
                  <div className="muted">
                    {[p.spec.source.method, p.spec.source.resolution ? `${p.spec.source.resolution.toFixed(2)} Å` : '', p.spec.source.year].filter(Boolean).join(' · ') || p.spec.source.title}
                  </div>
                  {p.spec.reason && <div className="muted">{p.spec.reason}</div>}
                  {p.spec.source.attribution && (
                    <div className="muted">
                      {p.spec.source.tier && `${TIER_LABEL[p.spec.source.tier]} · `}
                      {p.spec.source.attribution}
                      <br />
                      {p.spec.source.citation}
                      <br />
                      许可：{p.spec.source.licence}
                      {p.spec.source.link && (
                        <>
                          {' · '}
                          <a href={p.spec.source.link} target="_blank" rel="noreferrer">来源</a>
                        </>
                      )}
                    </div>
                  )}
                  {s.spec!.landscape &&
                    (() => {
                      const ing = s.spec!.landscape!.ingredients.find((x) => x.panel === pi)
                      const placed = s.placed[pi]
                      if (!ing) return null
                      return (
                        <div className="muted">
                          {ing.abundance}（估计） → {ing.copies} 个{placed !== undefined && placed < ing.copies ? `，放下了 ${placed} 个` : ''}
                        </div>
                      )
                    })()}
                  <div className="row" style={{ margin: '4px 0' }}>
                    <select value={p.spec.assembly} onChange={(e) => s.setAssembly(pi, e.target.value)} style={{ flex: 1 }}>
                      {p.mol.assemblies.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.id === 'asym' ? '非对称单元' : `组装体 ${a.id}`} · {placedAtomCount(p.mol, a.id).toLocaleString()} 原子
                        </option>
                      ))}
                    </select>
                  </div>
                  {p.mol.entities.map((e, i) => (
                    <div className="entity" key={e.id} title={e.description}>
                      <div className="swatch" style={{ background: s.colorings[pi] ? hex(oklch(...entityLch(s.colorings[pi]!, i, TONE_MOLECULE))) : '#ccc' }} />
                      <span>{p.spec.entities.find((x) => x.entityId === e.id)?.name || e.description || e.kind}</span>
                      <select value={s.colorings[pi]?.roles[i]} onChange={(ev) => s.setRole(pi, i, ev.target.value as Role)}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              ))}
              <div className="muted">由真实原子坐标绘制；未画出水和氢原子。{s.panels.length > 1 && !s.spec.landscape && '各面板比例相同。'}</div>
              {s.spec.landscape && (
                <div className="row" style={{ margin: '6px 0' }}>
                  <button disabled={working} onClick={() => s.repack()}>重新随机排布</button>
                  <span className="muted">
                    {s.spec.landscape.width / 10}×{s.spec.landscape.height / 10} nm，厚 {s.spec.landscape.depth / 10} nm
                  </span>
                </div>
              )}
              {s.spec.notes.length > 0 && (
                <ul className="notes">
                  {s.spec.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h2>看图精修</h2>
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="可选：你的要求，例如“让 DNA 更突出”“转到能看见结合界面的角度”" />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="primary" disabled={working || !canAsk} onClick={() => void refine({ maxRounds: 3, feedback, chooseView: s.rounds.length === 0 && !feedback.trim() && !s.spec!.landscape })}>
                  {s.refining ? '精修中…' : '让 Claude 看图并修改'}
                </button>
              </div>
              {s.refining && <div className="muted" style={{ marginTop: 6 }}>{s.refining}</div>}
              {s.rounds.length > 0 && (
                <div className="rounds" style={{ marginTop: 8 }}>
                  {s.rounds.map((r, i) => (
                    <button className="round" key={i} title="回到这一版" onClick={() => s.setLook(structuredClone(r.look))}>
                      <img src={r.image} alt="" />
                      <div>
                        <span className="score">{r.overall === null ? '选角度' : `${r.overall.toFixed(1)} 分`}</span>
                        <p>{r.comment}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2>线条与阴影</h2>
              {!s.spec.landscape && <Slider label="剖开" value={s.cut} min={0} max={0.9} step={0.01} onChange={(v) => s.setLook({ cut: v })} />}
              <Slider label="线宽" value={s.style.lineWidth} min={0.5} max={3} step={0.1} onChange={(v) => s.setStyle((x) => (x.lineWidth = v))} />
              <Slider label="内部轮廓" value={s.style.contour.diffMax} min={1} max={60} step={0.5} onChange={(v) => s.setStyle((x) => (x.contour.diffMax = v))} />
              <Slider label="阴影强度" value={s.style.shadow.strength} min={0} max={0.006} step={0.0001} onChange={(v) => s.setStyle((x) => (x.shadow.strength = v))} />
              <Slider label="最暗" value={s.style.shadow.floor} min={0.4} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.shadow.floor = v))} />
              <Slider label="远处淡出" value={s.style.fog.back} min={0.4} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.fog.back = v))} />
            </div>

            <div>
              <h2>导出</h2>
              <div className="row">
                <button disabled={exporting} onClick={() => void save(2400)}>PNG 2400</button>
                <button disabled={exporting} onClick={() => void save(4800)}>PNG 4800</button>
                <button onClick={() => s.resetView()}>重置视角</button>
              </div>
            </div>
          </>
        )}
        <div className="muted" style={{ marginTop: 'auto' }}>
          {s.spec?.landscape ? '拖动平移 · 滚轮缩放' : '拖动旋转 · 滚轮缩放 · Shift 拖动平移'}
          <br />
          画法致敬 David S. Goodsell；数据来源和许可见上方各条。
        </div>
      </div>
      <Stage />
    </div>
  )
}
