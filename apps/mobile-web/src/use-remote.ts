import { useCallback, useEffect, useRef, useState } from 'react'
import { RemoteSequenceTracker } from '@dsh-remote/client'
import type {
  ApprovalDecision,
  ApprovalRequest,
  HostDescriptor,
  QuestionDecision,
  QuestionRequest,
  SessionEventView,
  SessionHistoryPage,
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

export function useRemote() {
  const trackerRef = useRef(new RemoteSequenceTracker())
  const rebaselineStreamsRef = useRef(new Set<RemoteEventStream>())
  const selectedSessionIdRef = useRef<string | null>(null)
  const [health, setHealth] = useState<RemoteHostHealth | null>(null)
  const [host, setHost] = useState<HostDescriptor | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
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
  const [queuedBySession, setQueuedBySession] = useState<Record<string, RemoteQueuedItem[]>>({})
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [gapNotice, setGapNotice] = useState('')
  const [error, setError] = useState('')

  const refreshAll = useCallback(async () => {
    try {
      const [nextHealth, nextHost, nextWorkspaces, nextSessions] = await Promise.all([
        transport.health(),
        transport.hostDescribe(),
        transport.listWorkspaces(),
        transport.listSessions(),
      ])
      setHealth(nextHealth)
      setHost(nextHost)
      setWorkspaces(nextWorkspaces.items)
      setSessions(nextSessions.items)
      setError('')
      setGapNotice('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

  const selectSession = useCallback((sessionId: string | null) => {
    historyGenerationRef.current += 1
    setSelectedSessionId(sessionId)
    selectedSessionIdRef.current = sessionId
    setHistory(null)
    historyRef.current = null
    setHistoryNotice('')
    setLoadingOlder(false)
    if (sessionId !== null) void refreshHistory(sessionId)
  }, [refreshHistory])

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
      if (selectedId !== null) void refreshHistory(selectedId)
    }

    const acceptance = trackerRef.current.accept(envelope)
    if (acceptance.kind === 'gap') {
      setGapNotice(`检测到事件缺口 host=${envelope.hostId} ${acceptance.from}-${acceptance.to}；正在从 session.history 补齐`)
      void refreshAll()
      const selectedId = selectedSessionIdRef.current
      if (selectedId !== null) void refreshHistory(selectedId)
    }

    if (envelope.type === 'approval/requested') {
      const request = asApprovalRequest(envelope.payload)
      if (request !== undefined) {
        setPendingApprovals(previous => (
          previous.some(item => item.approvalId === request.approvalId) ? previous : [...previous, request]
        ))
      }
      return
    }
    if (envelope.type === 'approval/resolved') {
      const payload = envelope.payload as Record<string, unknown> | undefined
      const approvalId = typeof payload?.approvalId === 'string' ? payload.approvalId : ''
      if (approvalId !== '') {
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
      }
      return
    }
    if (envelope.type === 'question/resolved') {
      const payload = envelope.payload as Record<string, unknown> | undefined
      const rpcId = typeof payload?.rpcId === 'string' ? payload.rpcId : ''
      if (rpcId !== '') {
        setPendingQuestions(previous => previous.filter(item => item.rpcId !== rpcId))
      }
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
    const localFallback = sessions
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
      setSearchResults(result.items.length > 0 ? result.items : localFallback)
      setError('')
    } catch {
      // Upstream full-text search is disabled in the default Harness web
      // profile (openAt: never). Fall back to title/cwd/sessionId matching.
      setSearchResults(localFallback)
      setError('')
    }
  }, [sessions])

  const createSession = useCallback(async (workspaceId?: string) => {
    try {
      const sessionId = await transport.createSession(workspaceId !== undefined ? { workspaceId } : {})
      setSelectedSessionId(sessionId)
      selectedSessionIdRef.current = sessionId
      await refreshAll()
      await refreshHistory(sessionId)
      return sessionId
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    }
  }, [refreshAll, refreshHistory])

  const sendPrompt = useCallback(async (sessionId: string, text: string, mode: 'queue' | 'steer' = 'queue') => {
    if (mode === 'queue') {
      const running = sessions.some(session => session.sessionId === sessionId && session.running)
      if (running) {
        setQueuedBySession(previous => {
          const existing = previous[sessionId] ?? []
          return {
            ...previous,
            [sessionId]: [
              ...existing,
              { id: `local:${Date.now()}:${Math.random()}`, placement: 'queued', text },
            ],
          }
        })
      }
    }
    try {
      await transport.prompt({ sessionId, mode, text })
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessions])

  const respondApproval = useCallback(async (request: ApprovalRequest, outcome: ApprovalDecision['outcome']) => {
    try {
      await transport.approvalRespond({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        rpcId: request.rpcId,
        outcome,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const respondQuestion = useCallback(async (request: QuestionRequest) => {
    try {
      const answers = request.questions.map(question => ({
        id: question.id,
        selected: question.options?.[0] ? [question.options[0].label] : [],
      }))
      await transport.questionRespond({
        sessionId: request.sessionId,
        rpcId: request.rpcId,
        answer: { answers },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  return {
    health,
    host,
    workspaces,
    sessions,
    selectedSessionId,
    history,
    historyLoading,
    loadingOlder,
    historyNotice,
    loadOlderHistory,
    pendingApprovals,
    pendingQuestions,
    queuedItems: selectedSessionId === null ? [] : (queuedBySession[selectedSessionId] ?? []),
    connection,
    gapNotice,
    error,
    refreshAll,
    refreshHistory,
    searchResults,
    searchSessions,
    selectSession,
    createSession,
    sendPrompt,
    respondApproval,
    respondQuestion,
  }
}
