import { useApp } from '../state/store.ts'
import { Icon } from './Icon.tsx'
import { SearchBox } from './SearchBox.tsx'

const DATASET_LABEL: Record<string, string> = {
  male: '男性 Male',
  female: '女性 Female',
  fixture: '示例数据 Fixture',
  stress: '压力测试 Stress',
}

export function TopBar() {
  const graph = useApp((s) => s.graph)
  const dataset = useApp((s) => s.dataset)
  const leftOpen = useApp((s) => s.leftOpen)
  const rightOpen = useApp((s) => s.rightOpen)
  const setLeftOpen = useApp((s) => s.setLeftOpen)
  const setRightOpen = useApp((s) => s.setRightOpen)
  const setAboutOpen = useApp((s) => s.setAboutOpen)
  return (
    <header className="topbar">
      <button className="icon-btn only-narrow" aria-label="显示与结构树" aria-pressed={leftOpen} onClick={() => { setRightOpen(false); setLeftOpen(!leftOpen) }}>
        <Icon name="layers" size={18} />
      </button>
      <div className="brand">
        <span className="brand-name">soma</span>
        <span className="brand-sub">三维人体解剖</span>
      </div>
      {graph && <SearchBox graph={graph} />}
      <div className="topbar-right">
        {dataset && <span className={`chip${dataset === 'fixture' || dataset === 'stress' ? ' chip-warn' : ''}`}>{DATASET_LABEL[dataset] ?? dataset}</span>}
        <button className="text-btn" onClick={() => setAboutOpen(true)}>
          数据来源与声明
        </button>
        <button className="icon-btn only-narrow" aria-label="结构信息" aria-pressed={rightOpen} onClick={() => { setLeftOpen(false); setRightOpen(!rightOpen) }}>
          <Icon name="info" size={18} />
        </button>
      </div>
    </header>
  )
}
