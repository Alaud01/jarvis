const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

type LogLevel = (typeof LEVELS)[number];

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.JARVIS_LOG_LEVEL || 'warn').toLowerCase();
  return LEVELS.includes(raw as LogLevel) ? raw as LogLevel : 'warn';
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(getConfiguredLevel())
    && getConfiguredLevel() !== 'silent';
}

export function debugLog(message: string, details?: unknown): void {
  if (!shouldLog('debug')) return;
  if (details === undefined) {
    console.debug(message);
    return;
  }
  console.debug(message, details);
}

export function infoLog(message: string, details?: unknown): void {
  if (!shouldLog('info')) return;
  if (details === undefined) {
    console.info(message);
    return;
  }
  console.info(message, details);
}
