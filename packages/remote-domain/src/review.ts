import type { SessionEventView } from './index.js'

/**
 * Review timeline model. Review is a read-only replay of one Session's
 * execution trace, so raw wire events are reduced here into UI nodes:
 *
 * - assistant/chunk fragments are folded into one message per step;
 * - tool/call and tool/result are paired into one tool node;
 * - permission/sandbox/policy events become compact status markers;
 * - unknown events remain available as collapsed raw nodes.
 */

export interface ReviewTurnMarker {
  kind: 'turn'
  turn: number
  seq: number
  timestamp: string
}

export interface ReviewStepMarker {
  kind: 'step'
  turn: number
  step: number
  seq: number
  timestamp: string
}

export interface ReviewMessageNode {
  kind: 'message'
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  partial?: boolean
  turn?: number
  step?: number
  seq: number
  timestamp: string
}

export interface ReviewToolNode {
  kind: 'tool'
  name: string
  title: string
  callId?: string
  argumentsText?: string
  callView?: unknown
  resultView?: unknown
  resultText?: string
  resultIsError?: boolean
  turn?: number
  step?: number
  seq: number
  endSeq?: number
  timestamp: string
}

export interface ReviewStatusNode {
  kind: 'status'
  eventType: string
  label: string
  detail: string
  payload: unknown
  seq: number
  timestamp: string
}

export interface ReviewRawNode {
  kind: 'raw'
  eventType: string
  label: string
  payload: unknown
  seq: number
  timestamp: string
}

export type ReviewNode =
  | ReviewTurnMarker
  | ReviewStepMarker
  | ReviewMessageNode
  | ReviewToolNode
  | ReviewStatusNode
  | ReviewRawNode

interface RecordLike {
  [key: string]: unknown
}

function asRecord(value: unknown): RecordLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as RecordLike
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Upstream history/live tool views are `{ for: 'call'|'result', view: {...} }`. */
export function unwrapToolView(value: unknown): unknown {
  const outer = asRecord(value)
  const inner = outer === undefined ? undefined : asRecord(outer.view)
  return inner ?? value
}

function toolCallId(event: SessionEventView): string | undefined {
  const direct = asString(asRecord(event.payload)?.callId)
  if (direct !== undefined) return direct
  const content = asRecord(asRecord(event.payload)?.message)?.content
  if (Array.isArray(content) === false) return undefined
  for (const block of content) {
    const record = asRecord(block)
    if (record !== undefined && record.type === 'tool-result') {
      const nested = asString(record.toolCallId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function stepKey(payload: unknown): string {
  const record = asRecord(payload)
  const turn = asNumber(record?.turn) ?? -1
  const step = asNumber(record?.step) ?? -1
  return `${turn}:${step}`
}

function turnOf(payload: unknown): number | undefined {
  return asNumber(asRecord(payload)?.turn)
}

function stepOf(payload: unknown): number | undefined {
  return asNumber(asRecord(payload)?.step)
}

function messageParts(payload: unknown): { text: string; reasoning: string } {
  const content = asRecord(asRecord(payload)?.message)?.content
  if (Array.isArray(content) === false) return { text: '', reasoning: '' }
  let text = ''
  let reasoning = ''
  for (const block of content) {
    const record = asRecord(block)
    const kind = asString(record?.type)
    const blockText = asString(record?.text)
    if (blockText === undefined) continue
    if (kind === 'text') text = appendBlock(text, blockText)
    else if (kind === 'reasoning') reasoning = appendBlock(reasoning, blockText)
  }
  return { text, reasoning }
}

function appendBlock(current: string, next: string): string {
  return current === '' ? next : `${current}\n${next}`
}

function toolResultParts(payload: unknown): { text: string; isError: boolean } {
  const content = asRecord(asRecord(payload)?.message)?.content
  if (Array.isArray(content) === false) return { text: '', isError: false }
  let text = ''
  let isError = false
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined || record.type !== 'tool-result') continue
    if (record.isError === true) isError = true
    text = appendBlock(text, textFromBlocks(record.content))
  }
  return { text, isError }
}

function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content) === false) return ''
  let text = ''
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (typeof record.text === 'string') {
      text = appendBlock(text, record.text)
    } else if (record.content !== undefined) {
      text = appendBlock(text, textFromBlocks(record.content))
    }
  }
  return text
}

function argumentsText(payload: unknown): string | undefined {
  const value = asRecord(payload)?.arguments
  if (typeof value === 'string') return value
  if (value !== undefined) return JSON.stringify(value)
  return undefined
}

function viewTitle(view: unknown): string | undefined {
  return asString(asRecord(view)?.title)
}

