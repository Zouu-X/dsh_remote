import { useMemo, useState } from 'react'
import { buildReviewTimeline, groupSessionsByWorkspace } from '@dsh-remote/domain'
import type {
  ReviewMessageNode,
  ReviewNode,
  ReviewToolNode,
  SessionHistoryPage,
  SessionSearchItem,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import { useRemote } from './use-remote.js'

type Tab = 'hosts' | 'tasks' | 'approval' | 'review'

export default function App() {
  const remote = useRemote()
  const [tab, setTab] = useState<Tab>('tasks')
  const [promptText, setPromptText] = useState('')

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <strong>DSH Remote</strong>
          <div className="muted">
            {remote.connection === 'open' ? '已连接' : remote.connection === 'connecting' ? '连接中' : '重连中'}
            {remote.host ? ` · ${remote.host.hostId}` : ''}
          </div>
        </div>
        <button className="ghost" onClick={() => void remote.refreshAll()}>刷新</button>
      </header>

      {(remote.error || remote.gapNotice) !== '' && (
        <div className="notice">
          {remote.error && <div>{remote.error}</div>}
          {remote.gapNotice && <div>{remote.gapNotice}</div>}
        </div>
      )}

      <main>
        {tab === 'hosts' && <HostsView workspaces={remote.workspaces} health={remote.health} host={remote.host} />}
        {tab === 'tasks' && (
          <TasksView
            sessions={remote.sessions}
            searchResults={remote.searchResults}
            workspaces={remote.workspaces}
            onSearch={query => void remote.searchSessions(query)}
            selectedSessionId={remote.selectedSessionId}
            history={remote.history}
            queuedItems={remote.queuedItems}
            promptText={promptText}
            setPromptText={setPromptText}
            onSelect={remote.selectSession}
            onCreate={workspaceId => void remote.createSession(workspaceId)}
            onSend={(sessionId, mode) => {
              if (promptText.trim() !== '') void remote.sendPrompt(sessionId, promptText.trim(), mode)
              setPromptText('')
            }}
          />
        )}
        {tab === 'approval' && (
          <ApprovalView
            approvals={remote.pendingApprovals}
            questions={remote.pendingQuestions}
            onApprove={request => void remote.respondApproval(request, 'allowed-once')}
            onReject={request => void remote.respondApproval(request, 'rejected')}
            onAnswer={request => void remote.respondQuestion(request)}
          />
        )}
        {tab === 'review' && (
          <ReviewView
            sessions={remote.sessions}
            selectedSessionId={remote.selectedSessionId}
            history={remote.history}
            historyLoading={remote.historyLoading}
            loadingOlder={remote.loadingOlder}
            historyNotice={remote.historyNotice}
            onSelect={remote.selectSession}
            onLoadOlder={sessionId => void remote.loadOlderHistory(sessionId)}
            onRefresh={sessionId => void remote.refreshHistory(sessionId)}
          />
        )}
      </main>

      <nav className="tabs">
        <TabButton active={tab === 'hosts'} onClick={() => setTab('hosts')}>Hosts</TabButton>
        <TabButton active={tab === 'tasks'} onClick={() => setTab('tasks')}>Tasks</TabButton>
        <TabButton active={tab === 'approval'} onClick={() => setTab('approval')}>
          Approval{remote.pendingApprovals.length + remote.pendingQuestions.length > 0
            ? ` (${remote.pendingApprovals.length + remote.pendingQuestions.length})`
            : ''}
        </TabButton>
        <TabButton active={tab === 'review'} onClick={() => setTab('review')}>Review</TabButton>
      </nav>
    </div>
  )
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className={props.active ? 'tab active' : 'tab'} onClick={props.onClick}>{props.children}</button>
  )
}

function HostsView(props: { workspaces: WorkspaceSummary[]; health: ReturnType<typeof useRemote>['health']; host: ReturnType<typeof useRemote>['host'] }) {
  return (
    <section>
      <h2>Host</h2>
      {props.host !== null && (
        <div className="card">
          <div><strong>{props.host.cwd}</strong></div>
          <div className="muted">model {props.host.model ?? '-'} · attached {props.host.attachedSessions}</div>
          <div className="muted">user={props.host.principalUserId} device={props.host.principalDeviceId}</div>
          {props.health !== null && (
            <div className="muted">当前设备：{props.health.principal.deviceName ?? props.health.principal.deviceId}</div>
          )}
        </div>
      )}
      <h2>Workspaces</h2>
      {props.workspaces.map(workspace => (
        <div className="card" key={workspace.workspaceId}>
          <div><strong>{workspace.title}</strong></div>
          <div className="muted">{workspace.path}</div>
          <div className="muted">{workspace.sessionIds.length} sessions</div>
        </div>
      ))}
    </section>
  )
}

