import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RemoteSequenceTracker } from '@dsh-remote/client'
import { reusableBlankSession, visibleTaskSessions } from '@dsh-remote/domain'
import type {
  AgentPresetOption,
  ApprovalDecision,
  ApprovalRequest,
  HostDescriptor,
  QuestionAnswerItem,
  QuestionDecision,
  QuestionRequest,
  SessionEventView,
  SessionHistoryPage,
  SessionModels,
  SessionModelSelectInput,
  SessionSearchItem,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-remote/domain'
import type { RemoteEventEnvelope, RemoteEventStream, RemoteHostHealth } from '@dsh-remote/protocol'
import { transport } from './transport.js'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting'

interface LiveSessionEvent {
  event: {
    type: string
    seq: number
    time: number
    data: unknown
  }
  view?: unknown
}

function asApprovalRequest(payload: unknown): ApprovalRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (
    typeof value.sessionId === 'string'
    && typeof value.rpcId === 'string'
    && typeof value.approvalId === 'string'
    && typeof value.toolName === 'string'
  ) {
    return {
      sessionId: value.sessionId,
      rpcId: value.rpcId,
      approvalId: value.approvalId,
      toolName: value.toolName,
      ...(typeof value.callId === 'string' && { callId: value.callId }),
      ...(typeof value.reason === 'string' && { reason: value.reason }),
    }
  }
  return undefined
}

function asQuestionRequest(payload: unknown): QuestionRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.sessionId === 'string' && typeof value.rpcId === 'string' && Array.isArray(value.questions)) {
    return {
      sessionId: value.sessionId,
      rpcId: value.rpcId,
      questions: value.questions as QuestionRequest['questions'],
    }
  }
  return undefined
}

export interface RemoteQueuedItem {
  id: string
  placement: 'queued' | 'steering' | 'context'
  text: string
}

export interface ApprovalDisplay {
  request: ApprovalRequest
  toolTitle: string
  argumentsText?: string
  callView?: unknown
}

export interface ResolvedApproval {
  request: ApprovalRequest
  outcome: string
  display?: ApprovalDisplay
  resolvedAt: string
}

function asQueuedItems(payload: unknown): RemoteQueuedItem[] {
  if (typeof payload !== 'object' || payload === null) return []
  const value = payload as Record<string, unknown>
  if (Array.isArray(value.items) === false) return []
  const items: RemoteQueuedItem[] = []
  for (const entry of value.items) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : ''
    const placement = item.placement === 'steering' || item.placement === 'context' ? item.placement : 'queued'
    const message = item.message as Record<string, unknown> | undefined
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
      .map(block => typeof block.text === 'string' ? block.text : '')
      .join(' ')
      .trim()
    if (id === '' || text === '') continue
    items.push({ id, placement, text })
  }
  return items
}