function toolTitle(name: string, payload: unknown, callView: unknown): string {
  return viewTitle(callView)
    ?? `${name} ${compactArguments(argumentsText(payload))}`.trim()
}

function compactArguments(value: string | undefined): string {
  if (value === undefined) return ''
  try {
    const parsed = JSON.parse(value) as unknown
    const record = asRecord(parsed)
    if (record === undefined) return value
    const command = asString(record.command)
    if (command !== undefined) return command
    return JSON.stringify(record)
  } catch {
    return value
  }
}

interface FoldedStep {
  text: string
  reasoning: string
}

const CONTROL_LABELS: Record<string, (payload: unknown) => { label: string; detail: string }> = {
  'permission/preset': payload => ({ label: '权限预设', detail: asString(asRecord(payload)?.preset) ?? '' }),
  'sandbox/mode': payload => ({ label: '沙箱模式', detail: asString(asRecord(payload)?.mode) ?? '' }),
  'approval/policy': payload => ({ label: '审批策略', detail: asString(asRecord(payload)?.policy) ?? '' }),
  'agent-preset/selected': payload => ({ label: 'Agent 预设', detail: asString(asRecord(payload)?.presetId) ?? '' }),
  'session/title': payload => ({ label: '会话标题', detail: asString(asRecord(payload)?.title) ?? '' }),
  'request/header': () => ({ label: '请求上下文', detail: 'header' }),
  'request/context': () => ({ label: '请求上下文', detail: 'context' }),
  'agent/inbox/spliced': () => ({ label: '消息追加', detail: 'next-turn' }),
}

export function controlStatusFor(eventType: string, payload: unknown): { label: string; detail: string } | undefined {
  const build = CONTROL_LABELS[eventType]
  return build === undefined ? undefined : build(payload)
}

function foldStepChunks(events: SessionEventView[]): FoldedStep {
  const folded: FoldedStep = { text: '', reasoning: '' }
  for (const event of events) {
    const chunk = asRecord(asRecord(event.payload)?.chunk)
    if (chunk === undefined) continue
    const type = asString(chunk.type)
    const delta = asString(chunk.text)
    if (type === 'text-delta' && delta !== undefined) folded.text += delta
    else if (type === 'reasoning-delta' && delta !== undefined) folded.reasoning += delta
    else if (type === 'block-end') {
      const block = asRecord(chunk.block)
      const blockType = asString(block?.type)
      const full = asString(block?.text)
      if (full !== undefined && blockType === 'text') folded.text = full
      else if (full !== undefined && blockType === 'reasoning') folded.reasoning = full
    }
  }
  return folded
}

function rawLabel(eventType: string): string {
  return eventType.split('/').at(-1) ?? eventType
}

function messageNode(
  role: 'user' | 'assistant',
  payload: unknown,
  event: SessionEventView,
  partial = false,
): ReviewMessageNode | undefined {
  const parts = role === 'assistant'
    ? messageParts(payload)
    : { text: textFromBlocks(asRecord(asRecord(payload)?.message)?.content), reasoning: '' }
  if (parts.text === '' && parts.reasoning === '') return undefined
  const node: ReviewMessageNode = {
    kind: 'message',
    role,
    text: parts.text,
    seq: event.sequence,
    timestamp: event.timestamp,
  }
  if (parts.reasoning !== '') node.reasoning = parts.reasoning
  if (partial) node.partial = true
  const turn = turnOf(payload)
  const step = stepOf(payload)
  if (turn !== undefined) node.turn = turn
  if (step !== undefined) node.step = step
  return node
}

/**
 * Reduces raw SessionEventViews into a mobile Review timeline.
 * Events are rendered once in ascending sequence order.
 */
