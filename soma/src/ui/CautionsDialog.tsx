import { LOOK_HIDES_INTERNAL } from '../look/statements.ts'
import { SOFT_CAUTION } from '../softbody/statements.ts'
import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'

/** The body's own list of what not to trust; shown once per body, reopenable from the top bar. */
export function CautionsDialog() {
  const open = useApp((s) => s.cautionsOpen)
  const graph = useApp((s) => s.graph)
  const dataset = useApp((s) => s.dataset)
  const dismiss = useApp((s) => s.dismissCautions)
  if (!open || !graph || graph.cautions.length === 0) return null
  return (
    <div className="dialog-backdrop" onClick={dismiss}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cautions-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="cautions-title">
            使用前请注意 <span className="en">Known limitations of this body</span>
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={dismiss}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">
          <p className="hint">
            当前人体模型（{dataset}）为初版，以下内容不可作为依据，按重要程度排列。之后可随时点击顶栏的“注意事项”再次查看。
          </p>
          <CautionList items={graph.cautions} />
          {/* 软组织物理的验证状态（不在人体数据里，由界面补上）/ the validation status of the soft-tissue physics (not in the body data; added by the UI) */}
          <h3>
            软组织物理 <span className="en">Soft-tissue physics</span>
          </h3>
          <CautionList items={[SOFT_CAUTION]} />
          {/* 写实外观藏起皮肤下面的部件（由界面补上）/ the lifelike look hides the parts under the skin (added by the UI) */}
          <h3>
            写实外观 <span className="en">Lifelike look</span>
          </h3>
          <CautionList items={[LOOK_HIDES_INTERNAL]} />
          <div className="dialog-actions">
            <button className="primary-btn" onClick={dismiss}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function CautionList({ items }: { items: readonly { zh: string; en: string }[] }) {
  return (
    <ol className="cautions">
      {items.map((c, i) => (
        <li key={i}>
          <p>{c.zh}</p>
          {c.en && <p className="en">{c.en}</p>}
        </li>
      ))}
    </ol>
  )
}
