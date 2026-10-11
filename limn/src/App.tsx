import { useEffect, useState } from 'react'
import * as api from './api'
import { refine } from './refine/loop'
import { download, renderFigure } from './render/export'
import { placedAtomCount } from './scene/build'
import { CATALOG, useStore } from './state/store'
import neuro from '../data/neuro.json'
import neurons from '../data/neurons.json'
import cells from '../data/cells.json'
import { TIER_LABEL } from './scene/spec'
import { entityLch } from './style/assign'
import { COLOR_MODE_LABEL, COLOR_MODES, confidenceLch, domainLch, domainsOf, pathogenicityLch, SITE_LCH, type ColorMode } from './style/annotate'
import { hex, oklch } from './style/oklab'
import { ROLE_LABEL, ROLES, TONE_MOLECULE, type Role } from './style/palettes'
import { Stage, stage } from './ui/Stage'

/** 嵌入模式下不带参数打开时画的模型 / the model drawn when embed mode is opened with no parameters */
const DEFAULT_MODEL = 'sars-cov-2-virion'

function Slider(p: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="row">
      <label>{p.label}</label>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <output>{p.value}</output>
    </div>
  )
}

/** 某期刊最近发布的结构，按论文归并；点一个结构就画它 / structures recently released for a journal, grouped by paper; click one to draw it */
function Recent({ disabled }: { disabled: boolean }) {
  const loadId = useStore((s) => s.loadId)
  const [journal, setJournal] = useState('Nature')
  const [days, setDays] = useState(90)
  const [data, setData] = useState<{ journals: string[]; total: number; entries: api.Released[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setData(null)
    setError('')
    api.recent(journal, days).then((d) => live && setData(d), (e) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [journal, days])
  // 同一篇论文的结构排在一起 / entries of one paper are listed together
  const papers = new Map<string, api.Released[]>()
  for (const e of data?.entries ?? []) {
    const key = e.citation?.doi || e.citation?.title || e.id
    papers.set(key, [...(papers.get(key) ?? []), e])
  }
  return (
    <div className="recent">
      <div className="row">
        <select value={journal} onChange={(e) => setJournal(e.target.value)} style={{ flex: 1 }}>
          {(data?.journals ?? [journal]).map((j) => (
            <option key={j} value={j}>{j}</option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={30}>近 30 天</option>
          <option value={90}>近 90 天</option>
          <option value={365}>近一年</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">正在查询 RCSB…</div>}
      {data && (
        <div className="muted">
          {data.total} 个结构{data.total > data.entries.length && `，显示最新的 ${data.entries.length} 个`}；按发布日期排序。
        </div>
      )}
      {[...papers.values()].map((list) => (
        <div className="paper-group" key={list[0]!.id}>
          <div>{list[0]!.citation?.title ?? list[0]!.title}</div>
          <div className="muted">
            {list[0]!.citation?.authors[0]}
            {(list[0]!.citation?.authors.length ?? 0) > 1 && ' 等'} · {list[0]!.released}
          </div>
          <div className="ids">
            {list.slice(0, 8).map((e) => (
              <button key={e.id} disabled={disabled} title={`${e.title}\n${e.method}${e.resolution ? `, ${e.resolution.toFixed(1)} Å` : ''}, ${e.atoms.toLocaleString()} 原子`} onClick={() => void loadId(e.id)}>
                {e.id}
              </button>
            ))}
            {list.length > 8 && <span className="muted">+{list.length - 8}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

const sw = (lch: [number, number, number]) => <span className="swatch" style={{ background: hex(oklch(...lch)), display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} />

/** 按残基上色时的图例：颜色各代表什么，数据从哪来 / the legend for per-residue colouring: what each colour means and where the data is from */
function Legend() {
  const s = useStore()
  const mode = s.colorings[0]?.mode ?? 'role'
  if (mode === 'role') return null
  if (mode === 'confidence') {
    const any = s.panels.some((p) => p.mol.confidence)
    return (
      <div className="muted legend">
        {any ? (
          <>
            {sw(confidenceLch(95))}很高（≥90） {sw(confidenceLch(80))}较高（70–90） {sw(confidenceLch(60))}低（50–70）
            <br />
            pLDDT 是 AlphaFold 对每个残基位置的置信度；低于 50 的没有画。
          </>
        ) : (
          '置信度只有预测模型才有；这是实验结构，颜色不变。'
        )}
      </div>
    )
  }
  const proteins = s.panels.flatMap((p) => Object.values(p.annotation?.proteins ?? {}))
  if (proteins.length === 0) return <div className="muted legend">没有查到这个结构的注释（或本地服务没有启动），颜色不变。</div>
  if (mode === 'domains')
    return (
      <div className="muted legend">
        {proteins.map((p) => (
          <div key={p.accession}>
            <b>{p.name}</b>（UniProt {p.accession}）
            {domainsOf(p).length === 0 && ' 没有标注结构域'}
            {domainsOf(p).map((d, k) => (
              <div key={k}>{sw(domainLch(k))}{d.name} {d.start}–{d.end}</div>
            ))}
          </div>
        ))}
      </div>
    )
  if (mode === 'sites')
    return (
      <div className="muted legend">
        {sw(SITE_LCH.active)}活性位点 {sw(SITE_LCH.binding)}结合位点 {sw(SITE_LCH.site)}其他位点
        {proteins.map((p) => (
          <div key={p.accession}>
            <b>{p.name}</b>：{p.features.filter((f) => f.kind !== 'domain').slice(0, 12).map((f) => `${f.name} ${f.start}${f.end > f.start ? '–' + f.end : ''}`).join('；') || '没有标注位点'}
          </div>
        ))}
        <div>来源：UniProt。</div>
      </div>
    )
  return (
    <div className="muted legend">
      {sw(pathogenicityLch(0.05))}多半无害 {sw(pathogenicityLch(0.5))}不确定 {sw(pathogenicityLch(0.95))}多半致病
      <br />
      每个位置上 19 种氨基酸替换的 AlphaMissense 预测值的平均。这是预测，不是临床结论。
      {proteins.some((p) => !p.pathogenicity) && ' 有的蛋白没有这项数据（只覆盖人类蛋白），颜色不变。'}
    </div>
  )
}

export function App() {
  const s = useStore()
  const params = new URLSearchParams(location.search)
  const [mode, setMode] = useState<'topic' | 'id' | 'model' | 'recent'>(params.get('id') ? 'id' : params.get('model') ? 'model' : 'topic')
  const [topic, setTopic] = useState(params.get('topic') ?? '')
  const [id, setId] = useState(params.get('id') ?? '')
  const [feedback, setFeedback] = useState('')
  const [exporting, setExporting] = useState(false)
  const [server, setServer] = useState<{ ok: boolean; claude: boolean } | null>(null)

  // 嵌入模式（?embed=1）：只留画面和几个必要的控件；不带参数时给一个默认画面
  // embed mode (?embed=1): the stage and a few essential controls only; with no parameters, a default scene
  const embed = params.get('embed') === '1'

  useEffect(() => {
    void api.health().then(setServer)
    if (embed && !params.get('model') && !params.get('id') && !params.get('topic') && !params.get('neuron') && !params.get('cell')) void s.loadCatalog(DEFAULT_MODEL)
    else if (params.get('neuron')) void s.loadNeuron(params.get('neuron')!)
    else if (params.get('cell')) void s.loadCell(params.get('cell')!)
    else if (params.get('model')) void s.loadCatalog(params.get('model')!)
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

  if (embed) {
    const src = s.panels[0]?.spec.source
    return (
      <div className="app embed">
        {/* 标题条单独占一行，不压在画面上 / the title strip has a row of its own and never sits on the picture */}
        <div className="embed-info">
          {s.spec && s.panels.length > 0 && (
            <>
              <b title={s.spec.title}>{s.spec.title}</b>
              {src && <span className="muted" title={[src.attribution, src.licence].filter(Boolean).join(' · ')}>{[src.kind === 'pdb' ? `PDB ${src.id}` : '', src.attribution, src.licence].filter(Boolean).join(' · ')}</span>}
              {!s.spec.landscape && s.spec.kind !== 'neuron' && (
                <label className="embed-cut">
                  剖开 / Cut
                  <input type="range" min={0} max={0.9} step={0.01} value={s.cut} onChange={(e) => s.setLook({ cut: Number(e.target.value) })} />
                </label>
              )}
            </>
          )}
        </div>
        <Stage />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="side">
        <h1>limn</h1>
        <div className="tabs">
          <button className={mode === 'topic' ? 'on' : ''} onClick={() => setMode('topic')}>按主题</button>
          <button className={mode === 'model' ? 'on' : ''} onClick={() => setMode('model')}>现成模型</button>
          <button className={mode === 'id' ? 'on' : ''} onClick={() => setMode('id')}>按编号</button>
          <button className={mode === 'recent' ? 'on' : ''} onClick={() => setMode('recent')}>最新发表</button>
        </div>
        {mode === 'topic' ? (
          <form onSubmit={(e) => (e.preventDefault(), void s.resolveTopic(topic))}>
            <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="一个病毒、基因、蛋白或机理，例如：CRISPR-Cas9 切割 DNA" />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" disabled={working || !canAsk || !topic.trim()}>生成</button>
              {server && !canAsk && <span className="muted">{server.ok ? '本机没有找到 claude 命令' : '本地服务未启动（bun run dev）'}</span>}
            </div>
          </form>
        ) : mode === 'recent' ? (
          <Recent disabled={working} />
        ) : mode === 'model' ? (
          <div className="catalog">
            {CATALOG.map((m) => (
              <button key={m.id} disabled={working} className={s.spec?.topic === m.title ? 'on' : ''} title={m.titleEn} onClick={() => void s.loadCatalog(m.id)}>
                {m.title}
              </button>
            ))}
            <h2>整个细胞（电镜）</h2>
            {cells.cells.map((c) => (
              <button key={c.id} disabled={working} title={c.titleEn} onClick={() => void s.loadCell(c.id)}>
                {c.title}
              </button>
            ))}
            <h2>神经元的形态</h2>
            {neurons.neurons.map((n) => (
              <button key={n.id} disabled={working} title={`${n.titleEn} (NeuroMorpho.Org: ${n.name})`} onClick={() => void s.loadNeuron(n.id)}>
                {n.title}
              </button>
            ))}
            <h2>神经系统的分子</h2>
            {neuro.groups.map((g) => (
              <details key={g.id}>
                <summary title={g.titleEn}>{g.title}</summary>
                {g.entries.map((e) => (
                  <button key={e.id} disabled={working} title={`${e.titleEn} (PDB ${e.id})`} onClick={() => void s.loadId(e.id, e.title)}>
                    {e.title}
                  </button>
                ))}
              </details>
            ))}
          </div>
        ) : (
          <form className="row" onSubmit={(e) => (e.preventDefault(), void s.loadId(id))}>
            <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="2hhb、AF-P04637 或 EMD-1080" spellCheck={false} />
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
                  {p.paper && (
                    <div className="muted paper">
                      {p.paper.citation.title}
                      <br />
                      {p.paper.citation.authors.slice(0, 3).join(', ')}
                      {p.paper.citation.authors.length > 3 && ' 等'} · <i>{p.paper.citation.journal}</i> {p.paper.citation.year}
                      {p.paper.citation.doi && (
                        <>
                          {' · '}
                          <a href={`https://doi.org/${p.paper.citation.doi}`} target="_blank" rel="noreferrer">论文</a>
                        </>
                      )}
                      {p.paper.open && p.paper.abstract && (
                        <details>
                          <summary>摘要（开放获取，{p.paper.licence}）</summary>
                          {p.paper.abstract}
                        </details>
                      )}
                    </div>
                  )}
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
                          {ing.abundance}（{ing.tier === 'curated' ? '实测数据' : '估计'}） → {ing.copies} 个{placed !== undefined && placed < ing.copies ? `，放下了 ${placed} 个` : ''}
                        </div>
                      )
                    })()}
                  {p.membrane && <div className="muted">膜内取向：{p.membrane.source === 'OPM' ? `OPM（${p.membrane.matched} 个残基叠合，偏差 ${p.membrane.rmsd.toFixed(2)} Å）` : `PDBTM，朝向按 UniProt 拓扑注释（${p.membrane.matched} 个残基）`}</div>}
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
              {!s.spec.landscape && !s.spec.mesoscale && s.spec.kind !== 'neuron' && (
                <div style={{ margin: '6px 0' }}>
                  <div className="row">
                    <label>上色</label>
                    <select value={s.colorings[0]?.mode ?? 'role'} disabled={working} style={{ flex: 1 }} onChange={(e) => void s.setColorMode(e.target.value as ColorMode)}>
                      {COLOR_MODES.map((m) => (
                        <option key={m} value={m}>{COLOR_MODE_LABEL[m]}</option>
                      ))}
                    </select>
                  </div>
                  <Legend />
                </div>
              )}
              {s.spec.kind !== 'neuron' && <div className="muted">由真实原子坐标绘制；未画出水和氢原子。{s.panels.length > 1 && !s.spec.landscape && '各面板比例相同。'}</div>}
              {s.spec.landscape && (
                <div className="row" style={{ margin: '6px 0' }}>
                  <button disabled={working} onClick={() => s.repack()}>重新随机排布</button>
                  <span className="muted">
                    {s.spec.landscape.width / 10}×{s.spec.landscape.height / 10} nm，厚 {s.spec.landscape.depth / 10} nm
                    {s.dnaPairs > 0 && `；DNA ${s.dnaPairs.toLocaleString()} 个碱基对（程序生成）`}
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
