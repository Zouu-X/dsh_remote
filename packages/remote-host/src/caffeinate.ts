import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { DeepSeekHarnessAdapter } from '@dsh-remote/adapter-deepseek'

export interface CaffeinateSupervisorOptions {
  adapter: Pick<DeepSeekHarnessAdapter, 'sessionList'>
  command?: string
  intervalMs?: number
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  logger?: { info(fields: Record<string, unknown>, message: string): void }
}

/**
 * Keeps the Mac awake only while at least one Harness session is running.
 * The all-the-time caffeinate wrapper remains an explicit opt-in in
 * macos/launch-agent/run-remote-host.sh.
 */
export class CaffeinateSupervisor {
  private readonly adapter: CaffeinateSupervisorOptions['adapter']
  private readonly command: string
  private readonly intervalMs: number
  private readonly spawnImpl: NonNullable<CaffeinateSupervisorOptions['spawn']>
  private readonly logger?: CaffeinateSupervisorOptions['logger']
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(options: CaffeinateSupervisorOptions) {
    this.adapter = options.adapter
    this.command = options.command ?? '/usr/bin/caffeinate'
    this.intervalMs = options.intervalMs ?? 15_000
    this.spawnImpl = options.spawn ?? spawn
    this.logger = options.logger
  }

  start(): void {
    if (this.timer !== null) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stopChild()
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const sessions = await this.adapter.sessionList()
      const shouldRun = sessions.some(session => session.running)
      if (shouldRun && this.child === null) {
        this.logger?.info({}, 'running session detected; starting caffeinate')
        const child = this.spawnImpl(this.command, ['-i'], { stdio: 'ignore' })
        this.child = child
        child.once('exit', () => {
          if (this.child === child) this.child = null
        })
      } else if (!shouldRun && this.child !== null) {
        this.logger?.info({}, 'no running sessions; stopping caffeinate')
        this.stopChild()
      }
    } catch {
      // A failed poll must never take down the Remote Host; retry next tick.
    } finally {
      this.ticking = false
    }
  }

  isActive(): boolean {
    return this.child !== null
  }

  private stopChild(): void {
    if (this.child !== null) {
      const child = this.child
      this.child = null
      if (!child.killed) child.kill('SIGTERM')
    }
  }
}
