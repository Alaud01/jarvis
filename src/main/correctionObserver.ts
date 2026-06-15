import { systemPreferences } from 'electron';
import { extractCorrectionCandidate } from '../shared/correctionLearning';
import { recordLearnedCorrection } from './dictionaryService';
import { getFrontmostApp, type FrontmostApp } from './textInserter';
import { captureFocusedField } from './voiceContext';

const OBSERVATION_DELAYS_MS = [2000, 6000, 15000, 30000];
let observationGeneration = 0;

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

export function cancelCorrectionObservation(): void {
  observationGeneration += 1;
}

export async function observePostInsertionCorrection(app: FrontmostApp, insertedText: string): Promise<void> {
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
        recordLearnedCorrection(candidate.alias, candidate.preferred, {
          name: app.name,
          bundleId: app.bundleId,
        });
        return;
      }
      if (current !== baseline) return;
    } catch {
      return;
    }
  }
}
