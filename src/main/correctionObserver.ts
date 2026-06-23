import { systemPreferences } from 'electron';
import { extractCorrectionCandidate } from '../shared/correctionLearning';
import type { RuleApplicationTrace } from '../shared/dictionary';
import { recordLearnedCorrection, recordRuleRejection } from './dictionaryService';
import { getFrontmostApp, type FrontmostApp } from './textInserter';
import { captureFocusedField } from './voiceContext';

const OBSERVATION_DELAYS_MS = [2000, 6000, 15000, 30000];
let observationGeneration = 0;

export type AppliedRuleInput = {
  ruleId: string;
  source: string;
  replacement: string;
  start: number;
  end: number;
};

export type CorrectionObservationOptions = {
  dictationId?: string;
  appliedRules?: AppliedRuleInput[];
  transcriptionMetadata?: {
    provider?: string;
    model?: string;
    used_vocabulary_guidance?: boolean;
    fallback_used?: boolean;
  };
};

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function sameApp(left: FrontmostApp, right: FrontmostApp): boolean {
  if (left.pid != null && right.pid != null) return left.pid === right.pid;
  return Boolean(left.bundleId && left.bundleId === right.bundleId);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tokenWindow(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean).slice(-4);
}

function buildContextWindow(text: string, start: number, end: number): RuleApplicationTrace['context'] {
  const beforeText = text.slice(Math.max(0, start - 80), start);
  const afterText = text.slice(end, Math.min(text.length, end + 80));
  return {
    beforeText,
    afterText,
    beforeTokens: tokenWindow(beforeText),
    afterTokens: afterText.trim().split(/\s+/).filter(Boolean).slice(0, 4),
  };
}

function enrichAppliedRules(insertedText: string, appliedRules: AppliedRuleInput[] = []): RuleApplicationTrace[] {
  return appliedRules
    .filter(rule => (
      Number.isInteger(rule.start)
      && Number.isInteger(rule.end)
      && rule.start >= 0
      && rule.end > rule.start
      && rule.end <= insertedText.length
    ))
    .map(rule => ({
      ...rule,
      context: buildContextWindow(insertedText, rule.start, rule.end),
    }));
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function matchingRejectedRule(
  candidate: { alias: string; preferred: string },
  appliedRules: RuleApplicationTrace[],
): RuleApplicationTrace | null {
  return appliedRules.find(rule => (
    sameText(candidate.alias, rule.replacement)
    && !sameText(candidate.preferred, rule.replacement)
  )) ?? null;
}

export function cancelCorrectionObservation(): void {
  observationGeneration += 1;
}

export async function observePostInsertionCorrection(
  app: FrontmostApp,
  insertedText: string,
  options: CorrectionObservationOptions = {},
): Promise<void> {
  if (
    process.platform !== 'darwin'
    || app.pid == null
    || !insertedText
    || !systemPreferences.isTrustedAccessibilityClient(false)
  ) {
    return;
  }

  const generation = ++observationGeneration;
  await wait(250);
  if (generation !== observationGeneration) return;

  let baselineSnapshot;
  try {
    baselineSnapshot = await captureFocusedField(app.pid, true);
  } catch {
    return;
  }
  const baseline = stringValue(baselineSnapshot.value);
  const baselineIdentifier = stringValue(baselineSnapshot.identifier);
  const baselineRole = stringValue(baselineSnapshot.role);
  const baselineSubrole = stringValue(baselineSnapshot.subrole);
  const selectionLocation = numberValue(baselineSnapshot.selectionLocation);
  if (!baseline || baselineSnapshot.secure === true || selectionLocation == null) return;

  const insertedEnd = selectionLocation;
  const insertedStart = insertedEnd - insertedText.length;
  if (insertedStart < 0 || baseline.slice(insertedStart, insertedEnd) !== insertedText) return;
  const appliedRules = enrichAppliedRules(insertedText, options.appliedRules);

  let elapsed = 250;
  for (const targetDelay of OBSERVATION_DELAYS_MS) {
    await wait(Math.max(0, targetDelay - elapsed));
    elapsed = targetDelay;
    if (generation !== observationGeneration) return;

    try {
      const frontmost = await getFrontmostApp();
      if (!sameApp(app, frontmost)) return;
      const snapshot = await captureFocusedField(app.pid, true);
      const current = stringValue(snapshot.value);
      if (!current || snapshot.secure === true) return;
      if (
        (baselineIdentifier && stringValue(snapshot.identifier) !== baselineIdentifier)
        || stringValue(snapshot.role) !== baselineRole
        || stringValue(snapshot.subrole) !== baselineSubrole
      ) {
        return;
      }
      const candidate = extractCorrectionCandidate(baseline, current, insertedStart, insertedEnd);
      if (candidate) {
        const rejectedRule = matchingRejectedRule(candidate, appliedRules);
        if (rejectedRule) {
          recordRuleRejection(rejectedRule.ruleId, candidate.preferred);
          return;
        }
        recordLearnedCorrection(candidate.alias, candidate.preferred, {
          name: app.name,
          bundleId: app.bundleId,
        }, {
          dictationId: options.dictationId,
          originalText: baseline,
          correctedText: current,
          provider: options.transcriptionMetadata?.provider,
          model: options.transcriptionMetadata?.model,
          usedVocabularyGuidance: options.transcriptionMetadata?.used_vocabulary_guidance,
          fallbackUsed: options.transcriptionMetadata?.fallback_used,
        });
        return;
      }
      if (current !== baseline) return;
    } catch {
      return;
    }
  }
}