function asLiveSessionEvent(payload: unknown): LiveSessionEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = payload as Record<string, unknown>
  if (typeof value.event !== 'object' || value.event === null) return undefined
  const event = value.event as Record<string, unknown>
  if (typeof event.type === 'string' && typeof event.seq === 'number' && typeof event.time === 'number') {
    return {
      event: {
        type: event.type,
        seq: event.seq,
        time: event.time,
        data: event.data,
      },
      ...(value.view !== undefined && { view: value.view }),
    }
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function toolTitleFor(request: ApprovalRequest, event: SessionEventView | undefined): string {
  const view = record(record(event?.view)?.view)
  const viewTitle = typeof view?.title === 'string' ? view.title : undefined
  if (viewTitle !== undefined && viewTitle.trim() !== '') return viewTitle
  const payload = record(event?.payload)
  const argumentsText = payload?.arguments
  if (typeof argumentsText === 'string') {
    try {
      const parsed = JSON.parse(argumentsText) as unknown
      const parsedRecord = record(parsed)
      const command = typeof parsedRecord?.command === 'string' ? parsedRecord.command : undefined
      if (command !== undefined && command.trim() !== '') return command
      const filePath = typeof parsedRecord?.file_path === 'string' ? parsedRecord.file_path : undefined
      if (filePath !== undefined) return `写文件 ${filePath}`
    } catch {
      return argumentsText
    }
  }
  return request.toolName
}

function argumentsTextFor(event: SessionEventView | undefined): string | undefined {
  const argumentsValue = record(event?.payload)?.arguments
  if (typeof argumentsValue === 'string') return argumentsValue
  if (argumentsValue !== undefined) return JSON.stringify(argumentsValue)
  return undefined
}

function defaultQuestionAnswers(request: QuestionRequest): QuestionAnswerItem[] {
  return request.questions.map(question => ({
    id: question.id,
    selected: question.options?.[0] ? [question.options[0].label] : [],
  }))
}

export function useRemote() {
  const trackerRef = useRef(new RemoteSequenceTracker())
  const rebaselineStreamsRef = useRef(new Set<RemoteEventStream>())
  const selectedSessionIdRef = useRef<string | null>(null)
  const [health, setHealth] = useState<RemoteHostHealth | null>(null)
  const [host, setHost] = useState<HostDescriptor | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [archivedSessionIds, setArchivedSessionIds] = useState<string[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [agentPresets, setAgentPresets] = useState<AgentPresetOption[]>([])
  const [sessionModels, setSessionModels] = useState<SessionModels | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<SessionSearchItem[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [history, setHistory] = useState<SessionHistoryPage | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [historyNotice, setHistoryNotice] = useState('')
  const historyRef = useRef<SessionHistoryPage | null>(null)
  const historyGenerationRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([])
  const [approvalDisplays, setApprovalDisplays] = useState<Record<string, ApprovalDisplay>>({})
  const [resolvedApprovals, setResolvedApprovals] = useState<ResolvedApproval[]>([])
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionAnswerItem[]>>({})
  const pendingApprovalsRef = useRef<ApprovalRequest[]>([])
  const approvalDisplaysRef = useRef<Record<string, ApprovalDisplay>>({})
  const [queuedBySession, setQueuedBySession] = useState<Record<string, RemoteQueuedItem[]>>({})
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [gapNotice, setGapNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    pendingApprovalsRef.current = pendingApprovals
  }, [pendingApprovals])

  useEffect(() => {
    approvalDisplaysRef.current = approvalDisplays
  }, [approvalDisplays])

  const clearPendingQuestion = useCallback((rpcId: string) => {
    setPendingQuestions(previous => previous.filter(item => item.rpcId !== rpcId))
    setQuestionDrafts(previous => {
      if (previous[rpcId] === undefined) return previous
      const next = { ...previous }
      delete next[rpcId]
      return next
    })
  }, [])

  const refreshAll = useCallback(async () => {
    try {
      const [nextHealth, nextHost, nextWorkspaces, nextSessions, nextPresets] = await Promise.all([
        transport.health(),
        transport.hostDescribe(),
        transport.listWorkspaces(),
        transport.listSessions(),
        transport.listAgentPresets(),
      ])
      setHealth(nextHealth)
      setHost(nextHost)
      setWorkspaces(nextWorkspaces.items)
      setArchivedSessionIds(nextWorkspaces.archivedSessionIds)
      setSessions(nextSessions.items)
      setAgentPresets(nextPresets.items)
      setError('')
      setGapNotice('')
      setConnection('open')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setConnection('reconnecting')
    }
  }, [])

  const refreshSessionModels = useCallback(async (sessionId: string) => {
    setModelsLoading(true)
    try {
      const models = await transport.sessionModels(sessionId)
      if (selectedSessionIdRef.current === sessionId) setSessionModels(models)
      setError('')
      return models
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      if (selectedSessionIdRef.current === sessionId) setModelsLoading(false)
    }
  }, [])

  const refreshHistory = useCallback(async (sessionId: string) => {
    const generation = ++historyGenerationRef.current
    setHistoryLoading(true)
    setHistoryNotice('')
    try {
      const page = await transport.sessionHistory({ sessionId })
      if (generation !== historyGenerationRef.current) return
      setHistory(page)
      historyRef.current = page
      setError('')
      setGapNotice('')
    } catch (cause) {
      if (generation !== historyGenerationRef.current) return
      setHistory(null)
      historyRef.current = null
      setHistoryNotice(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === historyGenerationRef.current) setHistoryLoading(false)
    }
  }, [])

  const loadOlderHistory = useCallback(async (sessionId: string) => {
    if (loadingOlderRef.current) return
    const current = historyRef.current
    if (current === null || current.sessionId !== sessionId || current.hasMore === false) return
    const first = current.events[0]
    if (first === undefined) return

    loadingOlderRef.current = true
    setLoadingOlder(true)
    setHistoryNotice('')
    const generation = historyGenerationRef.current
    try {
      const older = await transport.sessionHistory({ sessionId, beforeSeq: first.sequence })
      if (generation !== historyGenerationRef.current) return
      const tail = older.events.at(-1)
      if (tail !== undefined && tail.sequence + 1 !== first.sequence) {
        setHistoryNotice('更早历史分页不连续，已停止加载')
        setHistory(previous => previous === null ? previous : { ...previous, hasMore: false })
        historyRef.current = historyRef.current === null ? null : { ...historyRef.current, hasMore: false }
        return
      }
      setHistory(previous => {
        if (previous === null || previous.sessionId !== sessionId) return previous
        const existing = new Set(previous.events.map(event => event.eventId))
        const prepended = older.events.filter(event => existing.has(event.eventId) === false)
        const merged = [...prepended, ...previous.events].sort((a, b) => a.sequence - b.sequence)
        const next = { sessionId, events: merged, hasMore: older.hasMore }
        historyRef.current = next
        return next
      })
    } catch (cause) {
      if (generation === historyGenerationRef.current) {
        setHistoryNotice(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      loadingOlderRef.current = false
      if (generation === historyGenerationRef.current) setLoadingOlder(false)
    }
  }, [])

  const loadApprovalDisplay = useCallback(async (request: ApprovalRequest): Promise<ApprovalDisplay> => {
    try {
      let page = historyRef.current?.sessionId === request.sessionId ? historyRef.current : null
      if (page === null) page = await transport.sessionHistory({ sessionId: request.sessionId })
      const toolEvent = page?.events.find(event =>
        event.type === 'tool/call' && record(event.payload)?.callId === request.callId,
      )
      const argumentsText = argumentsTextFor(toolEvent)
      return {
        request,
        toolTitle: toolTitleFor(request, toolEvent),
        ...(argumentsText !== undefined && { argumentsText }),
        ...(toolEvent !== undefined && toolEvent.view !== undefined && { callView: toolEvent.view }),
      }
    } catch {
      return { request, toolTitle: request.toolName }
    }
  }, [])

  const selectSession = useCallback((sessionId: string | null) => {
    historyGenerationRef.current += 1
    setSelectedSessionId(sessionId)
    selectedSessionIdRef.current = sessionId
    setHistory(null)
    setSessionModels(null)
    historyRef.current = null
    setHistoryNotice('')
    setLoadingOlder(false)
    if (sessionId !== null) {
      void refreshHistory(sessionId)
      void refreshSessionModels(sessionId)
    }
  }, [refreshHistory, refreshSessionModels])

  useEffect(() => {
    void refreshAll()
    const controller = new AbortController()
    let disposed = false

    void (async () => {
      while (!disposed) {
        try {
          setConnection('connecting')
          rebaselineStreamsRef.current.add('mux')
          for await (const envelope of transport.events('mux', controller.signal)) {
            if (disposed) return
            setConnection('open')
            handleEnvelope(envelope)
          }
          if (disposed) return
          setConnection('reconnecting')
        } catch {
          if (!disposed) setConnection('reconnecting')
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })()

    return () => {
      disposed = true
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let disposed = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleRefresh = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refreshAll()
      }, 250)
    }

    void (async () => {
      while (!disposed) {
        try {
          for await (const envelope of transport.events('host', controller.signal)) {
            if (disposed) return
            if (envelope.type.startsWith('host/')) scheduleRefresh()
          }
        } catch {
          // Reconnect below.
        }
        if (disposed) return
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      if (refreshTimer !== null) clearTimeout(refreshTimer)
    }
  }, [refreshAll])

  function handleEnvelope(envelope: RemoteEventEnvelope): void {
    if (rebaselineStreamsRef.current.delete(envelope.stream)) {
      // New WebSocket connection: establish a fresh sequence baseline and
      // recover state from HTTP RPC/history. The old connection's sequence
      // numbers must not produce a false 17-21 style gap after reconnect.
      trackerRef.current.resetStream(envelope.hostId, envelope.stream)
      setGapNotice('')
      void refreshAll()
      const selectedId = selectedSessionIdRef.current
      if (selectedId !== null) {
        void refreshHistory(selectedId)
        void refreshSessionModels(selectedId)
      }
    }

    const acceptance = trackerRef.current.accept(envelope)
    if (acceptance.kind === 'gap') {
      setGapNotice(`检测到事件缺口 host=${envelope.hostId} ${acceptance.from}-${acceptance.to}；正在从 session.history 补齐`)
      void refreshAll()
      const selectedId = selectedSessionIdRef.current
      if (selectedId !== null) {
        void refreshHistory(selectedId)
        void refreshSessionModels(selectedId)
      }
    }

    if (envelope.type === 'approval/requested') {
      const request = asApprovalRequest(envelope.payload)
      if (request !== undefined) {
        setPendingApprovals(previous => (
          previous.some(item => item.approvalId === request.approvalId) ? previous : [...previous, request]
        ))
        void loadApprovalDisplay(request).then(display => {
          setApprovalDisplays(previous => ({ ...previous, [request.approvalId]: display }))
        })
      }
      return
    }
    if (envelope.type === 'approval/resolved') {
      const payload = record(envelope.payload)
      const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : ''
      const outcome = typeof payload?.outcome === 'string' ? payload.outcome : ''
      if (approvalId !== '') {
        const request = pendingApprovalsRef.current.find(item => item.approvalId === approvalId)
        if (request !== undefined && outcome !== '') {
          const display = approvalDisplaysRef.current[approvalId]
          setResolvedApprovals(previous => [{
            request,
            outcome,
            ...(display !== undefined && { display }),
            resolvedAt: new Date().toISOString(),
          }, ...previous].slice(0, 20))
        }
        setPendingApprovals(previous => previous.filter(item => item.approvalId !== approvalId))
      }
      return
    }
    if (envelope.type === 'question/requested') {
      const request = asQuestionRequest(envelope.payload)
      if (request !== undefined) {
        setPendingQuestions(previous => (
          previous.some(item => item.rpcId === request.rpcId) ? previous : [...previous, request]
        ))
        setQuestionDrafts(previous => ({
          ...previous,
          [request.rpcId]: previous[request.rpcId] ?? defaultQuestionAnswers(request),
        }))
      }
      return
    }
    if (envelope.type === 'question/resolved') {
      const payload = record(envelope.payload)
      const rpcId = typeof payload?.rpcId === 'string' ? payload.rpcId : ''
      if (rpcId !== '') clearPendingQuestion(rpcId)
      return
    }
    if (envelope.type === 'session/queue' && envelope.sessionId !== undefined) {
      setQueuedBySession(previous => ({
        ...previous,
        [envelope.sessionId as string]: asQueuedItems(envelope.payload),
      }))
      return
    }

    if (envelope.type === 'session/event' && envelope.sessionId === selectedSessionIdRef.current) {
      const live = asLiveSessionEvent(envelope.payload)
      if (live !== undefined) {
        const view: SessionEventView = {
          eventId: envelope.eventId,
          sessionId: envelope.sessionId,
          sequence: live.event.seq,
          type: live.event.type,
          payload: live.event.data,
          timestamp: new Date(live.event.time).toISOString(),
          ...(live.view !== undefined && { view: live.view }),
        }
        setHistory(previous => {
          if (previous === null) return previous
          if (previous.events.some(item => item.eventId === view.eventId)) return previous
          const next = {
            ...previous,
            events: [...previous.events, view],
          }
          historyRef.current = next
          return next
        })
      }
    }
  }

  const searchSessions = useCallback(async (query: string) => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setSearchResults([])
      return
    }
    const visibleSessions = visibleTaskSessions(sessions, archivedSessionIds)
    const visibleIds = new Set(visibleSessions.map(session => session.sessionId))
    const localFallback = visibleSessions
      .filter(session => {
        const haystack = `${session.title ?? ''} ${session.cwd ?? ''} ${session.sessionId}`.toLowerCase()
        return haystack.includes(trimmed.toLowerCase())
      })
      .map(session => ({
        sessionId: session.sessionId,
        snippet: session.title ?? session.cwd ?? session.sessionId,
      }))

    try {
      const result = await transport.searchSessions(trimmed)
      const visibleResults = result.items.filter(item => visibleIds.has(item.sessionId))
      setSearchResults(visibleResults.length > 0 ? visibleResults : localFallback)
      setError('')
    } catch {
      // Upstream full-text search is disabled in the default Harness web
      // profile (openAt: never). Fall back to title/cwd/sessionId matching.
      setSearchResults(localFallback)
      setError('')
    }
  }, [archivedSessionIds, sessions])

  const createSession = useCallback(async (workspaceId?: string, idempotencyKey?: string, agentPreset?: string) => {
    try {
      const reusable = workspaceId === undefined
        ? undefined
        : reusableBlankSession(sessions, workspaceId, archivedSessionIds)
      let sessionId: string
      if (reusable !== undefined) {
        sessionId = reusable.sessionId
        if (agentPreset !== undefined && reusable.agentPreset !== agentPreset) {
          await transport.selectAgentPreset(
            { sessionId, agentPreset },
            `agent-preset:${sessionId}:${agentPreset}:${globalThis.crypto.randomUUID()}`,
          )
        }
      } else {
        sessionId = await transport.createSession(
          {
            ...(workspaceId !== undefined && { workspaceId }),
            ...(agentPreset !== undefined && { agentPreset }),
          },
          idempotencyKey,
        )
      }
      setSelectedSessionId(sessionId)
      selectedSessionIdRef.current = sessionId
      await refreshAll()
      await refreshHistory(sessionId)
      await refreshSessionModels(sessionId)
      return sessionId
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [archivedSessionIds, refreshAll, refreshHistory, refreshSessionModels, sessions])

  const selectAgentPreset = useCallback(async (sessionId: string, agentPreset: string): Promise<boolean> => {
    try {
      await transport.selectAgentPreset(
        { sessionId, agentPreset },
        `agent-preset:${sessionId}:${agentPreset}:${globalThis.crypto.randomUUID()}`,
      )
      await refreshAll()
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }, [refreshAll])

  const selectSessionModel = useCallback(async (input: SessionModelSelectInput): Promise<boolean> => {
    setModelsLoading(true)
    try {
      const selected = await transport.selectSessionModel(
        input,
        `session-model:${input.sessionId}:${input.provider}:${input.model}:${input.reasoningEffort ?? 'default'}:${globalThis.crypto.randomUUID()}`,
      )
      setSessionModels(previous => previous === null ? previous : { ...previous, current: selected, routable: true })
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setModelsLoading(false)
    }
  }, [])

  const createWorkspace = useCallback(async (path: string) => {
    try {
      const result = await transport.createWorkspace({ path })
      await refreshAll()
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [refreshAll])

  const sendPrompt = useCallback(async (
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    idempotencyKey?: string,
  ): Promise<boolean> => {
    let optimisticId: string | undefined
    if (mode === 'queue') {
      const running = sessions.some(session => session.sessionId === sessionId && session.running)
      if (running) {
        optimisticId = `local:${Date.now()}:${Math.random()}`
        setQueuedBySession(previous => {
          const existing = previous[sessionId] ?? []
          return {
            ...previous,
            [sessionId]: [
              ...existing,
              { id: optimisticId as string, placement: 'queued', text },
            ],
          }
        })
      }
    }
    try {
      await transport.prompt({ sessionId, mode, text }, idempotencyKey)
      setSessions(previous => previous.map(session => (
        session.sessionId === sessionId && session.blank
          ? { ...session, blank: false, updatedAt: Date.now() }
          : session
      )))
      setError('')
      return true
    } catch (cause) {
      if (optimisticId !== undefined) {
        setQueuedBySession(previous => ({
          ...previous,
          [sessionId]: (previous[sessionId] ?? []).filter(item => item.id !== optimisticId),
        }))
      }
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }, [sessions])

  const respondApproval = useCallback(async (
    request: ApprovalRequest,
    outcome: ApprovalDecision['outcome'],
  ): Promise<boolean> => {
    try {
      await transport.approvalRespond({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        rpcId: request.rpcId,
        outcome,
      })
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }, [])

  const updateQuestionDraft = useCallback((rpcId: string, answers: QuestionAnswerItem[]) => {
    setQuestionDrafts(previous => ({ ...previous, [rpcId]: answers }))
  }, [])

  const respondQuestion = useCallback(async (
    request: QuestionRequest,
    answerOverride?: QuestionAnswerItem[],
  ): Promise<boolean> => {
    try {
      const answers = answerOverride ?? questionDrafts[request.rpcId] ?? defaultQuestionAnswers(request)
      const result = await transport.questionRespond({
        sessionId: request.sessionId,
        rpcId: request.rpcId,
        answer: { answers },
      })

      // The HTTP response is the authoritative acknowledgement from Harness.
      // Clear immediately instead of keeping a dead form around while waiting
      // for a question/resolved event that may be delayed or lost.
      clearPendingQuestion(request.rpcId)
      if (!result.accepted) {
        setError('该问题已处理或已过期，已从待办中移除')
        return false
      }
      setError('')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
  }, [clearPendingQuestion, questionDrafts])

  const visibleSessions = useMemo(
    () => visibleTaskSessions(sessions, archivedSessionIds),
    [archivedSessionIds, sessions],
  )

  return {
    health,
    host,
    workspaces,
    archivedSessionIds,
    sessions,
    visibleSessions,
    agentPresets,
    sessionModels,
    modelsLoading,
    selectedSessionId,
    history,
    historyLoading,
    loadingOlder,
    historyNotice,
    loadOlderHistory,
    pendingApprovals,
    pendingQuestions,
    approvalDisplays,
    resolvedApprovals,
    questionDrafts,
    updateQuestionDraft,
    queuedItems: selectedSessionId === null ? [] : (queuedBySession[selectedSessionId] ?? []),
    connection,
    gapNotice,
    error,
    refreshAll,
    refreshHistory,
    refreshSessionModels,
    searchResults,
    searchSessions,
    selectSession,
    createSession,
    selectAgentPreset,
    selectSessionModel,
    createWorkspace,
    sendPrompt,
    respondApproval,
    respondQuestion,
  }
}
