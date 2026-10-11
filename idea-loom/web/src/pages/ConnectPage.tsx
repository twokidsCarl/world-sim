import { useEffect, useState } from 'react'
import { type AgentToken, api } from '../api'
import { useT } from '../state/store'
import { Empty, Page, Section } from '../ui/Page'

// 接入：外面的 AI Agent 怎么连上来，以及给它们的令牌。读和算不要令牌；令牌换来"提议"的权限。
// Connect: how outside AI agents get in, and the tokens for them. Reading and computing need no token; a token buys the right to propose.
export function ConnectPage() {
  const t = useT()
  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [name, setName] = useState('')
  const [propose, setPropose] = useState(true)
  const [fresh, setFresh] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = location.origin
  const load = () => api.agentTokens().then(setTokens, () => undefined)
  useEffect(() => {
    void load()
  }, [])
  const create = async () => {
    setError(null)
    try {
      const made = await api.createAgentToken(name, propose ? ['read', 'propose'] : ['read'])
      setFresh(made.token ?? null)
      setName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const live = tokens.filter((x) => !x.revoked)
  return (
    <Page
      title={t('接入', 'Connect')}
      lead={t(
        '让外面的 AI Agent 用上这里的数据和模拟。读数据、跑计算不需要任何令牌；提 idea 和愿望要一个带"提议"权限的令牌，而且只进你"待过目"的队列。',
        'Let outside AI agents use the data and simulations here. Reading data and running computations need no token; proposing ideas and wishes needs a token with the propose scope, and only reaches your review queue.',
      )}
    >
      <Section title={t('三种接法', 'Three ways in')}>
        <dl className="facts">
          <dt>MCP</dt>
          <dd>
            <code>{base}/mcp</code> <span className="muted small">{t('（远程）或在仓库里', '(remote), or in the repository')}</span> <code>uv run --project idea-loom idea-loom mcp</code>
          </dd>
          <dt>HTTP</dt>
          <dd>
            <a href="/api/v1/catalog" target="_blank" rel="noreferrer"><code>{base}/api/v1/catalog</code></a>
          </dd>
          <dt>{t('文档', 'Documents')}</dt>
          <dd>
            <a href="/llms.txt" target="_blank" rel="noreferrer"><code>/llms.txt</code></a> · <a href="/llms-full.txt" target="_blank" rel="noreferrer"><code>/llms-full.txt</code></a>
          </dd>
        </dl>
      </Section>
      <Section title={t('令牌', 'Tokens')} note={t('只在创建时显示一次', 'Shown once, when created')}>
        {fresh && (
          <div className="notice good" role="status">
            {t('新令牌（现在复制，之后看不到了）：', 'New token (copy it now; it will not be shown again): ')}
            <code className="pre">{fresh}</code> <button onClick={() => setFresh(null)}>{t('记下了', 'Saved')}</button>
          </div>
        )}
        {error && <div className="notice bad" role="alert">{error}</div>}
        <div className="row">
          <input aria-label={t('给谁用', 'Who it is for')} placeholder={t('给谁用，例如 research-bot', 'Who it is for, e.g. research-bot')} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
          <label className="row small">
            <input type="checkbox" checked={propose} onChange={(e) => setPropose(e.target.checked)} /> {t('可以提议', 'May propose')}
          </label>
          <button className="primary" disabled={!name.trim()} onClick={() => void create()}>{t('创建', 'Create')}</button>
        </div>
        {live.length === 0 ? (
          <Empty>{t('还没有令牌。', 'No tokens yet.')}</Empty>
        ) : (
          <ul className="plain-list">
            {live.map((x) => (
              <li key={x.id} className="visitor-item">
                <div>
                  <strong>{x.name}</strong> <span className="muted small">{x.scopes.join(' + ')} · {new Date(x.created_at * 1000).toLocaleDateString()}</span>
                </div>
                <button onClick={() => void api.revokeAgentToken(x.id).then(load)}>{t('吊销', 'Revoke')}</button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </Page>
  )
}