export function buildReviewTimeline(events: readonly SessionEventView[]): ReviewNode[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence)

  const resultByCallId = new Map<string, SessionEventView>()
  const completeMessages = new Map<string, { event: SessionEventView; text: string; reasoning: string }>()
  const chunksByStep = new Map<string, SessionEventView[]>()

  for (const event of sorted) {
    if (event.type === 'tool/result') {
      const callId = toolCallId(event)
      if (callId !== undefined) resultByCallId.set(callId, event)
    } else if (event.type === 'assistant/message') {
      const parts = messageParts(event.payload)
      completeMessages.set(stepKey(event.payload), { event, ...parts })
    } else if (event.type === 'assistant/chunk') {
      const key = stepKey(event.payload)
      const list = chunksByStep.get(key)
      if (list === undefined) chunksByStep.set(key, [event])
      else list.push(event)
    }
  }

  const nodes: ReviewNode[] = []
  const renderedCallIds = new Set<string>()
  const emittedPartialSteps = new Set<string>()
  let currentTurn: number | undefined
  let currentStep: number | undefined

  for (const event of sorted) {
    switch (event.type) {
      case 'turn/start': {
        const turn = turnOf(event.payload)
        if (turn !== undefined) currentTurn = turn
        if (currentTurn !== undefined) {
          nodes.push({ kind: 'turn', turn: currentTurn, seq: event.sequence, timestamp: event.timestamp })
        }
        break
      }
      case 'step/start': {
        const turn = turnOf(event.payload)
        const step = stepOf(event.payload)
        if (turn !== undefined) currentTurn = turn
        if (step !== undefined) currentStep = step
        if (currentTurn !== undefined && currentStep !== undefined) {
          nodes.push({
            kind: 'step',
            turn: currentTurn,
            step: currentStep,
            seq: event.sequence,
            timestamp: event.timestamp,
          })
        }
        break
      }
      case 'user/message': {
        const node = messageNode('user', event.payload, event)
        if (node !== undefined) nodes.push(node)
        break
      }
      case 'assistant/message': {
        const complete = completeMessages.get(stepKey(event.payload))
        if (complete !== undefined) {
          const node = messageNode('assistant', event.payload, complete.event)
          if (node !== undefined) nodes.push(node)
        }
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.payload)
        if (completeMessages.has(key) || emittedPartialSteps.has(key)) break
        emittedPartialSteps.add(key)
        const chunkEvents = chunksByStep.get(key) ?? [event]
        const folded = foldStepChunks(chunkEvents)
        if (folded.text !== '' || folded.reasoning !== '') {
          const node: ReviewMessageNode = {
            kind: 'message',
            role: 'assistant',
            text: folded.text,
            partial: true,
            seq: event.sequence,
            timestamp: event.timestamp,
          }
          if (folded.reasoning !== '') node.reasoning = folded.reasoning
          if (currentTurn !== undefined) node.turn = currentTurn
          if (currentStep !== undefined) node.step = currentStep
          nodes.push(node)
        }
        break
      }
      case 'tool/call': {
        const callId = toolCallId(event)
        const payload = asRecord(event.payload) ?? {}
        const name = asString(payload.name) ?? 'tool'
        const callView = unwrapToolView(event.view)
        const result = callId === undefined ? undefined : resultByCallId.get(callId)
        const resultParts = result === undefined
          ? { text: '', isError: false }
          : toolResultParts(result.payload)
        if (callId !== undefined) renderedCallIds.add(callId)
        const node: ReviewToolNode = {
          kind: 'tool',
          name,
          title: toolTitle(name, payload, callView),
          seq: event.sequence,
          timestamp: event.timestamp,
        }
        if (callId !== undefined) node.callId = callId
        const args = argumentsText(event.payload)
        if (args !== undefined) node.argumentsText = args
        if (callView !== undefined) node.callView = callView
        if (result !== undefined) {
          node.endSeq = result.sequence
          if (result.view !== undefined) node.resultView = unwrapToolView(result.view)
          if (resultParts.text !== '') node.resultText = resultParts.text
          if (resultParts.isError) node.resultIsError = true
        }
        const turn = turnOf(payload)
        const step = stepOf(payload)
        if (turn !== undefined) node.turn = turn
        if (step !== undefined) node.step = step
        nodes.push(node)
        break
      }
      case 'tool/result': {
        const callId = toolCallId(event)
        if (callId !== undefined && renderedCallIds.has(callId)) break
        const parts = toolResultParts(event.payload)
        nodes.push({
          kind: 'raw',
          eventType: event.type,
          label: parts.text === '' ? '工具结果' : '工具结果（未配对调用）',
          payload: parts.text === '' ? event.payload : { result: parts.text, isError: parts.isError },
          seq: event.sequence,
          timestamp: event.timestamp,
        })
        break
      }
      case 'turn/end':
      case 'step/end':
        break
      default: {
        const status = controlStatusFor(event.type, event.payload)
        if (status !== undefined) {
          nodes.push({
            kind: 'status',
            eventType: event.type,
            label: status.label,
            detail: status.detail,
            payload: event.payload,
            seq: event.sequence,
            timestamp: event.timestamp,
          })
        } else {
          nodes.push({
            kind: 'raw',
            eventType: event.type,
            label: rawLabel(event.type),
            payload: event.payload,
            seq: event.sequence,
            timestamp: event.timestamp,
          })
        }
      }
    }
  }

  return nodes
}
