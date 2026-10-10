import { useEffect, useState } from 'react'
import { download, exportPng } from './render/export'
import { placedAtomCount } from './scene/build'
import { useStore } from './state/store'
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
  const [id, setId] = useState(() => new URLSearchParams(location.search).get('id') ?? '2hhb')
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void s.load(id)
  }, [])

  const save = async (longSide: number) => {
    if (!stage.renderer || !stage.view || !s.mol) return
    setExporting(true)
    try {
      download(await exportPng(stage.renderer, stage.view, s.style, longSide), `${s.mol.id}-${longSide}.png`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="app">
      <div className="side">
        <h1>limn</h1>
        <form className="row" onSubmit={(e) => (e.preventDefault(), void s.load(id))}>
          <input type="text" value={id} onChange={(e) => setId(e.target.value)} placeholder="PDB 编号" spellCheck={false} />
          <button className="primary" disabled={!!s.busy}>载入</button>
        </form>
        {s.error && <div className="error">{s.error}</div>}

        {s.mol && s.coloring && (
          <>
            <div className="caption">
              <b>{s.mol.id}</b> <span className="muted">{s.mol.title}</span>
            </div>
            <div>
              <h2>组装体</h2>
              <div className="row">
                <select value={s.assembly} onChange={(e) => s.setAssembly(e.target.value)} style={{ flex: 1 }}>
                  {s.mol.assemblies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id === 'asym' ? '非对称单元' : `组装体 ${a.id}`} · {placedAtomCount(s.mol!, a.id).toLocaleString()} 原子
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <h2>成分与角色</h2>
              {s.mol.entities.map((e, i) => (
                <div className="entity" key={e.id} title={e.description}>
                  <div className="swatch" style={{ background: hex(oklch(...entityLch(s.coloring!, i, TONE_MOLECULE))) }} />
                  <span>{e.description || e.kind}</span>
                  <select value={s.coloring!.roles[i]} onChange={(ev) => s.setRole(i, ev.target.value as Role)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div>
              <h2>线条</h2>
              <Slider label="线宽" value={s.style.lineWidth} min={0.5} max={3} step={0.1} onChange={(v) => s.setStyle((x) => (x.lineWidth = v))} />
              <Slider label="内部轮廓" value={s.style.contour.diffMax} min={1} max={40} step={0.5} onChange={(v) => s.setStyle((x) => (x.contour.diffMax = v))} />
              <Slider label="残基间隔" value={s.style.residue.diff} min={1} max={6000} step={1} onChange={(v) => s.setStyle((x) => (x.residue.diff = v))} />
            </div>
            <div>
              <h2>阴影与景深</h2>
              <Slider label="阴影强度" value={s.style.shadow.strength} min={0} max={0.006} step={0.0001} onChange={(v) => s.setStyle((x) => (x.shadow.strength = v))} />
              <Slider label="最暗" value={s.style.shadow.floor} min={0.2} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.shadow.floor = v))} />
              <Slider label="远处淡出" value={s.style.fog.back} min={0.3} max={1} step={0.01} onChange={(v) => s.setStyle((x) => (x.fog.back = v))} />
            </div>
            <div>
              <h2>导出</h2>
              <div className="row">
                <button disabled={exporting} onClick={() => void save(2400)}>PNG 2400</button>
                <button disabled={exporting} onClick={() => void save(4800)}>PNG 4800</button>
                <button onClick={() => s.setView(null)}>重置视角</button>
              </div>
            </div>
          </>
        )}
        <div className="muted" style={{ marginTop: 'auto' }}>拖动旋转 · 滚轮缩放 · Shift 拖动平移</div>
      </div>
      <Stage />
    </div>
  )
}
