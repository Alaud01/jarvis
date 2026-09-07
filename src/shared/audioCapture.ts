export const NO_MIC_DETECTED_MESSAGE = 'No mic detected';

const MICROPHONE_UNAVAILABLE_ERROR_NAMES = new Set([
  'AbortError',
  'DevicesNotFoundError',
  'NotFoundError',
  'NotReadableError',
  'TrackStartError',
]);

export function isMicrophoneUnavailableErrorName(errorName?: string | null): boolean {
  return Boolean(errorName && MICROPHONE_UNAVAILABLE_ERROR_NAMES.has(errorName));
}
