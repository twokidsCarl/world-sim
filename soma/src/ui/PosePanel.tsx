// "姿势"面板：预设、按部位分组的关节滑块、镜像、复位、呼吸演示、关节信息，以及开发用的体型滑块。
// The Pose panel: presets, per-joint sliders grouped by region, mirror, reset, the breathing
// demonstration, joint info, and the dev-only body-shape sliders.

import { useMemo, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { JOINT_GROUPS, jointGroup, mirrorJointId, posePresets, poseIsRest, ribJoints, type JointGroupId } from '../anatomy/rig.ts'
import type { Joint, JointDof } from '../anatomy/types.ts'
import { useApp } from '../state/store.ts'
import { CautionList } from './CautionsDialog.tsx'
import { ShapeControls } from './ShapeControls.tsx'

const deg = (r: number): number => (r * 180) / Math.PI
const fmt = (r: number): string => `${Math.round(deg(r))}°`

function DofRow({ joint, k, d, value }: { joint: Joint; k: number; d: JointDof; value: number }) {
  const app = useApp.getState()
  const estimated = d.sourced === false
  const driven = !!d.driver
  return (
    <div className="dof-row">
      <label title={`${d.name.en}\n活动范围 ${fmt(d.min)} … ${fmt(d.max)}（相对模型静止姿势）\n${estimated ? '估计值，无出处 / estimate, no source' : `来源 / source: ${d.source.name}`}${driven ? `\n随 ${d.driver!.joint} 联动 ×${d.driver!.ratio}` : ''}`}>
        <span className="dof-name">
          {d.name.zh}
          {estimated && <span className="badge badge-review">估计</span>}
          {driven && <span className="tag">联动</span>}
        </span>
        <span className="value">{fmt(value)}</span>
      </label>
      <input
        type="range"
        min={Math.round(deg(d.min) * 10) / 10}
        max={Math.round(deg(d.max) * 10) / 10}
        step={0.5}
        value={Math.round(deg(value) * 2) / 2}
        aria-label={`${joint.name.zh} ${d.name.zh}`}
        onPointerDown={() => useApp.getState().poseJoint !== joint.id && app.selectJoint(joint.id)}
        onChange={(e) => app.setDof(joint.id, k, (Number(e.target.value) * Math.PI) / 180)}
      />
    </div>
  )
}

function JointInfo({ joint }: { joint: Joint }) {
  const rig = useApp((s) => s.rig)
  const fits = rig?.report?.joints?.find((j) => j.id === joint.id)?.fits ?? []
  return (
    <div className="joint-info">
      <p>{joint.basis.zh}</p>
      <p className="en">{joint.basis.en}</p>
      {fits.length > 0 && (
        <ul>
          {fits.map((f, i) => (
            <li key={i}>
              拟合 <span className="en">{f.what}</span>
              {f.rmsMm !== undefined && <>：残差 RMS {f.rmsMm} mm</>}
              {f.samples !== undefined && <span className="en"> · {f.samples} samples</span>}
            </li>
          ))}
        </ul>
      )}
      <ul>
        {joint.dofs.map((d, k) => (
          <li key={k}>
            {d.name.zh} <span className="en">{d.name.en}</span>：{fmt(d.min)} … {fmt(d.max)}{' '}
            {d.sourced === false ? (
              <span className="badge badge-review">估计值</span>
            ) : d.source.url ? (
              <a href={d.source.url} target="_blank" rel="noreferrer noopener" title={d.source.license}>
                {d.source.name}
              </a>
            ) : (
              <span className="en">{d.source.name}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PosePanel({ graph }: { graph: AnatomyGraph }) {
  const rig = useApp((s) => s.rig)
  const status = useApp((s) => s.rigStatus)
  const message = useApp((s) => s.rigMessage)
  const progress = useApp((s) => s.rigProgress)
  const pose = useApp((s) => s.pose)
  const mirror = useApp((s) => s.poseMirror)
  const breathing = useApp((s) => s.breathing)
  const poseJoint = useApp((s) => s.poseJoint)
  const explode = useApp((s) => s.explode)
  const [open, setOpen] = useState<JointGroupId | null>('arm')
  const [cautionsOpen, setCautionsOpen] = useState(false)
  const app = useApp.getState()
  const joints = rig?.rig.joints
  const presets = useMemo(() => (joints ? posePresets(joints) : []), [joints])
  const groups = useMemo(() => {
    const m = new Map<JointGroupId, Joint[]>()
    for (const j of joints ?? []) {
      if (j.dofs.length === 0) continue
      const g = jointGroup(j.id)
      m.set(g, [...(m.get(g) ?? []), j])
    }
    return m
  }, [joints])

  if (!rig || !joints) {
    return (
      <div className="panel-body scroll">
        <section className="group">
          <h3>
            姿势 <span className="en">Pose</span>
          </h3>
          {(status === 'loading' || status === 'idle') && (
            <>
              <p className="hint">正在加载骨架绑定（约 12 MB）… Loading the rig…</p>
              <div className="loading-bar">
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            </>
          )}
          {(status === 'missing' || status === 'stale' || status === 'error') && (
            <p className="hint">
              <strong>此人体暂不能摆姿势。</strong> Posing is unavailable for this body.
              <br />
              {message}
            </p>
          )}
        </section>
        {/* BMI 不需要骨架绑定，绑定没到也能用 / BMI needs no rig, so the shape section works before it arrives */}
        <ShapeControls graph={graph} />
      </div>
    )
  }

  const selected = poseJoint ? joints.find((j) => j.id === poseJoint) : undefined
  // 肋骨轴是否可用：数据若标记为占位（placeholder）则不提供呼吸演示
  // whether the rib axes are usable: no breathing demo when the data marks them as placeholders
  const ribs = ribJoints(joints)
  const ribsUsable = ribs.length > 0 && !ribs.some((j) => /placeholder|占位/i.test(`${j.basis.en}${j.basis.zh}`))
  const atRest = poseIsRest(pose)

  return (
    <div className="panel-body scroll pose-panel">
      <section className="group">
        <h3>
          姿势 <span className="en">Pose</span>
          <button className="link-btn" onClick={() => app.resetPose()} disabled={atRest && !breathing}>
            复位
          </button>
        </h3>
        <button className="chip chip-warn chip-button" aria-expanded={cautionsOpen} onClick={() => setCautionsOpen(!cautionsOpen)}>
          运动学演示 · {rig.rig.cautions.length} 条局限
        </button>
        {cautionsOpen && <CautionList items={rig.rig.cautions} />}
        <div className="preset-grid">
          {presets.map((p) => (
            <button key={p.id} className="mini-btn" title={p.name.en} onClick={() => app.applyPosePreset(p.id)}>
              {p.name.zh}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={mirror} onChange={(e) => app.setPoseMirror(e.target.checked)} />
          左右同步 <span className="en">Mirror left / right</span>
        </label>
        <label className="check" title={ribsUsable ? '循环上提各肋，演示呼吸时胸廓的运动' : '此人体的肋骨轴不可用'}>
          <input type="checkbox" checked={breathing} disabled={!ribsUsable} onChange={(e) => app.setBreathing(e.target.checked)} />
          呼吸 <span className="en">Breathing</span>
        </label>
        {explode > 0 && !atRest && <p className="hint">摆姿势时爆炸视图暂停。 Explode is suspended while posed.</p>}
        <p className="hint">点击模型上的骨可选中带动它的关节，再拖动彩色圆环转动。 Click a bone to pick its joint, then drag a coloured ring.</p>
      </section>

      <ShapeControls graph={graph} />

      {selected && (
        <section className="group">
          <h3>
            {selected.name.zh} <span className="en">{selected.name.en}</span>
            <button className="link-btn" onClick={() => app.selectJoint(null)}>
              取消
            </button>
          </h3>
          {selected.dofs.map((d, k) => (
            <DofRow key={k} joint={selected} k={k} d={d} value={pose[selected.id]?.[k] ?? 0} />
          ))}
          <JointInfo joint={selected} />
        </section>
      )}

      {JOINT_GROUPS.filter((g) => groups.has(g.id)).map((g) => {
        const list = groups.get(g.id)!
        // 左右同步时只列左侧和不分侧的关节 / with mirroring on, list only left and unpaired joints
        const shown = mirror ? list.filter((j) => !j.id.endsWith('_R') || !list.some((o) => o.id === mirrorJointId(j.id))) : list
        const isOpen = open === g.id
        return (
          <section className="group joint-group" key={g.id}>
            <h3>
              <button className="group-toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.id)}>
                {isOpen ? '▾' : '▸'} {g.zh} <span className="en">{g.en}</span>
              </button>
              <span className="count">{shown.length}</span>
            </h3>
            {isOpen &&
              shown.map((j) => (
                <div className={`joint${poseJoint === j.id ? ' selected' : ''}`} key={j.id}>
                  <button className="joint-name" onClick={() => app.selectJoint(j.id)} title={j.name.en}>
                    {mirror ? j.name.zh.replace(/^左/, '') : j.name.zh}
                  </button>
                  {j.dofs.map((d, k) => (
                    <DofRow key={k} joint={j} k={k} d={d} value={pose[j.id]?.[k] ?? 0} />
                  ))}
                </div>
              ))}
          </section>
        )
      })}

    </div>
  )
}
