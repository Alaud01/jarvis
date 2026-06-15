import type { DictionaryEntryStatus } from './dictionary';

export type CorrectionCandidate = {
  alias: string;
  preferred: string;
};

const MAX_REPLACEMENT_LENGTH = 120;
const MAX_REPLACEMENT_WORDS = 12;

function isPunctuationOnly(value: string): boolean {
  return value.length > 0 && !/[\p{L}\p{N}]/u.test(value);
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

export function extractCorrectionCandidate(
  baseline: string,
  current: string,
  insertedStart: number,
  insertedEnd: number,
): CorrectionCandidate | null {
  if (!baseline || baseline === current || insertedEnd <= insertedStart) {
    return null;
  }

  let prefixLength = 0;
  const sharedLength = Math.min(baseline.length, current.length);
  while (prefixLength < sharedLength && baseline[prefixLength] === current[prefixLength]) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseline.length - prefixLength
    && suffixLength < current.length - prefixLength
    && baseline[baseline.length - 1 - suffixLength] === current[current.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  while (
    suffixLength > 0
    && (
      (
        isWordCharacter(baseline[baseline.length - suffixLength - 1])
        && isWordCharacter(baseline[baseline.length - suffixLength])
      )
      || (
        isWordCharacter(current[current.length - suffixLength - 1])
        && isWordCharacter(current[current.length - suffixLength])
      )
    )
  ) {
    suffixLength -= 1;
  }

  while (
    prefixLength > 0
    && (
      (isWordCharacter(baseline[prefixLength - 1]) && isWordCharacter(baseline[prefixLength]))
      || (isWordCharacter(current[prefixLength - 1]) && isWordCharacter(current[prefixLength]))
    )
  ) {
    prefixLength -= 1;
  }

  const baselineEnd = baseline.length - suffixLength;
  const currentEnd = current.length - suffixLength;
  if (baselineEnd <= insertedStart || prefixLength >= insertedEnd) {
    return null;
  }

  const alias = baseline.slice(prefixLength, baselineEnd).trim();
  const preferred = current.slice(prefixLength, currentEnd).trim();
  if (!alias || !preferred || alias === preferred) {
    return null;
  }
  if (
    alias.length > MAX_REPLACEMENT_LENGTH
    || preferred.length > MAX_REPLACEMENT_LENGTH
    || wordCount(alias) > MAX_REPLACEMENT_WORDS
    || wordCount(preferred) > MAX_REPLACEMENT_WORDS
  ) {
    return null;
  }
  if (isPunctuationOnly(alias) || isPunctuationOnly(preferred)) {
    return null;
  }

  return { alias, preferred };
}

export function nextLearnedStatus(current: DictionaryEntryStatus, recurrenceCount: number): DictionaryEntryStatus {
  if (current === 'disabled') return 'disabled';
  return recurrenceCount >= 2 ? 'active' : 'learning';
}
