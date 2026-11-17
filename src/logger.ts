const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT = new Set(['password', 'token', 'secret', 'authorization', 'cookie', 'csrf', 'code', 'sdp', 'candidate']);

export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACT.has(key.toLowerCase())) {
      safe[key] = '[redacted]';
      continue;
    }
    if (value instanceof Error) {
      safe[key] = config(errorSummary(value));
      continue;
    }
    if (typeof value === 'string' && value.length > 500) {
      safe[key] = `${value.slice(0, 500)}…`;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function errorSummary(error: Error): string {
  return `${error.name}: ${error.message}`;
}

const config = (summary: string): string => summary;

export function createLogger(level: string): Logger {
  const threshold = LEVELS[level] ?? 20;
  const emit = (name: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if ((LEVELS[name] ?? 0) < threshold) return;
    const record = {
      time: new Date().toISOString(),
      level: name,
      msg: message,
      ...(fields ? sanitize(fields) : {}),
    };
    const line = JSON.stringify(record);
    if (name === 'error' || name === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
