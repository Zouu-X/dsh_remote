import { useEffect, useMemo, useRef, useState } from 'react'
import { buildReviewTimeline, groupSessionsByWorkspace } from '@dsh-remote/domain'
import type {
  ModelSelection,
  ReviewMessageNode,
  ReviewNode,
  ReviewToolNode,
  SessionHistoryPage,
  SessionModels,
  SessionSearchItem,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import { useRemote } from './use-remote.js'

type Tab = 'hosts' | 'tasks' | 'approval' | 'review' | 'new'

const COLLAPSED_WORKSPACES_STORAGE_KEY = 'dsh-remote:collapsed-workspaces'
const UNGROUPED_WORKSPACE_KEY = '__ungrouped__'

function storedCollapsedWorkspaces(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_WORKSPACES_STORAGE_KEY)
    if (raw === null) return new Set()
    const value = JSON.parse(raw) as unknown
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export default function App() {
  const remote = useRemote()
  const [tab, setTab] = useState<Tab>('tasks')
  const [promptText, setPromptText] = useState('')
  const attentionCount = remote.pendingApprovals.length + remote.pendingQuestions.length
  const selectedSession = remote.sessions.find(session => session.sessionId === remote.selectedSessionId) ?? null

  const openTask = (sessionId: string) => {
    remote.selectSession(sessionId)
    setTab('tasks')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-copy">
          <div className="eyebrow">DSH Remote</div>
          <strong>{pageTitle(tab, selectedSession)}</strong>
          <div className="connection-line">
            <span className={`connection-dot ${remote.connection}`} aria-hidden="true" />
            {remote.connection === 'open' ? 'Mac 在线' : remote.connection === 'connecting' ? '正在连接 Mac' : '连接中断，自动重试'}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" aria-label="刷新" onClick={() => void remote.refreshAll()}>↻</button>
          <button className="host-button" onClick={() => setTab('hosts')}>
            <span>{hostLabel(remote.host)}</span>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </header>

      {(remote.error || remote.gapNotice || remote.connection === 'reconnecting') && (
        <div className={`notice${remote.connection === 'reconnecting' && remote.error === '' ? ' reconnecting' : ''}`}>
          {remote.error && <div>{remote.error}</div>}
          {remote.gapNotice && <div>{remote.gapNotice}</div>}
          {remote.connection === 'reconnecting' && remote.error === '' && remote.gapNotice === '' && (
            <div>网络连接已中断。浏览仍可继续，写操作恢复后再提交。</div>
          )}
        </div>
      )}

      <main>
        {tab === 'hosts' && <HostsView workspaces={remote.workspaces} sessions={remote.visibleSessions} health={remote.health} host={remote.host} onCreateWorkspace={path => void remote.createWorkspace(path)} />}
        {tab === 'tasks' && (
          <TasksView
            sessions={remote.visibleSessions}
            searchResults={remote.searchResults}
            workspaces={remote.workspaces}
            onSearch={remote.searchSessions}
            selectedSessionId={remote.selectedSessionId}
            history={remote.history}
            historyLoading={remote.historyLoading}
            queuedItems={remote.queuedItems}
            pendingApprovals={remote.pendingApprovals}
            pendingQuestions={remote.pendingQuestions}
            promptText={promptText}
            setPromptText={setPromptText}
            onSelect={remote.selectSession}
            onNew={() => setTab('new')}
            onReview={() => setTab('review')}
            onOpenApproval={() => setTab('approval')}
            onSend={remote.sendPrompt}
            sessionModels={remote.sessionModels}
            modelsLoading={remote.modelsLoading}
            onLoadModels={remote.refreshSessionModels}
            onSelectModel={remote.selectSessionModel}
          />
        )}
        {tab === 'approval' && (
          <ApprovalView
            approvals={remote.pendingApprovals}
            questions={remote.pendingQuestions}
            approvalDisplays={remote.approvalDisplays}
            resolvedApprovals={remote.resolvedApprovals}
            questionDrafts={remote.questionDrafts}
            onUpdateDraft={remote.updateQuestionDraft}
            onApprove={request => remote.respondApproval(request, 'allowed-once')}
            onReject={request => remote.respondApproval(request, 'rejected')}
            onAnswer={remote.respondQuestion}
            onOpenTask={openTask}
          />
        )}
        {tab === 'review' && (
          <ReviewView
            sessions={remote.visibleSessions}
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
        {tab === 'new' && (
          <NewTaskView
            workspaces={remote.workspaces}
            connection={remote.connection}
            agentPresets={remote.agentPresets}
            sessionModels={remote.sessionModels}
            modelsLoading={remote.modelsLoading}
            onCreate={remote.createSession}
            onSelectPreset={remote.selectAgentPreset}
            onLoadModels={remote.refreshSessionModels}
            onSelectModel={remote.selectSessionModel}
            onSend={remote.sendPrompt}
            onComplete={() => setTab('tasks')}
          />
        )}
      </main>

      <nav className="tabs">
        <TabButton
          icon="◫"
          label="Tasks"
          active={tab === 'tasks'}
          onClick={() => {
            if (tab === 'tasks') remote.selectSession(null)
            setTab('tasks')
          }}
        />
        <TabButton icon="✓" label="Approve" badge={attentionCount} active={tab === 'approval'} onClick={() => setTab('approval')} />
        <TabButton icon="±" label="记录" active={tab === 'review'} onClick={() => setTab('review')} />
        <TabButton icon="＋" label="New task" active={tab === 'new'} primary onClick={() => setTab('new')} />
      </nav>
    </div>
  )
}

function pageTitle(tab: Tab, selected: SessionSummary | null): string {
  if (tab === 'hosts') return 'Host 与工作区'
  if (tab === 'approval') return '等待处理'
  if (tab === 'review') return '执行记录'
  if (tab === 'new') return '新任务'
  return selected?.title ?? '任务'
}

function hostLabel(host: ReturnType<typeof useRemote>['host']): string {
  if (host === null) return 'Host'
  return host.hostId.length > 11 ? `${host.hostId.slice(0, 8)}…` : host.hostId
}

function clientActionId(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`
}

function TabButton(props: {
  active: boolean
  onClick: () => void
  icon: string
  label: string
  badge?: number
  primary?: boolean
}) {
  return (
    <button
      className={`tab${props.active ? ' active' : ''}${props.primary === true ? ' primary' : ''}`}
      onClick={props.onClick}
    >
      <span className="tab-icon" aria-hidden="true">{props.icon}</span>
      <span>{props.label}</span>
      {(props.badge ?? 0) > 0 && <span className="tab-badge">{props.badge}</span>}
    </button>
  )
}

function HostsView(props: {
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  health: ReturnType<typeof useRemote>['health']
  host: ReturnType<typeof useRemote>['host']
  onCreateWorkspace: (path: string) => void
}) {
  const [workspacePath, setWorkspacePath] = useState('')
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false)

  return (
    <section className="page-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow">运行环境</div>
          <h2>Host</h2>
        </div>
      </div>
      {props.host !== null && (
        <div className="card host-card">
          <div className="row">
            <div>
              <strong>{hostLabel(props.host)}</strong>
              <div className="muted path-line">{props.host.cwd}</div>
            </div>
            <span className="status running">在线</span>
          </div>
          <div className="host-stats">
            <div><strong>{props.host.model ?? '-'}</strong><span>模型</span></div>
            <div><strong>{props.host.attachedSessions}</strong><span>已连接任务</span></div>
            <div><strong>{props.workspaces.length}</strong><span>工作区</span></div>
          </div>
          {props.health !== null && (
            <div className="device-line">当前设备 · {props.health.principal.deviceName ?? props.health.principal.deviceId}</div>
          )}
        </div>
      )}
      <div className="section-heading row">
        <div>
          <div className="eyebrow">项目目录</div>
          <h2>Workspaces</h2>
        </div>
        <button className="ghost small" onClick={() => setShowWorkspaceForm(value => !value)}>
          {showWorkspaceForm ? '取消' : '添加'}
        </button>
      </div>
      {showWorkspaceForm && (
        <div className="card workspace-form">
          <label htmlFor="workspace-path">Mac 上已有目录</label>
          <input
            id="workspace-path"
            value={workspacePath}
            onChange={event => setWorkspacePath(event.target.value)}
            placeholder="~/Projects/新目录"
          />
          <div className="muted">必须是 Mac 上已存在的目录。</div>
          <button
            disabled={workspacePath.trim() === ''}
            onClick={() => {
              props.onCreateWorkspace(workspacePath.trim())
              setWorkspacePath('')
              setShowWorkspaceForm(false)
            }}
          >
            添加 Workspace
          </button>
        </div>
      )}
      {props.workspaces.map(workspace => (
        <div className="card workspace-card" key={workspace.workspaceId}>
          <div><strong>{workspace.title}</strong></div>
          <div className="muted path-line">{workspace.path}</div>
          <div className="workspace-count">
            {props.sessions.filter(session => session.workspaceId === workspace.workspaceId).length} 个任务
          </div>
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
  historyLoading: boolean
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  pendingApprovals: ReturnType<typeof useRemote>['pendingApprovals']
  pendingQuestions: ReturnType<typeof useRemote>['pendingQuestions']
  promptText: string
  setPromptText: (value: string) => void
  onSelect: (sessionId: string | null) => void
  onNew: () => void
  onReview: () => void
  onOpenApproval: () => void
  onSend: (sessionId: string, text: string, mode?: 'queue' | 'steer', idempotencyKey?: string) => Promise<boolean>
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onLoadModels: (sessionId: string) => Promise<SessionModels | null>
  onSelectModel: (input: ModelSelection & { sessionId: string }) => Promise<boolean>
}) {
  const selected = props.sessions.find(session => session.sessionId === props.selectedSessionId) ?? null
  const [searchText, setSearchText] = useState('')
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState(storedCollapsedWorkspaces)
  const groups = useMemo(
    () => groupSessionsByWorkspace(props.sessions, props.workspaces),
    [props.sessions, props.workspaces],
  )
  const attentionBySession = useMemo(() => {
    const counts = new Map<string, number>()
    for (const request of props.pendingApprovals) counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1)
    for (const request of props.pendingQuestions) counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1)
    return counts
  }, [props.pendingApprovals, props.pendingQuestions])

  useEffect(() => {
    const timer = window.setTimeout(() => props.onSearch(searchText), 250)
    return () => window.clearTimeout(timer)
  }, [searchText, props.onSearch])

  const toggleWorkspace = (workspaceKey: string) => {
    setCollapsedWorkspaces(previous => {
      const next = new Set(previous)
      if (next.has(workspaceKey)) next.delete(workspaceKey)
      else next.add(workspaceKey)
      try {
        window.localStorage.setItem(COLLAPSED_WORKSPACES_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Keep folding functional when storage is unavailable (for example, private browsing restrictions).
      }
      return next
    })
  }

  if (selected !== null) {
    return (
      <section className="page-section task-detail-page">
        <SessionDetail
          session={selected}
          history={props.history}
          historyLoading={props.historyLoading}
          queuedItems={props.queuedItems}
          attentionCount={attentionBySession.get(selected.sessionId) ?? 0}
          promptText={props.promptText}
          setPromptText={props.setPromptText}
          onBack={() => props.onSelect(null)}
          onReview={props.onReview}
          onOpenApproval={props.onOpenApproval}
          onSend={(text, mode, idempotencyKey) => props.onSend(selected.sessionId, text, mode, idempotencyKey)}
          sessionModels={props.sessionModels}
          modelsLoading={props.modelsLoading}
          onLoadModels={() => props.onLoadModels(selected.sessionId)}
          onSelectModel={selection => props.onSelectModel({ sessionId: selected.sessionId, ...selection })}
        />
      </section>
    )
  }

  return (
    <section className="page-section">
      <div className="section-heading row">
        <div>
          <div className="eyebrow">最近活动</div>
          <h2>Tasks</h2>
        </div>
        <button onClick={props.onNew}>新任务</button>
      </div>

      <input
        className="search"
        value={searchText}
        onChange={event => setSearchText(event.target.value)}
        placeholder="搜索任务、目录或 Session ID"
        aria-label="搜索任务"
      />

      {searchText.trim() !== '' && (
        <div className="search-results">
          {props.searchResults.length === 0 && <div className="muted">无结果</div>}
          {props.searchResults.map(result => (
            <button
              className="session-row"
              key={result.sessionId}
              onClick={() => {
                setSearchText('')
                props.onSelect(result.sessionId)
              }}
            >
              <span className="session-title">{sessionTitle(props.sessions, result.sessionId)}</span>
              <span className="muted">{result.snippet}</span>
            </button>
          ))}
        </div>
      )}

      {groups.map((group, index) => {
        const workspaceKey = group.workspaceId ?? UNGROUPED_WORKSPACE_KEY
        const collapsed = collapsedWorkspaces.has(workspaceKey)
        const sessionListId = `workspace-sessions-${index}`
        return (
          <div className={`group${collapsed ? ' collapsed' : ''}`} key={workspaceKey}>
            <button
              className="group-heading"
              type="button"
              aria-expanded={!collapsed}
              aria-controls={sessionListId}
              onClick={() => toggleWorkspace(workspaceKey)}
            >
              <span className="group-heading-title">
                <span className="workspace-disclosure" aria-hidden="true">⌄</span>
                <span>{group.title}</span>
              </span>
              <span className="workspace-task-count">{group.sessions.length}</span>
            </button>
            {!collapsed && (
              <div id={sessionListId}>
                {group.sessions.map(session => (
                  <button
                    className="session-row task-row"
                    key={session.sessionId}
                    onClick={() => props.onSelect(session.sessionId)}
                  >
                    <span className="task-row-main">
                      <span className={`task-state-dot${session.running ? ' running' : ''}`} aria-hidden="true" />
                      <span className="session-title">{session.title ?? session.sessionId.slice(0, 13)}</span>
                      {(attentionBySession.get(session.sessionId) ?? 0) > 0 && (
                        <span className="attention-badge">需处理 {attentionBySession.get(session.sessionId)}</span>
                      )}
                      <span className="chevron" aria-hidden="true">›</span>
                    </span>
                    <span className="task-row-meta">
                      <span>{session.running ? '运行中' : session.blank ? '尚未开始' : '已暂停'}</span>
                      <span>·</span>
                      <span>{relativeTime(session.updatedAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {props.sessions.length === 0 && (
        <div className="empty-state">
          <strong>还没有任务</strong>
          <span>选择一个 Workspace，直接从手机发起第一项工作。</span>
          <button onClick={props.onNew}>创建任务</button>
        </div>
      )}
    </section>
  )
}

function sessionTitle(sessions: SessionSummary[], sessionId: string): string {
  const session = sessions.find(item => item.sessionId === sessionId)
  return session?.title ?? sessionId.slice(0, 13)
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

function SessionDetail(props: {
  session: SessionSummary
  history: SessionHistoryPage | null
  historyLoading: boolean
  queuedItems: ReturnType<typeof useRemote>['queuedItems']
  attentionCount: number
  promptText: string
  setPromptText: (value: string) => void
  onBack: () => void
  onReview: () => void
  onOpenApproval: () => void
  onSend: (text: string, mode: 'queue' | 'steer', idempotencyKey: string) => Promise<boolean>
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onLoadModels: () => Promise<SessionModels | null>
  onSelectModel: (selection: ModelSelection) => Promise<boolean>
}) {
  const nodes = useMemo(() => buildReviewTimeline(props.history?.events ?? []), [props.history])
  const lastMessage = useMemo(
    () => [...nodes].reverse().find((node): node is ReviewMessageNode => node.kind === 'message' && node.role === 'assistant'),
    [nodes],
  )
  const [messageExpanded, setMessageExpanded] = useState(false)
  const [sending, setSending] = useState(false)
  const retryActionRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const messageText = lastMessage?.text ?? ''
  const messageVisible = messageExpanded || messageText.length <= 280
    ? messageText
    : `${messageText.slice(0, 280)}…`

  const submit = async (mode: 'queue' | 'steer') => {
    const text = props.promptText.trim()
    if (text === '' || sending) return
    const fingerprint = `${mode}\u0000${text}`
    if (retryActionRef.current?.fingerprint !== fingerprint) {
      retryActionRef.current = { fingerprint, key: clientActionId('prompt') }
    }
    setSending(true)
    const sent = await props.onSend(text, mode, retryActionRef.current.key)
    setSending(false)
    if (sent) {
      retryActionRef.current = null
      props.setPromptText('')
    }
  }

  return (
    <div className="session-detail">
      <button className="back-button" onClick={props.onBack}>‹ 返回任务</button>
      <div className="task-hero">
        <div className="row">
          <strong>{props.session.title ?? '未命名任务'}</strong>
          <span className={`status ${props.session.running ? 'running' : 'idle'}`}>
            {props.session.running ? '运行中' : props.session.blank ? '尚未开始' : '已暂停'}
          </span>
        </div>
        <div className="muted task-path">{props.session.cwd ?? props.session.sessionId}</div>
        <div className="task-actions">
          <button className="review-action ghost" onClick={props.onReview}>
            <span className="review-action-copy">
              <strong>查看完整执行过程</strong>
              <span>完整对话、工具调用、终端输出与执行结果</span>
            </span>
            <span className="review-action-arrow" aria-hidden="true">›</span>
          </button>
          {props.attentionCount > 0 && (
            <button className="attention-action small" onClick={props.onOpenApproval}>
              处理 {props.attentionCount} 个待办
            </button>
          )}
        </div>
      </div>

      {lastMessage !== undefined && (
        <div className="last-message">
          <div className="muted">Agent 最新回复</div>
          <div className="message-text">{messageVisible}</div>
          {messageText.length > 280 && (
            <button className="ghost small" onClick={() => setMessageExpanded(value => !value)}>
              {messageExpanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}

      {props.historyLoading && props.history === null && <div className="card muted">正在同步任务进度…</div>}

      {lastMessage === undefined && props.historyLoading === false && (
        <div className="empty-state compact">
          <strong>{props.session.blank ? '描述你要完成的工作' : '暂无可展示的消息'}</strong>
          <span>指令会在这台 Mac 上的当前安全策略下执行。</span>
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

      <div className="task-composer">
        <ModelControls
          models={props.sessionModels}
          loading={props.modelsLoading}
          onLoad={props.onLoadModels}
          onSelect={props.onSelectModel}
        />
        <textarea
          value={props.promptText}
          onChange={event => props.setPromptText(event.target.value)}
          placeholder={props.session.running ? '追加说明或调整方向…' : '发送下一条指令…'}
          rows={3}
        />
        <div className="composer-actions">
          {props.session.running && (
            <button
              className="ghost"
              disabled={sending || props.promptText.trim() === ''}
              onClick={() => void submit('queue')}
            >
              排到下一轮
            </button>
          )}
          <button
            disabled={sending || props.promptText.trim() === ''}
            onClick={() => void submit(props.session.running ? 'steer' : 'queue')}
          >
            {sending ? '发送中…' : props.session.running ? '立即追加' : '发送指令'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModelControls(props: {
  models: SessionModels | null
  loading: boolean
  onLoad: () => Promise<SessionModels | null>
  onSelect: (selection: ModelSelection) => Promise<boolean>
}) {
  const [selecting, setSelecting] = useState(false)
  const current = props.models?.current
  const currentModel = props.models?.groups
    .find(group => group.id === current?.provider)
    ?.models.find(model => model.id === current?.model)
  const efforts = currentModel?.reasoning?.efforts ?? []

  const apply = async (selection: ModelSelection) => {
    if (selecting) return
    setSelecting(true)
    await props.onSelect(selection)
    setSelecting(false)
  }

  if (props.models === null) {
    return (
      <button className="model-setup-button ghost" disabled={props.loading} onClick={() => void props.onLoad()}>
        {props.loading ? '正在读取模型…' : '读取模型设置'}
      </button>
    )
  }

  return (
    <div className="model-controls" aria-label="模型与思考强度">
      <label>
        <span>模型</span>
        <select
          aria-label="模型"
          value={JSON.stringify([current?.provider ?? '', current?.model ?? ''])}
          disabled={selecting || props.loading}
          onChange={event => {
            const [provider, model] = JSON.parse(event.target.value) as [string, string]
            const nextModel = props.models?.groups.find(group => group.id === provider)?.models.find(item => item.id === model)
            void apply({
              provider,
              model,
              ...(nextModel?.reasoning?.defaultEffort !== undefined && { reasoningEffort: nextModel.reasoning.defaultEffort }),
            })
          }}
        >
          {props.models.groups.map(group => (
            <optgroup key={group.id} label={group.name}>
              {group.models.map(model => (
                <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label>
        <span>思考强度</span>
        <select
          aria-label="思考强度"
          value={current?.reasoningEffort ?? ''}
          disabled={selecting || props.loading || efforts.length === 0}
          onChange={event => {
            if (current === undefined) return
            void apply({
              provider: current.provider,
              model: current.model,
              ...(event.target.value !== '' && { reasoningEffort: event.target.value }),
            })
          }}
        >
          {current?.reasoningEffort === undefined && <option value="">默认</option>}
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select>
      </label>
      {(selecting || props.loading) && <span className="model-status">正在应用…</span>}
      {props.models.routable === false && <span className="model-status danger-text">当前模型路由不可用</span>}
    </div>
  )
}

function NewTaskView(props: {
  workspaces: WorkspaceSummary[]
  connection: ReturnType<typeof useRemote>['connection']
  agentPresets: ReturnType<typeof useRemote>['agentPresets']
  sessionModels: SessionModels | null
  modelsLoading: boolean
  onCreate: (workspaceId?: string, idempotencyKey?: string, agentPreset?: string) => Promise<string | null>
  onSelectPreset: (sessionId: string, agentPreset: string) => Promise<boolean>
  onLoadModels: (sessionId: string) => Promise<SessionModels | null>
  onSelectModel: (input: ModelSelection & { sessionId: string }) => Promise<boolean>
  onSend: (sessionId: string, text: string, mode?: 'queue' | 'steer', idempotencyKey?: string) => Promise<boolean>
  onComplete: () => void
}) {
  const [workspaceId, setWorkspaceId] = useState('')
  const [text, setText] = useState('')
  const defaultPreset = props.agentPresets.find(preset => preset.isDefault && preset.broken === undefined)?.id ?? ''
  const [agentPreset, setAgentPreset] = useState('')
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null)
  const [promptAttempted, setPromptAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [presetSelecting, setPresetSelecting] = useState(false)
  const createRetryRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const promptRetryRef = useRef<{ fingerprint: string; key: string } | null>(null)
  const effectivePreset = agentPreset || defaultPreset

  const prepareSession = async (): Promise<string | null> => {
    if (createdSessionId !== null) return createdSessionId
    if (workspaceId === '') return null
    const fingerprint = `${workspaceId}\u0000${effectivePreset}`
    if (createRetryRef.current?.fingerprint !== fingerprint) {
      createRetryRef.current = { fingerprint, key: clientActionId('session-create') }
    }
    const sessionId = await props.onCreate(
      workspaceId,
      createRetryRef.current.key,
      effectivePreset || undefined,
    )
    if (sessionId !== null) setCreatedSessionId(sessionId)
    return sessionId
  }

  const configureModels = async () => {
    if (submitting || presetSelecting || props.connection !== 'open') return
    setSubmitting(true)
    const sessionId = await prepareSession()
    if (sessionId !== null) await props.onLoadModels(sessionId)
    setSubmitting(false)
  }

  const submit = async () => {
    if (text.trim() === '' || submitting || presetSelecting || props.connection !== 'open') return
    setSubmitting(true)
    let sessionId = createdSessionId
    if (sessionId === null) {
      sessionId = await prepareSession()
    }
    const prompt = text.trim()
    if (promptRetryRef.current?.fingerprint !== prompt) {
      promptRetryRef.current = { fingerprint: prompt, key: clientActionId('prompt') }
    }
    const sent = sessionId === null
      ? false
      : await props.onSend(sessionId, prompt, 'queue', promptRetryRef.current.key)
    setPromptAttempted(sessionId !== null && sent === false)
    setSubmitting(false)
    if (sent) {
      setText('')
      props.onComplete()
    }
  }

  return (
    <section className="page-section new-task-page">
      <div className="new-task-intro">
        <div className="new-task-mark" aria-hidden="true">＋</div>
        <div>
          <h2>从手机开始一项工作</h2>
          <p>选择 Mac 上的项目，描述目标；创建后可随时离开页面并继续跟进。</p>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-workspace">Workspace</label>
        <select
          id="new-task-workspace"
          value={workspaceId}
          disabled={submitting || createdSessionId !== null}
          onChange={event => setWorkspaceId(event.target.value)}
        >
          <option value="" disabled>请选择 Mac 上的 Workspace</option>
          {props.workspaces.map(workspace => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
          ))}
        </select>
        <span className="form-hint">
          {workspaceId === ''
            ? props.workspaces.length === 0
              ? '电脑端尚未配置 Workspace，请先在 DSH 网页端添加。'
              : '仅可选择已从电脑端同步的 Workspace。'
            : props.workspaces.find(item => item.workspaceId === workspaceId)?.path}
        </span>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-mode">工作模式</label>
        <select
          id="new-task-mode"
          value={effectivePreset}
          disabled={submitting || presetSelecting}
          onChange={event => {
            const next = event.target.value
            const previous = effectivePreset
            setAgentPreset(next)
            if (createdSessionId !== null) {
              setPresetSelecting(true)
              void props.onSelectPreset(createdSessionId, next).then(selected => {
                if (!selected) setAgentPreset(previous)
                setPresetSelecting(false)
              })
            }
          }}
        >
          {props.agentPresets.filter(preset => preset.broken === undefined).map(preset => (
            <option key={preset.id} value={preset.id}>
              {preset.name ?? preset.id}{preset.trust === 'user' ? '（自定义）' : ''}
            </option>
          ))}
        </select>
        <span className="form-hint">
          {props.agentPresets.find(preset => preset.id === effectivePreset)?.description ?? '选择这个任务可使用的 Agent 工具组合。'}
        </span>
      </div>

      <div className="form-group">
        <label>模型与思考强度</label>
        {createdSessionId === null ? (
          <button className="model-setup-button ghost" disabled={workspaceId === '' || submitting || presetSelecting || props.connection !== 'open'} onClick={() => void configureModels()}>
            {submitting ? '正在准备 Session…' : '设置模型与思考强度'}
          </button>
        ) : (
          <ModelControls
            models={props.sessionModels}
            loading={props.modelsLoading}
            onLoad={() => props.onLoadModels(createdSessionId)}
            onSelect={selection => props.onSelectModel({ sessionId: createdSessionId, ...selection })}
          />
        )}
        <span className="form-hint">不设置时沿用 Harness 默认值；准备后选择会立即写入这个 Session。</span>
      </div>

      <div className="form-group">
        <label htmlFor="new-task-prompt">任务说明</label>
        <textarea
          id="new-task-prompt"
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder="例如：检查手机端断线重连逻辑，修复问题并运行相关测试"
          rows={8}
        />
        <span className="form-hint">写清目标、约束和完成标准，后续仍可继续追加指令。</span>
      </div>

      {createdSessionId !== null && (
        <div className="retry-note">
          {promptAttempted
            ? 'Session 已创建。再次提交会继续使用同一个 Session，不会重复创建。'
            : '模型设置已绑定到一个空白 Session；发送任务时会继续使用它。'}
        </div>
      )}
      {props.connection !== 'open' && (
        <div className="retry-note">等待 Mac 重新连线后即可创建，当前输入会保留。</div>
      )}

      <button
        className="start-task-button"
        disabled={workspaceId === '' || text.trim() === '' || submitting || presetSelecting || props.connection !== 'open'}
        onClick={() => void submit()}
      >
        {submitting ? '正在启动…' : promptAttempted ? '重试发送任务' : '在 Mac 上开始任务'}
      </button>
    </section>
  )
}

function ApprovalView(props: {
  approvals: ReturnType<typeof useRemote>['pendingApprovals']
  questions: ReturnType<typeof useRemote>['pendingQuestions']
  approvalDisplays: ReturnType<typeof useRemote>['approvalDisplays']
  resolvedApprovals: ReturnType<typeof useRemote>['resolvedApprovals']
  questionDrafts: ReturnType<typeof useRemote>['questionDrafts']
  onUpdateDraft: (rpcId: string, answers: ReturnType<typeof useRemote>['questionDrafts'][string]) => void
  onApprove: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => Promise<boolean>
  onReject: (request: ReturnType<typeof useRemote>['pendingApprovals'][number]) => Promise<boolean>
  onAnswer: (
    request: ReturnType<typeof useRemote>['pendingQuestions'][number],
    answers: ReturnType<typeof useRemote>['questionDrafts'][string],
  ) => Promise<boolean>
  onOpenTask: (sessionId: string) => void
}) {
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({})
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const total = props.approvals.length + props.questions.length

  const runAction = async (key: string, action: () => Promise<boolean>) => {
    if (pendingAction !== null) return
    setPendingAction(key)
    await action()
    setPendingAction(null)
  }

  return (
    <section className="page-section approval-page">
      <div className="section-heading">
        <div className="eyebrow">需要你的判断</div>
        <h2>{total > 0 ? `${total} 个待办` : '当前没有待办'}</h2>
        <p className="section-description">权限请求只允许一次；问题回答会直接影响 Agent 接下来的工作。</p>
      </div>

      {total === 0 && (
        <div className="empty-state approval-empty">
          <span className="empty-check" aria-hidden="true">✓</span>
          <strong>都处理完了</strong>
          <span>Agent 需要权限或补充信息时，会显示在这里。</span>
        </div>
      )}

      {props.approvals.length > 0 && <h3 className="subsection-title">权限请求</h3>}
      {props.approvals.map(request => {
        const display = props.approvalDisplays[request.approvalId]
        const busy = pendingAction === `approval:${request.approvalId}`
        return (
          <div className="card attention-card" key={request.approvalId}>
            <div className="attention-card-head">
              <span className="attention-icon" aria-hidden="true">!</span>
              <div>
                <div className="eyebrow">Permission requested</div>
                <strong>{display?.toolTitle ?? request.toolName}</strong>
              </div>
            </div>
            <button className="context-link" onClick={() => props.onOpenTask(request.sessionId)}>
              打开关联任务 <span aria-hidden="true">›</span>
            </button>
            <div className="approval-reason">{request.reason ?? 'Agent 请求执行此操作'}</div>
            {display?.argumentsText !== undefined && (
              <details className="reasoning">
                <summary>工具调用参数</summary>
                <pre className="preview">{display.argumentsText}</pre>
              </details>
            )}
            <div className="approval-actions">
              <button
                disabled={pendingAction !== null}
                onClick={() => void runAction(`approval:${request.approvalId}`, () => props.onApprove(request))}
              >
                {busy ? '提交中…' : '允许一次'}
              </button>
              <button
                className="danger secondary"
                disabled={pendingAction !== null}
                onClick={() => void runAction(`approval:${request.approvalId}`, () => props.onReject(request))}
              >
                拒绝
              </button>
            </div>
          </div>
        )
      })}

      {props.questions.length > 0 && <h3 className="subsection-title">Agent 问题</h3>}
      {props.questions.map(request => {
        const draft = props.questionDrafts[request.rpcId] ?? []
        const busy = pendingAction === `question:${request.rpcId}`
        return (
          <div className="card attention-card question-card" key={request.rpcId}>
            <button className="context-link" onClick={() => props.onOpenTask(request.sessionId)}>
              打开关联任务 <span aria-hidden="true">›</span>
            </button>
            {request.questions.map(question => {
              const answer = draft.find(item => item.id === question.id)
              const selected = new Set(answer?.selected ?? [])
              return (
                <div className="question-block" key={question.id}>
                  <div><strong>{question.header ?? question.question}</strong></div>
                  <div className="muted">{question.question}</div>
                  <div className="options">
                    {(question.options ?? []).map(option => {
                      const active = selected.has(option.label)
                      return (
                        <button
                          className={`option${active ? ' active' : ''}`}
                          key={option.label}
                          onClick={() => {
                            const nextSelected = question.multiSelect === true
                              ? (active
                                  ? selectedValues(selected, option.label, true)
                                  : selectedValues(selected, option.label, false))
                              : [option.label]
                            props.onUpdateDraft(request.rpcId, draft.map(item =>
                              item.id === question.id ? { ...item, selected: nextSelected } : item,
                            ))
                          }}
                        >
                          {option.label}
                          {option.description !== undefined && <span className="muted"> · {option.description}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <input
                    placeholder="自定义答案（可选）"
                    value={customAnswers[`${request.rpcId}:${question.id}`] ?? ''}
                    onChange={event => setCustomAnswers(previous => ({
                      ...previous,
                      [`${request.rpcId}:${question.id}`]: event.target.value,
                    }))}
                  />
                </div>
              )
            })}
            <button
              disabled={pendingAction !== null}
              onClick={() => void runAction(`question:${request.rpcId}`, async () => {
                const answers = draft.map(answer => {
                  const customValue = customAnswers[`${request.rpcId}:${answer.id}`]?.trim()
                  return {
                    ...answer,
                    ...(customValue ? { custom: customValue } : {}),
                  }
                })
                props.onUpdateDraft(request.rpcId, answers)
                return props.onAnswer(request, answers)
              })}
            >
              {busy ? '提交中…' : '提交回答'}
            </button>
          </div>
        )
      })}

      {props.resolvedApprovals.length > 0 && (
        <details className="resolved-section">
          <summary>最近审批记录（{props.resolvedApprovals.length}）</summary>
          {props.resolvedApprovals.map(item => (
            <div className="resolved-row" key={`${item.request.approvalId}:${item.resolvedAt}`}>
              <span>{item.display?.toolTitle ?? item.request.toolName}</span>
              <span className={`badge ${item.outcome === 'allowed-once' ? 'assistant' : 'tool'}`}>
                {item.outcome === 'allowed-once' ? '已允许一次' : '已拒绝'}
              </span>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}

function selectedValues(selected: Set<string>, label: string, remove: boolean): string[] {
  const next = [...selected]
  if (remove) return next.filter(value => value !== label)
  if (!next.includes(label)) next.push(label)
  return next
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
      <h2>执行记录</h2>

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
        <select value={filter} onChange={event => setFilter(event.target.value as ReviewFilter)} aria-label="筛选执行记录">
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
