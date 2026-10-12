import { useState } from 'react'
import { useApp } from '../state/store.ts'
import { currentLink } from '../state/urlSync.ts'
import { Icon } from './Icon.tsx'
import { SearchBox } from './SearchBox.tsx'

const BODIES: { id: string; zh: string; en: string }[] = [
  { id: 'male', zh: '男性', en: 'Male' },
  { id: 'female', zh: '女性', en: 'Female' },
]

const OTHER_LABEL: Record<string, string> = {
  fixture: '示例数据 Fixture',
  stress: '压力测试 Stress',
}

export function TopBar() {
  const graph = useApp((s) => s.graph)
  const dataset = useApp((s) => s.dataset)
  const requestedBody = useApp((s) => s.requestedBody)
  const loading = useApp((s) => s.load.phase === 'loading')
  const compare = useApp((s) => s.compare)
  const leftOpen = useApp((s) => s.leftOpen)
  const rightOpen = useApp((s) => s.rightOpen)
  const app = useApp.getState()
  const cautions = graph?.cautions.length ?? 0
  const isBody = dataset === 'male' || dataset === 'female'
  const [copied, setCopied] = useState(false)
  // 复制当前视图的链接（状态都编码在查询参数里）/ copy a link to the current view (all state is in the query)
  const copyLink = async (): Promise<void> => {
    const link = currentLink()
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      window.prompt('复制此链接 / Copy this link', link)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  const hasSkeleton = !!graph?.data.systems.some((s) => s.id === 'skeletal' && s.partCount > 0)
  return (
    <header className="topbar">
      <button className="icon-btn only-narrow" aria-label="显示与结构树" aria-pressed={leftOpen} onClick={() => { app.setRightOpen(false); app.setLeftOpen(!leftOpen) }}>
        <Icon name="layers" size={18} />
      </button>
      <div className="brand">
        <span className="brand-name">soma</span>
        <span className="brand-sub">三维人体解剖</span>
      </div>
      {graph && <SearchBox graph={graph} />}
      <div className="topbar-right">
        <div className="segmented body-switch" role="radiogroup" aria-label="人体模型">
          {BODIES.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={requestedBody === b.id}
              className={requestedBody === b.id ? 'active' : ''}
              disabled={loading && requestedBody !== b.id}
              title={`切换到${b.zh}人体（保留视角、所选结构和显示设置）`}
              onClick={() => app.switchBody(b.id)}
            >
              {b.zh} <span className="en">{b.en}</span>
            </button>
          ))}
        </div>
        {!isBody && dataset && <span className="chip chip-warn">{OTHER_LABEL[dataset] ?? dataset}</span>}
        {isBody && hasSkeleton && (
          <button
            className={`text-btn${compare ? ' on' : ''}`}
            aria-pressed={!!compare}
            title="与另一性别并排对照（视角联动，限定一个系统）"
            onClick={() => app.setCompare(compare ? null : 'skeletal')}
          >
            对照
          </button>
        )}
        {cautions > 0 && (
          <button className="chip chip-warn chip-button" onClick={() => app.setCautionsOpen(true)} title="此人体模型的已知问题">
            <span className="not-phone">初版 · </span>{cautions} 条注意<span className="not-phone">事项</span>
          </button>
        )}
        <button className="text-btn" onClick={() => void copyLink()} title="复制能直接打开当前视图的链接 / Copy a link that opens this view">
          {copied ? '已复制 Copied' : '复制链接'}
        </button>
        <button className="text-btn" onClick={() => app.setAboutOpen(true)}>
          数据来源<span className="not-phone">与声明</span>
        </button>
        <button className="icon-btn only-narrow" aria-label="结构信息" aria-pressed={rightOpen} onClick={() => { app.setLeftOpen(false); app.setRightOpen(!rightOpen) }}>
          <Icon name="info" size={18} />
        </button>
      </div>
    </header>
  )
}
