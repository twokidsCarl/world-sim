// 嵌入模式（?embed=1）下舞台上的控件：一行注意事项、按卡片状态给出的少量控件、以及"在完整界面中打开"。
// Controls on the stage in embed mode (?embed=1): a one-line caution notice, a few controls
// chosen from the card's state, and "open full UI".

import { useMemo, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { posePresets } from '../anatomy/rig.ts'
import { useApp } from '../state/store.ts'
import { currentLink } from '../state/urlSync.ts'
import { CautionList } from './CautionsDialog.tsx'
import { Icon } from './Icon.tsx'

/** 卡片 URL 带了哪些参数，就显示哪些控件（见 App 中的 embedKeys）。 */
/** Which controls appear follows from which parameters the card URL carried (see embedKeys in App). */
let embedKeys = new Set<string>()
export function setEmbedKeys(keys: Iterable<string>): void {
  embedKeys = new Set(keys)
}

export function EmbedControls({ graph }: { graph: AnatomyGraph }) {
  const [cautionsOpen, setCautionsOpen] = useState(false)
  const peel = useApp((s) => s.peel)
  const section = useApp((s) => s.section)
  const rig = useApp((s) => s.rig)
  const rigStatus = useApp((s) => s.rigStatus)
  const rigProgress = useApp((s) => s.rigProgress)
  const posePreset = useApp((s) => s.posePreset)
  const breathing = useApp((s) => s.breathing)
  const mapMode = useApp((s) => s.skinMapMode)
  const selection = useApp((s) => s.selection)
  const regions = useApp((s) => s.skinRegions)
  const maps = useApp((s) => s.skinMaps)
  const app = useApp.getState()
  const layers = graph.data.layers
  const cautions = graph.cautions
  const rigCautions = rig && (embedKeys.has('pose') || embedKeys.has('breath')) ? rig.rig.cautions : []
  const all = [...cautions, ...rigCautions]
  // 姿势按钮：静止、卡片指定的预设，再加几个常用的 / pose buttons: rest, the card's preset, and a few common ones
  const presets = useMemo(() => {
    if (!rig) return []
    const list = posePresets(rig.rig.joints)
    const want = ['rest', 'anatomical', 'elbow90', 'shoulderAbd90', 'squat', 'fist']
    return list.filter((p) => want.includes(p.id) || p.id === posePreset).slice(0, 7)
  }, [rig, posePreset])

  let label: string | null = null
  const map = mapMode === 'off' ? undefined : maps?.maps.find((m) => m.id === mapMode)
  if (map && regions.length) label = regions.map((r) => map.regions[r]?.name.zh).filter(Boolean).join('、')
  else if (selection.concept) {
    const c = graph.concept(selection.concept.tree, selection.concept.id)
    if (c) label = graph.conceptName(c).primary
  } else if (selection.ids.length === 1) {
    const p = graph.part(selection.ids[0]!)
    if (p) label = graph.partName(p).primary
  } else if (selection.ids.length > 1) label = `已选择 ${selection.ids.length} 个结构`

  return (
    <>
      {all.length > 0 && (
        <div className={`embed-cautions${cautionsOpen ? ' open' : ''}`}>
          <button aria-expanded={cautionsOpen} onClick={() => setCautionsOpen(!cautionsOpen)}>
            教学示意 · {all.length} 条注意事项 <span className="en">teaching model · {all.length} cautions</span> {cautionsOpen ? '▴' : '▾'}
          </button>
          {cautionsOpen && <CautionList items={all} />}
        </div>
      )}

      <div className="embed-strip">
        <button className="tool-btn" onClick={() => app.requestHome()} title="复位视角 Reset view">
          <Icon name="home" /> <span>复位</span>
        </button>
        {embedKeys.has('peel') && layers.length > 1 && (
          <label className="embed-slider" title="逐层剥离 Peel">
            <span>剥离 {layers[Math.min(peel, layers.length - 1)]?.name.zh}</span>
            <input type="range" min={0} max={layers.length - 1} step={1} value={Math.min(peel, layers.length - 1)} aria-label="剥离层数 / peel depth" onChange={(e) => app.setPeel(Number(e.target.value))} />
          </label>
        )}
        {embedKeys.has('cut') && (
          <label className="embed-slider" title="剖切位置 Section position">
            <span>剖切</span>
            <input type="range" min={0} max={1000} step={1} value={Math.round(section.position * 1000)} aria-label="剖切位置 / section position" onChange={(e) => app.setSection({ position: Number(e.target.value) / 1000, enabled: true })} />
          </label>
        )}
        {(embedKeys.has('pose') || embedKeys.has('breath')) && !rig && rigStatus === 'loading' && <span className="embed-note">加载骨架绑定 {Math.round(rigProgress * 100)}%</span>}
        {(embedKeys.has('pose') || embedKeys.has('breath')) && !rig && ['missing', 'stale', 'error'].includes(rigStatus) && <span className="embed-note">此人体暂不能摆姿势 Posing unavailable</span>}
        {embedKeys.has('pose') &&
          presets.map((p) => (
            <button key={p.id} className={`tool-btn${(posePreset ?? 'rest') === p.id ? ' on' : ''}`} title={p.name.en} onClick={() => app.applyPosePreset(p.id)}>
              {p.id === 'rest' ? '静止' : p.name.zh}
            </button>
          ))}
        {embedKeys.has('breath') && rig && (
          <button className={`tool-btn${breathing ? ' on' : ''}`} aria-pressed={breathing} onClick={() => app.setBreathing(!breathing)}>
            呼吸 <span className="en">Breathing</span>
          </button>
        )}
        {embedKeys.has('map') &&
          (
            [
              ['off', '关闭'],
              ['dermatome', '皮节'],
              ['cutaneousNerve', '皮神经'],
            ] as const
          ).map(([id, zh]) => (
            <button key={id} className={`tool-btn${mapMode === id ? ' on' : ''}`} onClick={() => app.setSkinMapMode(id)}>
              {zh}
            </button>
          ))}
        <a className="tool-btn embed-open" href={currentLink({ embed: false })} target="_blank" rel="noreferrer noopener" onClick={(e) => (e.currentTarget.href = currentLink({ embed: false }))}>
          在完整界面中打开 <span className="en">Open full UI</span>
        </a>
      </div>
      {label && <div className="embed-label">{label}</div>}
    </>
  )
}
