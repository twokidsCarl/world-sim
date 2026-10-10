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
