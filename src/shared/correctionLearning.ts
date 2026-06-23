import type { DictionaryEntryStatus } from './dictionary';

export type CorrectionCandidate = {
  alias: string;
  preferred: string;
};

export type CorrectionClassificationDecision = 'eligible' | 'ambiguous' | 'ineligible';

export type CorrectionClassification = {
  decision: CorrectionClassificationDecision;
  reasons: string[];
};

const MAX_REPLACEMENT_LENGTH = 120;
const MAX_REPLACEMENT_WORDS = 12;
const MAX_VOCABULARY_WORDS = 4;
const MIN_CORRECTION_SIMILARITY = 0.6;

const COMMON_WORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'but',
  'by',
  'can',
  'cloud',
  'code',
  'come',
  'could',
  'data',
  'day',
  'did',
  'do',
  'does',
  'done',
  'for',
  'from',
  'get',
  'go',
  'good',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'like',
  'make',
  'me',
  'more',
  'my',
  'no',
  'not',
  'now',
  'of',
  'on',
  'one',
  'or',
  'our',
  'out',
  'over',
  'please',
  'right',
  'say',
  'see',
  'she',
  'so',
  'some',
  'take',
  'than',
  'that',
  'the',
  'their',
  'there',
  'then',
  'these',
  'they',
  'thing',
  'this',
  'time',
  'to',
  'up',
  'use',
  'was',
  'we',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'word',
  'work',
  'would',
  'you',
  'your',
]);

function isPunctuationOnly(value: string): boolean {
  return value.length > 0 && !/[\p{L}\p{N}]/u.test(value);
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function normalizedSpelling(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function words(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function isCommonWordLike(value: string): boolean {
  const normalizedWords = words(value).map(item => normalizedSpelling(item));
  return normalizedWords.length === 1 && COMMON_WORDS.has(normalizedWords[0]);
}

function isAcronym(value: string): boolean {
  const normalized = value.trim();
  return /^[A-Z0-9]{2,12}s?$/.test(normalized);
}

function hasInternalCapital(value: string): boolean {
  return /\p{Ll}\p{Lu}/u.test(value) || /\p{Lu}\p{Ll}+\p{Lu}/u.test(value);
}

function isTechnicalTerm(value: string): boolean {
  return (
    hasInternalCapital(value)
    || /[0-9_+#/@.-]/u.test(value)
    || isAcronym(value)
  );
}

function isTitleCaseToken(value: string): boolean {
  return /^\p{Lu}[\p{Ll}\p{M}'’.-]*$/u.test(value);
}

function isProperNounPhrase(value: string): boolean {
  const valueWords = words(value);
  if (valueWords.length === 0 || valueWords.length > MAX_VOCABULARY_WORDS) return false;
  return valueWords.every(word => isTitleCaseToken(word) || isTechnicalTerm(word));
}

// Optimal string alignment distance treats an adjacent transposition as the
// single typo it usually is, unlike plain Levenshtein distance.
function spellingDistance(left: string, right: string): number {
  const previousPrevious = new Array(right.length + 1).fill(0);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
      if (
        leftIndex > 1
        && rightIndex > 1
        && left[leftIndex - 1] === right[rightIndex - 2]
        && left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        current[rightIndex] = Math.min(current[rightIndex], previousPrevious[rightIndex - 2] + 1);
      }
    }
    for (let index = 0; index < previous.length; index += 1) {
      previousPrevious[index] = previous[index];
    }
    previous = current;
  }

  return previous[right.length];
}

export function isSimilarCorrection(alias: string, preferred: string): boolean {
  const normalizedAlias = normalizedSpelling(alias);
  const normalizedPreferred = normalizedSpelling(preferred);
  if (!normalizedAlias || !normalizedPreferred) return false;

  const longestLength = Math.max(normalizedAlias.length, normalizedPreferred.length);
  return 1 - spellingDistance(normalizedAlias, normalizedPreferred) / longestLength
    >= MIN_CORRECTION_SIMILARITY;
}

export function classifyCorrectionPair(alias: string, preferred: string): CorrectionClassification {
  const reasons: string[] = [];
  const trimmedAlias = alias.trim();
  const trimmedPreferred = preferred.trim();

  if (!trimmedAlias || !trimmedPreferred || trimmedAlias === trimmedPreferred) {
    return { decision: 'ineligible', reasons: ['ineligible_empty_or_same'] };
  }

  if (
    trimmedAlias.length > MAX_REPLACEMENT_LENGTH
    || trimmedPreferred.length > MAX_REPLACEMENT_LENGTH
    || wordCount(trimmedAlias) > MAX_REPLACEMENT_WORDS
    || wordCount(trimmedPreferred) > MAX_REPLACEMENT_WORDS
  ) {
    return { decision: 'ineligible', reasons: ['ineligible_too_long'] };
  }

  if (wordCount(trimmedPreferred) > MAX_VOCABULARY_WORDS) {
    return { decision: 'ineligible', reasons: ['ineligible_sentence_rewrite'] };
  }

  if (isPunctuationOnly(trimmedAlias) || isPunctuationOnly(trimmedPreferred)) {
    return { decision: 'ineligible', reasons: ['ineligible_punctuation_only'] };
  }

  if (!isSimilarCorrection(trimmedAlias, trimmedPreferred)) {
    return { decision: 'ineligible', reasons: ['ineligible_sentence_rewrite'] };
  }

  if (isCommonWordLike(trimmedAlias)) {
    reasons.push('source_is_common_word');
  }

  if (isCommonWordLike(trimmedPreferred)) {
    return { decision: 'ambiguous', reasons: [...reasons, 'ambiguous_common_word'] };
  }

  if (isAcronym(trimmedPreferred)) {
    return { decision: 'eligible', reasons: [...reasons, 'eligible_acronym'] };
  }

  if (isTechnicalTerm(trimmedPreferred)) {
    return { decision: 'eligible', reasons: [...reasons, 'eligible_technical_term'] };
  }

  if (isProperNounPhrase(trimmedPreferred)) {
    return { decision: 'eligible', reasons: [...reasons, 'eligible_proper_noun'] };
  }

  return { decision: 'ambiguous', reasons: [...reasons, 'ambiguous_unclassified_term'] };
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
  if (!isSimilarCorrection(alias, preferred)) {
    return null;
  }

  return { alias, preferred };
}

export function nextLearnedStatus(current: DictionaryEntryStatus, recurrenceCount: number): DictionaryEntryStatus {
  if (current === 'disabled') return 'disabled';
  return recurrenceCount >= 2 ? 'active' : 'learning';
}
