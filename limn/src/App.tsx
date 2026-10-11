import { useEffect, useState } from 'react'
import * as api from './api'
import { refine } from './refine/loop'
import { download, renderFigure } from './render/export'
import { placedAtomCount } from './scene/build'
import { CATALOG, useStore } from './state/store'
import neuro from '../data/neuro.json'
import neurons from '../data/neurons.json'
import cells from '../data/cells.json'
import { colorModeLabel, noteText, pick, roleLabel, t, tierLabel, shown } from './i18n'
import { entityLch } from './style/assign'
import { COLOR_MODES, confidenceLch, domainLch, domainsOf, pathogenicityLch, SITE_LCH, type ColorMode } from './style/annotate'
import { hex, oklch } from './style/oklab'
import { ROLES, TONE_MOLECULE, type Role } from './style/palettes'
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
  useStore((s) => s.lang) // 换语言时重新渲染 / re-render when the language changes
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
          <option value={30}>{t('recent.days30')}</option>
          <option value={90}>{t('recent.days90')}</option>
          <option value={365}>{t('recent.year')}</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="muted">{t('recent.loading')}</div>}
      {data && (
        <div className="muted">
          {data.total > data.entries.length ? t('recent.countShown', { total: data.total, shown: data.entries.length }) : t('recent.count', { total: data.total })}
        </div>
      )}
      {[...papers.values()].map((list) => (
        <div className="paper-group" key={list[0]!.id}>
          <div>{list[0]!.citation?.title ?? list[0]!.title}</div>
          <div className="muted">
            {list[0]!.citation?.authors[0]}
            {(list[0]!.citation?.authors.length ?? 0) > 1 && t('etAl')} · {list[0]!.released}
          </div>
          <div className="ids">
            {list.slice(0, 8).map((e) => (
              <button key={e.id} disabled={disabled} title={`${e.title}\n${e.method}${e.resolution ? `, ${e.resolution.toFixed(1)} Å` : ''}, ${t('unit.atoms', { n: e.atoms.toLocaleString() })}`} onClick={() => void loadId(e.id)}>
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

/** 成对字段里另一种语言的那个，用作悬停提示 / of a pair of fields, the one in the other language, for a tooltip */
const other = (zh: string, en: string) => pick(en, zh)

/** 检索 NeuroMorpho.Org 并画出结果 / search NeuroMorpho.Org and draw what is found */
function NeuronSearch({ disabled }: { disabled: boolean }) {
  const loadNeurons = useStore((s) => s.loadNeurons)
  useStore((s) => s.lang)
  const [q, setQ] = useState({ species: '', region: '', cellType: '' })
  const [res, setRes] = useState<{ total: number; hits: api.NeuronHit[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<api.NeuronHit[]>([])
  const go = async () => {
    setBusy(true)
    setRes(await api.neurons(q))
    setBusy(false)
  }
  const add = (h: api.NeuronHit) => {
    const next = [...picked.filter((x) => x.name !== h.name), h].slice(-4)
    setPicked(next)
    void loadNeurons(next)
  }
  return (
    <details className="neuron-search">
      <summary>{t('neurons.search')}</summary>
      <form onSubmit={(e) => (e.preventDefault(), void go())}>
        <input type="text" value={q.species} placeholder={t('neurons.species')} onChange={(e) => setQ({ ...q, species: e.target.value })} />
        <input type="text" value={q.region} placeholder={t('neurons.region')} onChange={(e) => setQ({ ...q, region: e.target.value })} />
        <input type="text" value={q.cellType} placeholder={t('neurons.cellType')} onChange={(e) => setQ({ ...q, cellType: e.target.value })} />
        <button className="primary" disabled={busy || !(q.species || q.region || q.cellType).trim()}>{t('neurons.go')}</button>
      </form>
      {res && <div className="muted">{res.hits.length ? t('neurons.total', { n: res.total, shown: res.hits.length }) : t('neurons.noHits')}</div>}
      {res?.hits.map((h) => (
        <div className="row" key={h.name}>
          <button style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} disabled={disabled} title={`${h.species} · ${h.region} · ${h.cellType} · ${h.domain}`} onClick={() => (setPicked([h]), void loadNeurons([h]))}>
            {h.name}
          </button>
          <button disabled={disabled} onClick={() => add(h)}>+</button>
        </div>
      ))}
    </details>
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
            {sw(confidenceLch(95))}{t('legend.confidence.veryHigh')} {sw(confidenceLch(80))}{t('legend.confidence.high')} {sw(confidenceLch(60))}{t('legend.confidence.low')}
            <br />
            {t('legend.confidence.about')}
          </>
        ) : (
          t('legend.confidence.none')
        )}
      </div>
    )
  }
  const proteins = s.panels.flatMap((p) => Object.values(p.annotation?.proteins ?? {}))
  if (proteins.length === 0) return <div className="muted legend">{t('legend.noAnnotation')}</div>
  if (mode === 'domains')
    return (
      <div className="muted legend">
        {proteins.map((p) => (
          <div key={p.accession}>
            <b>{p.name}</b>{t('legend.uniprot', { accession: p.accession })}
            {domainsOf(p).length === 0 && t('legend.noDomains')}
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
        {sw(SITE_LCH.active)}{t('legend.site.active')} {sw(SITE_LCH.binding)}{t('legend.site.binding')} {sw(SITE_LCH.site)}{t('legend.site.other')}
        {proteins.map((p) => (
          <div key={p.accession}>
            <b>{p.name}</b>{t('punct.colon')}{p.features.filter((f) => f.kind !== 'domain').slice(0, 12).map((f) => `${f.name} ${f.start}${f.end > f.start ? '–' + f.end : ''}`).join(t('punct.semicolon')) || t('legend.noSites')}
          </div>
        ))}
        <div>{t('legend.sourceUniprot')}</div>
      </div>
    )
  return (
    <div className="muted legend">
      {sw(pathogenicityLch(0.05))}{t('legend.path.benign')} {sw(pathogenicityLch(0.5))}{t('legend.path.uncertain')} {sw(pathogenicityLch(0.95))}{t('legend.path.pathogenic')}
      <br />
      {t('legend.path.about')}
      {proteins.some((p) => !p.pathogenicity) && t('legend.path.missing')}
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
    const title = s.spec ? pick(s.spec.title, s.spec.titleEn) : ''
    const credit = src ? [pick(src.attribution, src.attributionEn), pick(src.licence, src.licenceEn)] : []
    return (
      <div className="app embed">
        {/* 标题条单独占一行，不压在画面上 / the title strip has a row of its own and never sits on the picture */}
        <div className="embed-info">
          {s.spec && s.panels.length > 0 && (
            <>
              <b title={title}>{title}</b>
              {src && <span className="muted" title={credit.filter(Boolean).join(' · ')}>{[src.kind === 'pdb' ? `PDB ${src.id}` : '', ...credit].filter(Boolean).join(' · ')}</span>}
              {!s.spec.landscape && s.spec.kind !== 'neuron' && (
                <label className="embed-cut">
                  {t('look.cut')}
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
        <div className="side-head">
          <h1>limn</h1>
          {/* 按钮上写的是要换成的那种语言 / the button names the language it switches to */}
          <button className="lang" onClick={() => s.setLang(s.lang === 'zh' ? 'en' : 'zh')}>{t('lang.switch')}</button>
        </div>
        <div className="tabs">
          <button className={mode === 'topic' ? 'on' : ''} onClick={() => setMode('topic')}>{t('tab.topic')}</button>
          <button className={mode === 'model' ? 'on' : ''} onClick={() => setMode('model')}>{t('tab.model')}</button>
          <button className={mode === 'id' ? 'on' : ''} onClick={() => setMode('id')}>{t('tab.id')}</button>
          <button className={mode === 'recent' ? 'on' : ''} onClick={() => setMode('recent')}>{t('tab.recent')}</button>
        </div>
        {mode === 'topic' ? (
          <form onSubmit={(e) => (e.preventDefault(), void s.resolveTopic(topic))}>
            <textarea value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t('topic.placeholder')} />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" disabled={working || !canAsk || !topic.trim()}>{t('topic.submit')}</button>
              {server && !canAsk && <span className="muted">{server.ok ? t('server.noClaude') : t('server.down')}</span>}
            </div>
          </form>
        ) : mode === 'recent' ? (
          <Recent disabled={working} />
        ) : mode === 'model' ? (
          <div className="catalog">
            {/* 按钮上是当前语言的名字，悬停提示里是另一种语言的 / each button carries the name in the current language, and its tooltip the name in the other */}
            {CATALOG.map((m) => (
              <button key={m.id} disabled={working} className={s.spec?.topic === m.title ? 'on' : ''} title={other(m.title, m.titleEn)} onClick={() => void s.loadCatalog(m.id)}>
                {pick(m.title, m.titleEn)}
              </button>
            ))}
            <h2>{t('catalog.cells')}</h2>
            {cells.cells.map((c) => (
              <button key={c.id} disabled={working} title={other(c.title, c.titleEn)} onClick={() => void s.loadCell(c.id)}>
                {pick(c.title, c.titleEn)}
              </button>
            ))}
            <h2>{t('catalog.neurons')}</h2>
            {neurons.neurons.map((n) => (
              <button key={n.id} disabled={working} title={`${other(n.title, n.titleEn)} (NeuroMorpho.Org: ${n.name})`} onClick={() => void s.loadNeuron(n.id)}>
                {pick(n.title, n.titleEn)}
              </button>
            ))}
            <NeuronSearch disabled={working} />
            <h2>{t('catalog.neuro')}</h2>
            {neuro.groups.map((g) => (
              <details key={g.id}>
                <summary title={other(g.title, g.titleEn)}>{pick(g.title, g.titleEn)}</summary>
                {g.entries.map((e) => (
                  <button key={e.id} disabled={working} title={`${other(e.title, e.titleEn)} (PDB ${e.id})`} onClick={() => void s.loadId(e.id, e.title, e.titleEn)}>
                    {pick(e.title, e.titleEn)}
                  </button>
                ))}
              </details>
            ))}
          </div>
        ) : (
          <form className="row" onSubmit={(e) => (e.preventDefault(), void s.loadId(id))}>
            <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder={t('id.placeholder')} spellCheck={false} />
            <button className="primary" disabled={working}>{t('id.submit')}</button>
          </form>
        )}
        {s.error && <div className="error">{shown(s.error)}</div>}

        {s.spec && s.panels.length > 0 && (
          <>
            <div className="caption">
              <b>{pick(s.spec.title, s.spec.titleEn)}</b>
              {s.spec.caption && <div>{pick(s.spec.caption, s.spec.captionEn)}</div>}
            </div>

            <div>
              <h2>{t('section.sources')}</h2>
              {s.panels.map((p, pi) => (
                <div className="source" key={pi}>
                  <div>
                    <b>{p.spec.source.id}</b> {p.spec.label !== p.spec.source.id && pick(p.spec.label, p.spec.labelEn)}
                  </div>
                  <div className="muted">
                    {[pick(p.spec.source.method, p.spec.source.methodEn), p.spec.source.resolution ? `${p.spec.source.resolution.toFixed(2)} Å` : '', p.spec.source.year].filter(Boolean).join(' · ') || p.spec.source.title}
                  </div>
                  {p.spec.reason && <div className="muted">{p.spec.reason}</div>}
                  {p.paper && (
                    <div className="muted paper">
                      {p.paper.citation.title}
                      <br />
                      {p.paper.citation.authors.slice(0, 3).join(', ')}
                      {p.paper.citation.authors.length > 3 && t('etAl')} · <i>{p.paper.citation.journal}</i> {p.paper.citation.year}
                      {p.paper.citation.doi && (
                        <>
                          {' · '}
                          <a href={`https://doi.org/${p.paper.citation.doi}`} target="_blank" rel="noreferrer">{t('paper.link')}</a>
                        </>
                      )}
                      {p.paper.open && p.paper.abstract && (
                        <details>
                          <summary>{t('paper.abstract', { licence: p.paper.licence })}</summary>
                          {p.paper.abstract}
                        </details>
                      )}
                    </div>
                  )}
                  {p.spec.source.attribution && (
                    <div className="muted">
                      {p.spec.source.tier && `${tierLabel(p.spec.source.tier)} · `}
                      {pick(p.spec.source.attribution, p.spec.source.attributionEn)}
                      <br />
                      {p.spec.source.citation}
                      <br />
                      {t('source.licence', { licence: pick(p.spec.source.licence, p.spec.source.licenceEn) })}
                      {p.spec.source.link && (
                        <>
                          {' · '}
                          <a href={p.spec.source.link} target="_blank" rel="noreferrer">{t('source.link')}</a>
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
                          {t(placed !== undefined && placed < ing.copies ? 'ingredient.linePlaced' : 'ingredient.line', { abundance: noteText(ing.abundance), basis: t(ing.tier === 'curated' ? 'ingredient.measured' : 'ingredient.estimated'), copies: ing.copies, placed: placed ?? ing.copies })}
                        </div>
                      )
                    })()}
                  {p.membrane && <div className="muted">{p.membrane.source === 'OPM' ? t('membrane.opm', { matched: p.membrane.matched, rmsd: p.membrane.rmsd.toFixed(2) }) : t('membrane.pdbtm', { matched: p.membrane.matched })}</div>}
                  <div className="row" style={{ margin: '4px 0' }}>
                    <select value={p.spec.assembly} onChange={(e) => s.setAssembly(pi, e.target.value)} style={{ flex: 1 }}>
                      {p.mol.assemblies.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.id === 'asym' ? t('assembly.asym') : t('assembly.n', { id: a.id })} · {t('unit.atoms', { n: placedAtomCount(p.mol, a.id).toLocaleString() })}
                        </option>
                      ))}
                    </select>
                  </div>
                  {p.mol.entities.map((e, i) => {
                    // 有两种语言名字的实体（细胞器、神经元的各部分、密度图）只显示当前语言的
                    // entities named in both languages (organelles, parts of a neuron, a density map) show the current one only
                    const named = p.spec.entities.find((x) => x.entityId === e.id)
                    return (
                    <div className="entity" key={e.id} title={named?.nameEn ? pick(named.name, named.nameEn) : e.description}>
                      <div className="swatch" style={{ background: s.colorings[pi] ? hex(oklch(...entityLch(s.colorings[pi]!, i, TONE_MOLECULE))) : '#ccc' }} />
                      <span>{pick(named?.name, named?.nameEn) || e.description || e.kind}</span>
                      <select value={s.colorings[pi]?.roles[i]} onChange={(ev) => s.setRole(pi, i, ev.target.value as Role)}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{roleLabel(r)}</option>
                        ))}
                      </select>
                    </div>
                    )
                  })}
                </div>
              ))}
              {s.complexes && (
                <div className="complex-list">
                  <h2>{t('complexes.title')}</h2>
                  {s.complexes.length === 0 && <div className="muted">{t('complexes.none')}</div>}
                  {s.complexes.slice(0, 8).map((c) => (
                    <button key={c.id} disabled={working} title={c.id} onClick={() => void s.loadId(c.id, undefined, undefined, c.iptm)}>
                      {c.parts.map((p) => `${p.accession}${p.copies > 1 ? ' ×' + p.copies : ''}`).join(' + ')} · ipTM {c.iptm.toFixed(2)}
                    </button>
                  ))}
                </div>
              )}
              {!s.spec.landscape && !s.spec.mesoscale && s.spec.kind !== 'neuron' && (
                <div style={{ margin: '6px 0' }}>
                  <div className="row">
                    <label>{t('color.label')}</label>
                    <select value={s.colorings[0]?.mode ?? 'role'} disabled={working} style={{ flex: 1 }} onChange={(e) => void s.setColorMode(e.target.value as ColorMode)}>
                      {COLOR_MODES.map((m) => (
                        <option key={m} value={m}>{colorModeLabel(m)}</option>
                      ))}
                    </select>
                  </div>
                  <Legend />
                </div>
              )}
              {s.spec.kind !== 'neuron' && <div className="muted">{t('scene.realAtoms')}{s.panels.length > 1 && !s.spec.landscape && t('scene.sameScale')}</div>}
              {s.spec.landscape && (
                <div className="row" style={{ margin: '6px 0' }}>
                  <button disabled={working} onClick={() => s.repack()}>{t('landscape.repack')}</button>
                  <span className="muted">
                    {t('landscape.size', { w: s.spec.landscape.width / 10, h: s.spec.landscape.height / 10, d: s.spec.landscape.depth / 10 })}
                    {s.dnaPairs > 0 && t('landscape.dna', { pairs: s.dnaPairs.toLocaleString() })}
                  </span>
                </div>
              )}
              {s.spec.notes.length > 0 && (
                <ul className="notes">
                  {s.spec.notes.map((n, i) => (
                    <li key={i}>{noteText(n)}</li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h2>{t('refine.title')}</h2>
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder={t('refine.placeholder')} />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="primary" disabled={working || !canAsk} onClick={() => void refine({ maxRounds: 3, feedback, chooseView: s.rounds.length === 0 && !feedback.trim() && !s.spec!.landscape })}>
                  {s.refining ? t('refine.running') : t('refine.start')}
                </button>
              </div>
              {s.refining && <div className="muted" style={{ marginTop: 6 }}>{s.refining}</div>}
              {s.rounds.length > 0 && (
                <div className="rounds" style={{ marginTop: 8 }}>
                  {s.rounds.map((r, i) => (
                    <button className="round" key={i} title={t('refine.back')} onClick={() => s.setLook(structuredClone(r.look))}>
                      <img src={r.image} alt="" />
                      <div>
                        <span className="score">{r.overall === null ? t('refine.viewRound') : t('refine.score', { score: r.overall.toFixed(1) })}</span>
                        {r.verdict && <span className={'verdict' + (r.kept ? ' kept' : '')} title={r.reason}> · {t(r.kept ? 'refine.kept' : r.verdict === 'worse' ? 'refine.undoneWorse' : 'refine.undoneSame')}</span>}
                        <p>{r.comment}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2>{t('style.title')}</h2>
              {!s.spec.landscape && <Slider label={t('look.cut')} value={s.cut} min={0} max={0.9} step={0.01} onChange={(v) => s.setLook({ cut: v })} />}
              <Slider label={t('style.lineWidth')} value={s.style.lineWidth} min={0.5} max={3} step={0.1} onChange={(v) => s.setStyle((x) => (x.lineWidth = v))} />
              <Slider label={t('style.innerLines')} value={s.style.contour.diffMax} min={1} max={60} step={0.5} onChange={(v) => s.setStyle((x) => (x.contour.diffMax = v))} />
              <Slider label={t('style.shadow')} value={s.style.shadow.strength} min={0} max={0.006} step={0.0001} onChange={(v) => s.setStyle((x) => (x.shadow.strength = v))} />
              <Slider label={t('style.darkest')} value={s.style.shadow.floor} min={0.4} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.shadow.floor = v))} />
              <Slider label={t('style.fog')} value={s.style.fog.back} min={0.4} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.fog.back = v))} />
            </div>

            <div>
              <h2>{t('export.title')}</h2>
              <div className="row">
                <button disabled={exporting} onClick={() => void save(2400)}>PNG 2400</button>
                <button disabled={exporting} onClick={() => void save(4800)}>PNG 4800</button>
                <button onClick={() => s.resetView()}>{t('view.reset')}</button>
              </div>
            </div>
          </>
        )}
        <div className="muted" style={{ marginTop: 'auto' }}>
          {s.spec?.landscape ? t('hint.landscape') : t('hint.molecule')}
          <br />
          {t('footer.credit')}
        </div>
      </div>
      <Stage />
    </div>
  )
}