function TasksView(props: {
  sessions: SessionSummary[]
  searchResults: SessionSearchItem[]
  workspaces: WorkspaceSummary[]
  onSearch: (query: string) => void
  selectedSessionId: string | null
  history: ReturnType<typeof useRemote>['history']
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  promptText: string
  setPromptText: (value: string) => void
  onSelect: (sessionId: string | null) => void
  onCreate: (workspaceId?: string) => void
  onSend: (sessionId: string, mode: 'queue' | 'steer') => void
}) {
  const selected = props.sessions.find(session => session.sessionId === props.selectedSessionId) ?? null
  const [searchText, setSearchText] = useState('')
  const groups = useMemo(
    () => groupSessionsByWorkspace(props.sessions, props.workspaces),
    [props.sessions, props.workspaces],
  )

  return (
    <section>
      <div className="row">
        <h2>Tasks</h2>
        <button onClick={() => props.onCreate()}>+ Session</button>
      </div>

      <input
        className="search"
        value={searchText}
        onChange={event => {
          setSearchText(event.target.value)
          props.onSearch(event.target.value)
        }}
        placeholder="搜索 session"
      />

      {searchText.trim() !== '' && (
        <div className="search-results">
          {props.searchResults.length === 0 && <div className="muted">无结果</div>}
          {props.searchResults.map(result => (
            <button
              className="session-row"
              key={result.sessionId}
              onClick={() => props.onSelect(result.sessionId)}
            >
              <span className="session-title">{result.sessionId}</span>
              <span className="muted">{result.snippet}</span>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <SessionDetail
          session={selected}
          history={props.history}
          queuedItems={props.queuedItems}
          promptText={props.promptText}
          setPromptText={props.setPromptText}
          onSend={mode => props.onSend(selected.sessionId, mode)}
        />
      )}

      {groups.map(group => (
        <div className="group" key={group.workspaceId ?? 'ungrouped'}>
          <h3>
            {group.title} <span className="muted">({group.sessions.length})</span>{' '}
            <button className="ghost small" onClick={() => props.onCreate(group.workspaceId ?? undefined)}>+</button>
          </h3>
          {group.sessions.map(session => (
            <button
              className={`session-row${session.sessionId === props.selectedSessionId ? ' active' : ''}`}
              key={session.sessionId}
              onClick={() => props.onSelect(session.sessionId)}
            >
              <span className="session-title">{session.title ?? session.sessionId.slice(0, 13)}</span>
              <span className="muted">{session.running ? 'running' : 'idle'} · {new Date(session.updatedAt).toLocaleTimeString()}</span>
            </button>
          ))}
        </div>
      ))}

    </section>
  )
}

function SessionDetail(props: {
  session: SessionSummary
  history: SessionHistoryPage | null
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  promptText: string
  setPromptText: (value: string) => void
  onSend: (mode: 'queue' | 'steer') => void
}) {
  const nodes = useMemo(() => buildReviewTimeline(props.history?.events ?? []), [props.history])
  const lastMessage = useMemo(
    () => [...nodes].reverse().find((node): node is ReviewMessageNode => node.kind === 'message' && node.role === 'assistant'),
    [nodes],
  )
  const lastTool = useMemo(
    () => [...nodes].reverse().find((node): node is ReviewToolNode => node.kind === 'tool'),
    [nodes],
  )
  const [messageExpanded, setMessageExpanded] = useState(false)
  const messageText = lastMessage?.text ?? ''
  const messageVisible = messageExpanded || messageText.length <= 280
    ? messageText
    : `${messageText.slice(0, 280)}…`

  return (
    <div className="card composer session-detail">
      <div className="row">
        <strong>{props.session.title ?? '未命名'}</strong>
        <span className={`status ${props.session.running ? 'running' : 'idle'}`}>
          {props.session.running ? '运行中' : '空闲'}
        </span>
      </div>
      <div className="muted">
        lastSeq {props.session.lastSeq} · {props.session.agentPreset ?? 'default preset'}
      </div>

      {lastTool !== undefined && (
        <div className="current-tool">
          <div className="muted">当前/最近工具</div>
          <div className="tool-line">
            <span className="badge tool">工具</span>
            <span>{lastTool.title}</span>
            {lastTool.endSeq === undefined && props.session.running && <span className="muted">执行中…</span>}
          </div>
        </div>
      )}

      {lastMessage !== undefined && (
        <div className="last-message">
          <div className="muted">最后 Agent 消息</div>
          <div className="message-text">{messageVisible}</div>
          {messageText.length > 280 && (
            <button className="ghost small" onClick={() => setMessageExpanded(value => !value)}>
              {messageExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}

      {props.queuedItems.length > 0 && (
        <div className="queued-box">
          <div className="muted">已排队（{props.queuedItems.length}）</div>
          {props.queuedItems.map(item => (
            <div className="queued-item" key={item.id}>
              <span className={`badge ${item.placement === 'steering' ? 'assistant' : 'tool'}`}>
                {item.placement === 'steering' ? '追加' : '排队'}
              </span>
              <span>{item.text}</span>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={props.promptText}
        onChange={event => props.setPromptText(event.target.value)}
        placeholder={props.session.running ? '输入追加指令…' : '输入新任务…'}
        rows={3}
      />
      <div className="row">
        <button disabled={props.promptText.trim() === ''} onClick={() => props.onSend('queue')}>
          {props.session.running ? '排队任务' : '发送任务'}
        </button>
        <button
          disabled={!props.session.running || props.promptText.trim() === ''}
          onClick={() => props.onSend('steer')}
        >
          追加指令
        </button>
      </div>
    </div>
  )
}

function ApprovalView(props: {
  approvals: ReturnType<typeof useRemote>['pendingApprovals']
  questions: ReturnType<typeof useRemote>['pendingQuestions']
  onApprove: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => void
  onReject: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => void
  onAnswer: (request: ReturnType<typeof useRemote>['pendingQuestions'][number]) => void
}) {
  return (
    <section>
      <h2>Approvals</h2>
      {props.approvals.length === 0 && <div className="muted">没有待审批项</div>}
      {props.approvals.map(request => (
        <div className="card" key={request.approvalId}>
          <div><strong>{request.toolName}</strong></div>
          <div className="muted">{request.reason ?? '等待审批'}</div>
          <div className="row">
            <button onClick={() => props.onApprove(request)}>允许一次</button>
            <button className="danger" onClick={() => props.onReject(request)}>拒绝</button>
          </div>
        </div>
      ))}

      <h2>Questions</h2>
      {props.questions.length === 0 && <div className="muted">没有待回答问题</div>}
      {props.questions.map(request => (
        <div className="card" key={request.rpcId}>
          {request.questions.map(question => (
            <div key={question.id}>
              <div><strong>{question.header ?? question.question}</strong></div>
              <div className="muted">{question.options?.map(option => option.label).join(' / ')}</div>
            </div>
          ))}
          <button onClick={() => props.onAnswer(request)}>选择第一项</button>
        </div>
      ))}
    </section>
  )
}

type ReviewFilter = 'all' | 'messages' | 'tools' | 'changes' | 'status'

function ReviewView(props: {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  history: SessionHistoryPage | null
  historyLoading: boolean
  loadingOlder: boolean
  historyNotice: string
  onSelect: (sessionId: string | null) => void
  onLoadOlder: (sessionId: string) => void
  onRefresh: (sessionId: string) => void
}) {
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const nodes = useMemo(
    () => buildReviewTimeline(props.history?.events ?? []),
    [props.history],
  )
  const filtered = useMemo(
    () => nodes.filter(node => reviewNodeMatches(node, filter)),
    [nodes, filter],
  )
  const finalSeq = useMemo(() => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index]
      if (node !== undefined && node.kind === 'message' && node.role === 'assistant' && node.partial !== true && node.text !== '') {
        return node.seq
      }
    }
    return undefined
  }, [nodes])
  const sessions = useMemo(
    () => [...props.sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [props.sessions],
  )
  const eventCount = props.history?.events.length ?? 0
  const firstSeq = props.history?.events[0]?.sequence

  return (
    <section>
      <h2>Review</h2>

      <div className="review-toolbar">
        <select
          value={props.selectedSessionId ?? ''}
          onChange={event => props.onSelect(event.target.value === '' ? null : event.target.value)}
          aria-label="选择 session"
        >
          <option value="">选择 session…</option>
          {sessions.map(session => (
            <option value={session.sessionId} key={session.sessionId}>
              {session.title ?? session.sessionId.slice(0, 13)}
            </option>
          ))}
        </select>
        <select value={filter} onChange={event => setFilter(event.target.value as ReviewFilter)} aria-label="筛选 Review">
          <option value="all">全部</option>
          <option value="messages">消息</option>
          <option value="tools">工具</option>
          <option value="changes">文件与测试</option>
          <option value="status">状态</option>
        </select>
        <button
          className="ghost small"
          disabled={props.selectedSessionId === null || props.historyLoading}
          onClick={() => {
            if (props.selectedSessionId !== null) props.onRefresh(props.selectedSessionId)
          }}
        >
          刷新
        </button>
      </div>

      {props.historyNotice !== '' && <div className="review-notice">{props.historyNotice}</div>}

      {props.selectedSessionId === null && (
        <div className="card muted">先在 Tasks 或上方下拉框选择一个 session。</div>
      )}

      {props.selectedSessionId !== null && props.historyLoading && props.history === null && (
        <div className="card muted">加载历史中…</div>
      )}

      {props.selectedSessionId !== null && props.historyLoading === false && eventCount === 0 && (
        <div className="card muted">暂无事件</div>
      )}

      {props.history !== null && props.history.hasMore && (
        <button
          className="ghost load-older"
          disabled={props.loadingOlder}
          onClick={() => {
            const history = props.history
            if (history !== null) props.onLoadOlder(history.sessionId)
          }}
        >
          {props.loadingOlder ? '加载中…' : `加载更早（当前从 #${firstSeq ?? 0} 开始）`}
        </button>
      )}

      {eventCount > 0 && (
        <div className="muted review-summary">
          已折叠 {eventCount.toLocaleString()} 个原始事件为 {filtered.length.toLocaleString()} 条轨迹节点
        </div>
      )}

      <div className="timeline">
        {filtered.map(node => <ReviewNodeView key={`${node.kind}:${node.seq}`} node={node} final={node.kind === 'message' && node.seq === finalSeq} />)}
      </div>
    </section>
  )
}

function reviewNodeMatches(node: ReviewNode, filter: ReviewFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'messages') return node.kind === 'message'
  if (filter === 'tools') return node.kind === 'tool'
  if (filter === 'changes') {
    if (node.kind !== 'tool') return false
    const card = toolCardFor(node)
    return card === 'terminal' || card === 'diff' || card === 'read' || card === 'search'
  }
  return node.kind === 'status'
}

function ReviewNodeView(props: { node: ReviewNode; final: boolean }) {
  const node = props.node
  if (node.kind === 'turn') {
    return <div className="review-turn"><span>Turn {node.turn}</span><span className="muted">{new Date(node.timestamp).toLocaleTimeString()}</span></div>
  }
  if (node.kind === 'step') {
    return <div className="review-step muted">Step {node.step}</div>
  }
  if (node.kind === 'message') return <MessageCard node={node} final={props.final} />
  if (node.kind === 'tool') return <ToolCard node={node} />
  if (node.kind === 'status') return <StatusRow node={node} />
  return <RawRow node={node} />
}

function MessageCard(props: { node: ReviewMessageNode; final: boolean }) {
  const node = props.node
  const [expanded, setExpanded] = useState(props.final)
  const longText = node.text.length > 320
  const visibleText = expanded || longText === false ? node.text : `${node.text.slice(0, 320)}…`
  return (
    <div className={`review-card message ${node.role}${props.final ? ' final' : ''}${node.partial === true ? ' partial' : ''}`}>
      <div className="review-card-head">
        <button className="review-head-button" onClick={() => setExpanded(value => !value)}>
          <span className={`badge ${node.role}`}>{node.role === 'user' ? '用户' : props.final ? '最终结论' : node.partial === true ? 'Agent · 进行中' : 'Agent'}</span>
          <span className="muted">#{node.seq} · {new Date(node.timestamp).toLocaleTimeString()}</span>
        </button>
        <button className="ghost small" onClick={() => void copyText(node.text)}>复制</button>
      </div>
      {node.reasoning !== undefined && (
        <details className="reasoning">
          <summary>思考过程</summary>
          <pre className="preview">{node.reasoning}</pre>
        </details>
      )}
      {node.text !== '' && <div className="message-text">{visibleText}</div>}
      {longText && (
        <button className="ghost small" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </div>
  )
}


type ViewRecord = Record<string, unknown>

function asViewRecord(value: unknown): ViewRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as ViewRecord
  return typeof record.card === 'string' ? record : undefined
}

function toolCardFor(node: ReviewToolNode): string | undefined {
  const result = asViewRecord(node.resultView)?.card
  const call = asViewRecord(node.callView)?.card
  return typeof result === 'string' ? result : typeof call === 'string' ? call : undefined
}

function ToolCard(props: { node: ReviewToolNode }) {
  const node = props.node
  const [expanded, setExpanded] = useState(false)
  const card = toolCardFor(node)
  const cardName = card === undefined ? node.name : card
  const status = node.resultText !== undefined
    ? node.resultIsError === true ? '失败' : '完成'
    : '运行中'
  return (
    <div className={`review-card tool status-${status}`}>
      <div className="review-card-head">
        <button className="review-head-button" onClick={() => setExpanded(value => !value)}>
          <span className="badge tool">{cardName}</span>
          <span className="tool-title">{node.title}</span>
          <span className="muted">#{node.seq} · {status}</span>
        </button>
      </div>
      {expanded && <ToolDetail node={node} view={asViewRecord(node.resultView) ?? asViewRecord(node.callView)} />}
    </div>
  )
}

function ToolDetail(props: { node: ReviewToolNode; view: ViewRecord | undefined }) {
  const node = props.node
  const view = props.view
  if (view !== undefined && view.card === 'terminal') return <TerminalDetail node={node} view={view} />
  if (view !== undefined && view.card === 'diff') return <DiffDetail view={view} />
  if (view !== undefined && view.card === 'read') return <ReadDetail view={view} />
  if (view !== undefined && view.card === 'search') return <SearchDetail view={view} />
  if (view !== undefined && view.card === 'web') return <WebDetail view={view} />
  return <GenericDetail node={node} view={view} />
}

function TerminalDetail(props: { node: ReviewToolNode; view: ViewRecord }) {
  const node = props.node
  const output = typeof props.view.output === 'string'
    ? props.view.output
    : node.resultText ?? ''
  const exitCode = typeof props.view.exitCode === 'number' ? String(props.view.exitCode) : undefined
  const signal = typeof props.view.signal === 'string' ? props.view.signal : undefined
  const capped = output.length > 12000
  return (
    <div className="tool-detail">
      {node.argumentsText !== undefined && node.title === node.name && <pre className="preview">{node.argumentsText}</pre>}
      <div className="status-pills">
        {exitCode !== undefined && <span className={`status-pill ${exitCode === '0' ? 'ok' : 'bad'}`}>exit {exitCode}</span>}
        {signal !== undefined && <span className="status-pill bad">{signal}</span>}
        <button className="ghost small" onClick={() => void copyText(output)}>复制输出</button>
      </div>
      <pre className="preview">{capped ? `${output.slice(0, 12000)}\n…` : output}</pre>
      {capped && <div className="muted">输出过长，仅显示前 12000 字符</div>}
    </div>
  )
}

function DiffDetail(props: { view: ViewRecord }) {
  const diffs = Array.isArray(props.view.diffs) ? props.view.diffs : []
  if (diffs.length === 0) return <div className="tool-detail muted">没有 diff 内容</div>
  return (
    <div className="tool-detail">
      {diffs.map((value, index) => {
        const diff = asRecord(value)
        const path = typeof diff?.path === 'string' ? diff.path : `文件 ${index + 1}`
        const oldText = typeof diff?.oldText === 'string' ? diff.oldText : null
        const newText = typeof diff?.newText === 'string' ? diff.newText : ''
        return (
          <div className="diff-file" key={`${path}:${index}`}>
            <div className="diff-path">{path}</div>
            {oldText === null
              ? <pre className="preview diff-add">{newText}</pre>
              : (
                  <>
                    <pre className="preview diff-old">{oldText}</pre>
                    <pre className="preview diff-add">{newText}</pre>
                  </>
                )}
          </div>
        )
      })}
    </div>
  )
}

function ReadDetail(props: { view: ViewRecord }) {
  const path = typeof props.view.path === 'string' ? props.view.path : ''
  const totalLines = typeof props.view.totalLines === 'number' ? props.view.totalLines : undefined
  const lines = Array.isArray(props.view.lines) ? props.view.lines : []
  return (
    <div className="tool-detail">
      <div className="diff-path">{path}{totalLines !== undefined ? ` · 共 ${totalLines} 行` : ''}</div>
      <pre className="preview code">
        {lines.map(line => {
          const record = asRecord(line)
          const number = typeof record?.number === 'number' ? record.number : ''
          const text = typeof record?.text === 'string' ? record.text : ''
          return `${String(number).padStart(5, ' ')}  ${text}`
        }).join('\n')}
      </pre>
    </div>
  )
}

function SearchDetail(props: { view: ViewRecord }) {
  if (props.view.shape === 'matches') {
    const files = Array.isArray(props.view.files) ? props.view.files : []
    return (
      <div className="tool-detail">
        {props.view.truncated === true && <div className="muted">结果已截断，总数 {String(props.view.total ?? '?')}</div>}
        {files.map((value, index) => {
          const file = asRecord(value)
          const path = typeof file?.path === 'string' ? file.path : `结果 ${index + 1}`
          const matches = Array.isArray(file?.matches) ? file.matches : []
          return (
            <details className="search-file" key={`${path}:${index}`}>
              <summary>{path} ({matches.length})</summary>
              <pre className="preview">
                {matches.map(match => {
                  const record = asRecord(match)
                  const lineNumber = typeof record?.lineNumber === 'number' ? record.lineNumber : ''
                  const line = typeof record?.line === 'string' ? record.line : ''
                  return `${String(lineNumber).padStart(5, ' ')}  ${line}`
                }).join('\n')}
              </pre>
            </details>
          )
        })}
      </div>
    )
  }
  if (props.view.shape === 'paths') {
    const paths = Array.isArray(props.view.paths) ? props.view.paths.filter(value => typeof value === 'string') : []
    return (
      <div className="tool-detail">
        {props.view.truncated === true && <div className="muted">结果已截断，总数 {String(props.view.total ?? '?')}</div>}
        <pre className="preview">{paths.join('\n')}</pre>
      </div>
    )
  }
  return <GenericDetail node={{ name: 'search', title: 'Search' }} view={props.view} />
}

function WebDetail(props: { view: ViewRecord }) {
  const sources = Array.isArray(props.view.sources) ? props.view.sources : []
  return (
    <div className="tool-detail">
      {typeof props.view.answer === 'string' && props.view.answer !== '' && <div className="message-text">{props.view.answer}</div>}
      {sources.map((value, index) => {
        const source = asRecord(value)
        return (
          <div className="web-source" key={typeof source?.url === 'string' ? source.url : index}>
            <div><strong>{typeof source?.title === 'string' ? source.title : typeof source?.url === 'string' ? source.url : `来源 ${index + 1}`}</strong></div>
            {typeof source?.snippet === 'string' && <div className="muted">{source.snippet}</div>}
          </div>
        )
      })}
    </div>
  )
}

function GenericDetail(props: { node: Pick<ReviewToolNode, 'name' | 'title' | 'argumentsText' | 'resultText'>; view: ViewRecord | undefined }) {
  const node = props.node
  const rawInput = props.view?.rawInput
  const contentText = textFromBlocks(props.view?.content)
  return (
    <div className="tool-detail">
      {node.argumentsText !== undefined && <pre className="preview">{node.argumentsText}</pre>}
      {rawInput !== undefined && <pre className="preview">{formatUnknown(rawInput)}</pre>}
      {contentText !== '' && <pre className="preview">{contentText}</pre>}
      {node.resultText !== undefined && node.resultText !== '' && <pre className="preview">{node.resultText}</pre>}
      {node.argumentsText === undefined && node.resultText === undefined && contentText === '' && <div className="muted">无详情</div>}
    </div>
  )
}

function StatusRow(props: { node: Extract<ReviewNode, { kind: 'status' }> }) {
  const node = props.node
  return (
    <details className="review-status">
      <summary>
        <span>{node.label}{node.detail !== '' ? ` · ${node.detail}` : ''}</span>
        <span className="muted">#{node.seq}</span>
      </summary>
      <pre className="preview">{formatUnknown(node.payload)}</pre>
    </details>
  )
}

function RawRow(props: { node: Extract<ReviewNode, { kind: 'raw' }> }) {
  const node = props.node
  return (
    <details className="review-status raw">
      <summary>
        <span className="muted">{node.label}</span>
        <span className="muted">#{node.seq}</span>
      </summary>
      <pre className="preview">{formatUnknown(node.payload)}</pre>
    </details>
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as Record<string, unknown>
}

function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content) === false) return ''
  let text = ''
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (typeof record.text === 'string') {
      text = text === '' ? record.text : `${text}\n${record.text}`
    } else if (record.content !== undefined) {
      const nested = textFromBlocks(record.content)
      if (nested !== '') text = text === '' ? nested : `${text}\n${nested}`
    }
  }
  return text
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function copyText(value: string): Promise<void> {
  if (navigator.clipboard === undefined) return Promise.resolve()
  return navigator.clipboard.writeText(value)
}