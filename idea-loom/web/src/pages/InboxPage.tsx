import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { type GenTarget, api } from '../api'
import type { State } from '../contract'
import { pick, plural } from '../i18n'
import { useLang, useStore, useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'
import { ProposalCard } from '../ui/ProposalCard'
import { ideaTitle, kernelName, levelName } from '../ui/bits'

export function InboxPage({ state }: { state: State }) {
  const [params] = useSearchParams()
  const { proposals, load } = useStore()
  const lang = useLang()
  const t = useT()
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
    <Page
      title={t('生成与候选', 'Generate & candidates')}
      lead={t(
        '让模型提议新的 idea，或者整理已有的。它给的都只是候选：你接受之前，想法池不会变。',
        'Have the model propose new ideas or tidy up the existing ones. Everything it gives is only a candidate: the idea pool does not change until you accept.',
      )}
    >
      {proposals && !proposals.model_ready && (
        <div className="notice warn">{t('这台机器上找不到 claude 命令，生成、细化这些操作现在用不了。', 'The claude command was not found on this machine, so generating, refining and the like are unavailable for now.')}</div>
      )}
      <Section title={t('生成', 'Generate')} note={t('位置都可以不选；不选就让它往条目少的地方写', 'Every position is optional; left open, it writes where the pool is thin')}>
        <form
          className="form wide"
          onSubmit={(e) => {
            e.preventDefault()
            void run('generate', () => api.generate(clean(target), n))
          }}
        >
          <div className="row wrap">
            <label>
              {t('层', 'Level')}
              <select value={target.level} onChange={(e) => set({ level: e.target.value })}>
                <option value="">{t('不限', 'Any')}</option>
                {state.frame.levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {levelName(state, l.id, lang)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('横线', 'Thread')}
              <select value={target.thread} onChange={(e) => set({ thread: e.target.value })}>
                <option value="">{t('不限', 'Any')}</option>
                {state.frame.threads.map((th) => (
                  <option key={th.id} value={th.id}>
                    {th.id} {pick(lang, th.name, th.name_en)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('内核', 'Kernel')}
              <select value={target.kernel} onChange={(e) => set({ kernel: e.target.value })}>
                <option value="">{t('不限', 'Any')}</option>
                {state.frame.kernels.map((k) => (
                  <option key={k.name} value={k.name}>
                    {pick(lang, k.name, k.name_en)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('几条', 'How many')}
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
              {t('从 ', 'Starting from ')}<strong>{like.id} {ideaTitle(lang, like)}</strong>{t(' 出发，写和它相邻但不同的。', ': write ideas next to it but different.')}{' '}
              <button type="button" onClick={() => set({ like: '' })}>
                {t('不用它', 'Drop it')}
              </button>
            </p>
          )}
          <label>
            {t('还想说的（可以不填）', 'Anything to add (optional)')}
            <input
              value={target.text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder={t('比如：要和时间尺度有关；或者：写两个人之间敌对的关系', 'For example: it should involve time scales; or: a hostile relationship between two people')}
            />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy !== null || proposals?.model_ready === false}>
              {busy === 'generate' ? t('正在生成，大约十几秒…', 'Generating, about fifteen seconds…') : t('生成', 'Generate')}
            </button>
          </div>
        </form>
      </Section>

      <Section title={t('整理', 'Tidy up')} note={t('这些也是提议，结果出现在下面的候选里', 'These are proposals too; the results appear among the candidates below')}>
        <div className="row wrap tools">
          <button disabled={busy !== null} onClick={() => void run('classify', () => api.classify())}>
            {busy === 'classify' ? t('正在归类…', 'Classifying…') : t('给还没归类的定横线和内核', 'Classify: set threads and kernel for the unclassified')}
          </button>
          <button
            disabled={busy !== null || !(target.level || target.kernel)}
            title={target.level || target.kernel ? '' : t('先在上面选一层或一种内核', 'Choose a level or a kernel above first')}
            onClick={() => void run('dedupe', () => api.dedupe(clean({ level: target.level, kernel: target.kernel })))}
          >
            {busy === 'dedupe'
              ? t('正在查重…', 'Finding duplicates…')
              : t(
                  `在${target.level ? levelName(state, target.level, lang) : target.kernel || '选定的范围'}里查重`,
                  `Find duplicates in ${target.level ? levelName(state, target.level, lang) : target.kernel ? kernelName(state, target.kernel, lang) : 'the selected scope'}`,
                )}
          </button>
          {untranslated > 0 && (
            <button disabled={busy !== null} onClick={() => void run('translate', () => api.translate())}>
              {busy === 'translate' ? t('正在翻译…', 'Translating…') : t(`把 ${untranslated} 条还没有英文的译成英文`, `Translate the ${plural(untranslated, 'idea')} without current English`)}
            </button>
          )}
          <span className="muted small">{t('融合：去想法池勾选两条以上。细化：去那一条 idea 的页面。', 'Fuse: tick two or more in the idea pool. Refine: go to the page of that idea.')}</span>
        </div>
      </Section>
      {error && <div className="notice bad" role="alert">{error}</div>}

      <Section title={t('候选', 'Candidates')} note={t(`${open.length} 条等你决定`, `${open.length} waiting for your decision`)}>
        {open.length === 0 ? (
          <Empty>{t('现在没有待定的候选。', 'No candidates are waiting now.')}</Empty>
        ) : (
          <div className="proposals">
            {open.map((p) => (
              <ProposalCard key={p.id} proposal={p} state={state} />
            ))}
          </div>
        )}
      </Section>

      {done.length > 0 && (
        <Section title={t('处理过的', 'Decided')} note={t(`留下 ${kept} 条，没要 ${done.length - kept} 条`, `${kept} kept, ${done.length - kept} dropped`)}>
          <button onClick={() => setShowDone(!showDone)}>{showDone ? t('收起', 'Collapse') : t('展开看看', 'Show them')}</button>
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
