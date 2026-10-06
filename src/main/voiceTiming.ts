// Totals contain the named steps; callers must not add nested totals together.
export function logVoiceTiming(requestId: string, phase: string, timings: Record<string, number>): void {
  const steps = Object.entries(timings)
    .map(([name, value]) => `${name}=${Math.round(value)}ms`)
    .join(' | ');
  console.warn(`[VoiceTiming ${requestId}] ${phase} | ${steps}`);
}
