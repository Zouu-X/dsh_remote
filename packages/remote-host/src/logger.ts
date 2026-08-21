export interface StructuredLogger {
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
}

export interface JsonLoggerOptions {
  stream?: Pick<NodeJS.WriteStream, 'write'>
}

export class JsonLogger implements StructuredLogger {
  private readonly stream: Pick<NodeJS.WriteStream, 'write'>

  constructor(options: JsonLoggerOptions = {}) {
    this.stream = options.stream ?? process.stdout
  }

  info(fields: Record<string, unknown>, message: string): void {
    this.write('info', fields, message)
  }

  warn(fields: Record<string, unknown>, message: string): void {
    this.write('warn', fields, message)
  }

  error(fields: Record<string, unknown>, message: string): void {
    this.write('error', fields, message)
  }

  private write(level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    this.stream.write(`${JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...fields,
    })}\n`)
  }
}
