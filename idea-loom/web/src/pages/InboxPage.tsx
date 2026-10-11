import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { type GenTarget, api } from '../api'
import type { State } from '../contract'
import { useStore } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { ProposalCard } from '../ui/ProposalCard'
import { levelName } from '../ui/bits'

export function InboxPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const { proposals, load } = useStore()
  const [target, setTarget] = useState<GenTarget>({
    level: params.get('level') ?? '',
    thread: params.get('thread') ?? '',
    kernel: params.get('kernel') ?? '',
    like: params.get('like') ?? '',
    text: '',
  })
  const [n, setN] = useState(3)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const open = proposals?.proposals.filter((p) => p.status === 'open') ?? []
  const done = proposals?.proposals.filter((p) => p.status !== 'open') ?? []
  const untranslated = state.ideas.filter((i) => ['pool', 'building', 'built'].includes(i.status) && (!i.title_en || i.en_stale)).length
  const kept = done.filter((p) => p.status === 'accepted').length

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(null)
  }
  const clean = (t: GenTarget): GenTarget => Object.fromEntries(Object.entries(t).filter(([, v]) => v)) as GenTarget
  const set = (patch: Partial<GenTarget>) => setTarget({ ...target, ...patch })
  const like = target.like ? state.ideas.find((i) => i.id === target.like) : undefined

  return (
    <Page title="生成与候选" lead="让模型提议新的 idea，或者整理已有的。它给的都只是候选：你接受之前，想法池不会变。">
      {proposals && !proposals.model_ready && (
        <div className="notice warn">这台机器上找不到 claude 命令，生成、细化这些操作现在用不了。</div>
      )}
      <Section title="生成" note="位置都可以不选；不选就让它往条目少的地方写">
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault()
            void run('生成', () => api.generate(clean(target), n))
          }}
        >
          <div className="row wrap">
            <label>
              层
              <select value={target.level} onChange={(e) => set({ level: e.target.value })}>
                <option value="">不限</option>
                {state.frame.levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {levelName(state, l.id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              横线
              <select value={target.thread} onChange={(e) => set({ thread: e.target.value })}>
                <option value="">不限</option>
                {state.frame.threads.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              内核
              <select value={target.kernel} onChange={(e) => set({ kernel: e.target.value })}>
                <option value="">不限</option>
                {state.frame.kernels.map((k) => (
                  <option key={k.name} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              几条
              <select value={n} onChange={(e) => setN(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {like && (
            <p className="small">
              从 <strong>{like.id} {like.title}</strong> 出发，写和它相邻但不同的。{' '}
              <button type="button" onClick={() => set({ like: '' })}>
                不用它
              </button>
            </p>
          )}
          <label>
            还想说的（可以不填）
            <input value={target.text} onChange={(e) => set({ text: e.target.value })} placeholder="比如：要和时间尺度有关；或者：写两个人之间敌对的关系" />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy !== null || proposals?.model_ready === false}>
              {busy === '生成' ? '正在生成，大约十几秒…' : '生成'}
            </button>
          </div>
        </form>
      </Section>

      <Section title="整理" note="这些也是提议，结果出现在下面的候选里">
        <div className="row wrap tools">
          <button disabled={busy !== null} onClick={() => void run('归类', () => api.classify())}>
            {busy === '归类' ? '正在归类…' : '给还没归类的定横线和内核'}
          </button>
          <button
            disabled={busy !== null || !(target.level || target.kernel)}
            title={target.level || target.kernel ? '' : '先在上面选一层或一种内核'}
            onClick={() => void run('查重', () => api.dedupe(clean({ level: target.level, kernel: target.kernel })))}
          >
            {busy === '查重' ? '正在查重…' : `在${target.level ? levelName(state, target.level) : target.kernel || '选定的范围'}里查重`}
          </button>
          {untranslated > 0 && (
            <button disabled={busy !== null} onClick={() => void run('翻译', () => api.translate())}>
              {busy === '翻译' ? '正在翻译…' : `把 ${untranslated} 条还没有英文的译成英文`}
            </button>
          )}
          <span className="muted small">融合：去想法池勾选两条以上。细化：去那一条 idea 的页面。</span>
        </div>
      </Section>
      {error && <div className="notice bad" role="alert">{error}</div>}

      <Section title="候选" note={`${open.length} 条等你决定`}>
        {open.length === 0 ? (
          <Empty>现在没有待定的候选。</Empty>
        ) : (
          <div className="proposals">
            {open.map((p) => (
              <ProposalCard key={p.id} proposal={p} state={state} />
            ))}
          </div>
        )}
      </Section>

      {done.length > 0 && (
        <Section title="处理过的" note={`留下 ${kept} 条，没要 ${done.length - kept} 条`}>
          <button onClick={() => setShowDone(!showDone)}>{showDone ? '收起' : '展开看看'}</button>
          {showDone && (
            <div className="proposals">
              {done.slice(0, 60).map((p) => (
                <ProposalCard key={p.id} proposal={p} state={state} />
              ))}
            </div>
          )}
        </Section>
      )}
    </Page>
  )
}
