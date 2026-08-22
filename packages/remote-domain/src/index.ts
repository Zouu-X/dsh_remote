import type {
  DeviceId,
  EventId,
  HostId,
  SessionId,
  UserId,
} from '@dsh-remote/protocol'

/**
 * Domain vocabulary for the mobile UI. It is intentionally independent from
 * upstream DeepSeek Harness internal types; adapter-deepseek is the only
 * package allowed to know the upstream wire contract.
 */

export interface HostDescriptor {
  hostId: HostId
  version: string
  cwd: string
  provider?: string
  model?: string
  attachedSessions: number
  principalUserId: UserId
  principalDeviceId: DeviceId
}

export interface WorkspaceSummary {
  workspaceId: string
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceListResult {
  items: WorkspaceSummary[]
  archivedSessionIds: SessionId[]
}

export interface SessionSummary {
  sessionId: SessionId
  title?: string
  workspaceId?: string
  cwd?: string
  running: boolean
  blank: boolean
  updatedAt: number
  agentPreset?: string
  origin?: 'subagent'
  lastSeq: number
}

export interface SessionGroup {
  workspaceId: string | null
  title: string
  sessions: SessionSummary[]
}

export interface SessionEventView {
  eventId: EventId
  sessionId: SessionId
  sequence: number
  type: string
  payload: unknown
  timestamp: string
  /** Host-computed presentation view (terminal/diff/...). Opaque to domain logic. */
  view?: unknown
}

export interface SessionHistoryQuery {
  sessionId: SessionId
  /** Upstream `session.history` pages backwards from this sequence. */
  beforeSeq?: number
  maxMessages?: number
}

export interface SessionHistoryPage {
  sessionId: SessionId
  events: SessionEventView[]
  hasMore: boolean
}

export type PromptMode = 'queue' | 'steer'

export interface PromptInput {
  sessionId: SessionId
  mode: PromptMode
  text: string
}

export interface PromptResult {
  accepted: true
}

export interface SessionCreateInput {
  workspaceId?: string
  cwd?: string
  agentPreset?: string
}

export interface AgentPresetOption {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

export interface AgentPresetSelectInput {
  sessionId: SessionId
  agentPreset: string
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ModelReasoningEffort[]
    defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: Array<{ id: string; name: string; message: string }>
}

export interface SessionModelSelectInput extends ModelSelection {
  sessionId: SessionId
}

export interface WorkspaceCreateInput {
  path: string
}

export interface ApprovalRequest {
  sessionId: SessionId
  rpcId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export type ApprovalOutcome = 'allowed-once' | 'rejected'

export interface ApprovalDecision {
  sessionId: SessionId
  approvalId: string
  /** Echoes the pending upstream approval/requested rpcId. */
  rpcId: string
  outcome: ApprovalOutcome
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface QuestionRequest {
  sessionId: SessionId
  rpcId: string
  questions: QuestionItem[]
}

export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface QuestionDecision {
  sessionId: SessionId
  /** Echoes the pending upstream question/requested rpcId. */
  rpcId: string
  answer: { answers: QuestionAnswerItem[] }
}

export interface SessionSearchItem {
  sessionId: SessionId
  snippet: string
}

export interface RemoteApiMap {
  'host.describe': { payload: {}; result: HostDescriptor }
  'workspace.list': { payload: {}; result: WorkspaceListResult }
  'workspace.create': { payload: WorkspaceCreateInput; result: { workspace: WorkspaceSummary; created: boolean } }
  'session.list': { payload: {}; result: { items: SessionSummary[] } }
  'session.search': { payload: { query: string }; result: { items: SessionSearchItem[]; hasMore: boolean } }
  'session.create': { payload: SessionCreateInput; result: { sessionId: SessionId } }
  'agent-preset.list': { payload: {}; result: { items: AgentPresetOption[] } }
  'agent-preset.select': { payload: AgentPresetSelectInput; result: { agentPreset: string } }
  'session.history': { payload: SessionHistoryQuery; result: SessionHistoryPage }
  'session.models': { payload: { sessionId: SessionId }; result: SessionModels }
  'session.select-model': { payload: SessionModelSelectInput; result: { selected: ModelSelection } }
  'session.prompt': { payload: PromptInput; result: PromptResult }
  'approval.respond': { payload: ApprovalDecision; result: { accepted: boolean } }
  'question.respond': { payload: QuestionDecision; result: { accepted: boolean } }
}

export type RemoteMethod = keyof RemoteApiMap

export * from './review.js'

export function groupSessionsByWorkspace(
  sessions: SessionSummary[],
  workspaces: WorkspaceSummary[],
): SessionGroup[] {
  const titles = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace.title]))
  const groups = new Map<string, SessionGroup>()
  for (const session of sessions) {
    const key = session.workspaceId ?? 'ungrouped'
    const workspaceId = session.workspaceId ?? null
    let group = groups.get(key)
    if (group === undefined) {
      group = {
        workspaceId,
        title: workspaceId === null ? '未分组' : (titles.get(workspaceId) ?? workspaceId),
        sessions: [],
      }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  for (const group of groups.values()) {
    group.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return [...groups.values()].sort((a, b) => {
    if (a.workspaceId === null) return 1
    if (b.workspaceId === null) return -1
    return a.title.localeCompare(b.title)
  })
}

/** Matches the Harness browser's global list visibility rules for mobile task surfaces. */
export function visibleTaskSessions(
  sessions: SessionSummary[],
  archivedSessionIds: readonly SessionId[],
): SessionSummary[] {
  const archived = new Set(archivedSessionIds)
  return sessions.filter(session => (
    session.blank === false
    && session.origin !== 'subagent'
    && archived.has(session.sessionId) === false
  ))
}

/** Resolves the newest reusable blank session from the caller's recency-ordered list. */
export function reusableBlankSession(
  sessions: SessionSummary[],
  workspaceId: string,
  archivedSessionIds: readonly SessionId[],
): SessionSummary | undefined {
  const archived = new Set(archivedSessionIds)
  return sessions.find(session => (
    session.workspaceId === workspaceId
    && session.blank
    && !session.running
    && session.origin !== 'subagent'
    && archived.has(session.sessionId) === false
  ))
}
