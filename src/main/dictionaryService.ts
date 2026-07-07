import { randomUUID } from 'node:crypto';
import type {
  CorrectionObservation,
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  DictionaryObservedApp,
  DictionaryVoiceEntry,
  LegacyDictionaryEntry,
  PersonalDictionaryState,
  ReplacementRule,
  ReplacementRuleOrigin,
  ReplacementRuleScope,
  ReplacementRuleStatus,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
  VocabularyCandidate,
  VocabularyEntry,
  VocabularyEntryStatus,
  VocabularyVoiceEntry,
} from '../shared/dictionary';
import {
  classifyCorrectionPair,
  isCommonWordLike,
  nextLearnedStatus,
} from '../shared/correctionLearning';
import {
  loadCorrectionObservations,
  loadDictionaryEntries,
  loadReplacementRules,
  loadVocabularyCandidates,
  loadVocabularyEntries,
  saveCorrectionObservations,
  saveDictionaryEntries,
  saveReplacementRules,
  saveVocabularyCandidates,
  saveVocabularyEntries,
} from './store';
import { infoLog } from './logger';

const MAX_ENTRY_TEXT = 120;
const MAX_ALIASES = 12;
const MAX_VOCABULARY_ENTRIES = 1000;
const MAX_REPLACEMENT_RULES = 2000;
const MAX_CANDIDATES = 500;
const OBSERVATION_RETENTION_DAYS = 30;
const OBSERVATION_RETENTION_MS = OBSERVATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const VOCABULARY_GUIDANCE_LIMIT = 100;

export type TranscriptionObservationMetadata = {
  dictationId?: string;
  originalText?: string;
  correctedText?: string;
  provider?: string;
  model?: string;
  usedVocabularyGuidance?: boolean;
  fallbackUsed?: boolean;
};

function normalizeText(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!allowEmpty && !normalized) {
    throw new Error(`${field} is required`);
  }
  if (normalized.length > MAX_ENTRY_TEXT) {
    throw new Error(`${field} must be ${MAX_ENTRY_TEXT} characters or fewer`);
  }
  return normalized;
}

function normalizeAliases(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('aliases must be an array');
  if (value.length > MAX_ALIASES) throw new Error(`aliases must contain at most ${MAX_ALIASES} values`);
  return [...new Set(value.map(alias => normalizeText(alias, 'alias')).map(alias => alias.toLowerCase()))];
}

function textKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sortByUpdatedAt<T extends { updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function sortObservations(observations: CorrectionObservation[]): CorrectionObservation[] {
  return [...observations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function nextObservedApps(
  observedApps: DictionaryObservedApp[],
  app: { name: string; bundleId: string },
  observedAt: string,
): DictionaryObservedApp[] {
  const identity = app.bundleId || app.name;
  const next = observedApps.filter(item => (item.bundleId || item.name) !== identity);
  return [{ name: app.name, bundleId: app.bundleId, lastObservedAt: observedAt }, ...next].slice(0, 8);
}

function normalizeScope(scope: unknown, fallbackApp?: { name: string; bundleId: string }): ReplacementRuleScope {
  if (scope && typeof scope === 'object') {
    const candidate = scope as { kind?: unknown; app?: unknown };
    if (candidate.kind === 'global') return { kind: 'global' };
    if (candidate.kind === 'app' && candidate.app && typeof candidate.app === 'object') {
      const app = candidate.app as { name?: unknown; bundleId?: unknown };
      return {
        kind: 'app',
        app: {
          name: typeof app.name === 'string' ? app.name : '',
          bundleId: typeof app.bundleId === 'string' ? app.bundleId : '',
        },
      };
    }
  }
  if (fallbackApp) {
    return { kind: 'app', app: { name: fallbackApp.name, bundleId: fallbackApp.bundleId } };
  }
  return { kind: 'global' };
}

function isVocabularyStatus(value: unknown): value is VocabularyEntryStatus {
  return value === 'active' || value === 'disabled';
}

function isReplacementRuleStatus(value: unknown): value is ReplacementRuleStatus {
  return value === 'active' || value === 'pending' || value === 'suspended' || value === 'disabled';
}

function ruleMatchesApp(rule: ReplacementRule, app?: { name: string; bundleId: string } | null): boolean {
  if (rule.scope.kind === 'global') return true;
  if (!app) return false;
  const ruleIdentity = rule.scope.app.bundleId || rule.scope.app.name;
  const appIdentity = app.bundleId || app.name;
  return Boolean(ruleIdentity && appIdentity && ruleIdentity === appIdentity);
}

function hasReplacementConflict(rules: ReplacementRule[], source: string, replacement: string, excludeId?: string): boolean {
  const sourceKey = textKey(source);
  const replacementKey = textKey(replacement);
  return rules.some(rule => {
    if (rule.id === excludeId || rule.status === 'disabled' || rule.status === 'suspended') return false;
    const ruleSource = textKey(rule.source);
    const ruleReplacement = textKey(rule.replacement);
    return (
      (ruleSource === sourceKey && ruleReplacement !== replacementKey)
      || (ruleSource === replacementKey && ruleReplacement === sourceKey)
    );
  });
}

function pruneExpiredObservations(observations: CorrectionObservation[], now = new Date()): CorrectionObservation[] {
  const nowMs = now.getTime();
  return observations.filter(observation => {
    const expiresAt = Date.parse(observation.expiresAt);
    return Number.isFinite(expiresAt) ? expiresAt > nowMs : true;
  });
}

function stateFromStores(): PersonalDictionaryState {
  const observations = pruneExpiredObservations(loadCorrectionObservations());
  if (observations.length !== loadCorrectionObservations().length) {
    saveCorrectionObservations(observations);
  }
  return {
    vocabularyEntries: sortByUpdatedAt(loadVocabularyEntries()),
    replacementRules: sortByUpdatedAt(loadReplacementRules()),
    vocabularyCandidates: sortByUpdatedAt(loadVocabularyCandidates()),
    correctionObservations: sortObservations(observations),
  };
}

function saveState(state: PersonalDictionaryState): PersonalDictionaryState {
  saveVocabularyEntries(state.vocabularyEntries);
  saveReplacementRules(state.replacementRules);
  saveVocabularyCandidates(state.vocabularyCandidates);
  saveCorrectionObservations(pruneExpiredObservations(state.correctionObservations));
  return stateFromStores();
}

function legacyOrigin(entry: LegacyDictionaryEntry): ReplacementRuleOrigin {
  return entry.source === 'manual' ? 'manual' : 'migrated';
}

function shouldActivateMigratedRule(entry: LegacyDictionaryEntry, alias: string): boolean {
  if (entry.status === 'disabled') return false;
  if (isCommonWordLike(alias)) return false;
  return nextLearnedStatus(entry.status, entry.recurrenceCount) === 'active';
}

function migrateLegacyDictionaryIfNeeded(): void {
  const current = stateFromStores();
  const legacyEntries = loadDictionaryEntries();
  if (
    legacyEntries.length === 0
    || current.vocabularyEntries.length > 0
    || current.replacementRules.length > 0
    || current.vocabularyCandidates.length > 0
  ) {
    return;
  }

  const vocabularyEntries: VocabularyEntry[] = [];
  const replacementRules: ReplacementRule[] = [];
  const vocabularyCandidates: VocabularyCandidate[] = [];
  const now = new Date().toISOString();

  for (const entry of legacyEntries) {
    const activeAfterMigration = nextLearnedStatus(entry.status, entry.recurrenceCount) === 'active';
    const shouldCreateVocabulary = entry.status === 'active' || activeAfterMigration;
    const vocabularyId = entry.id;

    if (shouldCreateVocabulary || entry.status === 'disabled') {
      vocabularyEntries.push({
        id: vocabularyId,
        text: entry.preferred,
        status: entry.status === 'disabled' ? 'disabled' : 'active',
        source: 'migrated',
        pinned: entry.source === 'manual',
        observedApps: entry.observedApps,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    } else {
      vocabularyCandidates.push({
        id: randomUUID(),
        text: entry.preferred,
        sourceText: entry.aliases[0] ?? '',
        status: 'pending',
        decision: 'ambiguous',
        classificationReasons: ['legacy_learning_pending'],
        observationIds: [],
        observedApps: entry.observedApps,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }

    for (const alias of entry.aliases) {
      const classification = classifyCorrectionPair(alias, entry.preferred);
      const reasons = new Set(classification.reasons);
      if (isCommonWordLike(alias)) reasons.add('source_is_common_word');
      const status: ReplacementRuleStatus = entry.status === 'disabled'
        ? 'disabled'
        : shouldActivateMigratedRule(entry, alias)
          ? 'active'
          : 'pending';
      replacementRules.push({
        id: randomUUID(),
        source: alias,
        replacement: entry.preferred,
        vocabularyEntryId: shouldCreateVocabulary || entry.status === 'disabled' ? vocabularyId : null,
        status,
        origin: legacyOrigin(entry),
        scope: isCommonWordLike(alias) ? normalizeScope(undefined, entry.observedApps[0]) : { kind: 'global' },
        recurrenceCount: entry.recurrenceCount,
        distinctDictationCount: Math.min(entry.recurrenceCount, status === 'active' ? 2 : 1),
        observationIds: [],
        classificationReasons: [...reasons],
        observedApps: entry.observedApps,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  }

  saveVocabularyEntries(vocabularyEntries);
  saveReplacementRules(replacementRules);
  saveVocabularyCandidates(vocabularyCandidates.slice(0, MAX_CANDIDATES));
  saveDictionaryEntries([]);
  infoLog(`[Dictionary] Migrated ${legacyEntries.length} legacy personal dictionary entr${legacyEntries.length === 1 ? 'y' : 'ies'}`);
  if (vocabularyEntries.length === 0 && replacementRules.length === 0 && vocabularyCandidates.length === 0) {
    saveCorrectionObservations([
      {
        id: randomUUID(),
        dictationId: randomUUID(),
        originalText: '',
        correctedText: '',
        alias: '',
        preferred: '',
        app: { name: 'Jarvis', bundleId: '' },
        classificationDecision: 'ineligible',
        classificationReasons: ['legacy_migration_empty'],
        createdAt: now,
        expiresAt: new Date(Date.now() + OBSERVATION_RETENTION_MS).toISOString(),
      },
    ]);
  }
}

function loadState(): PersonalDictionaryState {
  migrateLegacyDictionaryIfNeeded();
  return stateFromStores();
}

function ensureVocabularyEntry(
  state: PersonalDictionaryState,
  preferredValue: string,
  source: VocabularyEntry['source'],
  app: { name: string; bundleId: string },
  now: string,
  pinned = false,
): { state: PersonalDictionaryState; entry: VocabularyEntry } {
  const preferred = normalizeText(preferredValue, 'preferred');
  const existing = state.vocabularyEntries.find(entry => textKey(entry.text) === textKey(preferred));
  if (existing) {
    const updated: VocabularyEntry = {
      ...existing,
      status: 'active',
      pinned: existing.pinned || pinned,
      observedApps: nextObservedApps(existing.observedApps, app, now),
      updatedAt: now,
    };
    return {
      state: {
        ...state,
        vocabularyEntries: state.vocabularyEntries.map(entry => entry.id === updated.id ? updated : entry),
      },
      entry: updated,
    };
  }

  if (state.vocabularyEntries.length >= MAX_VOCABULARY_ENTRIES) {
    throw new Error(`Personal dictionary is limited to ${MAX_VOCABULARY_ENTRIES} vocabulary entries`);
  }

  const entry: VocabularyEntry = {
    id: randomUUID(),
    text: preferred,
    status: 'active',
    source,
    pinned,
    observedApps: nextObservedApps([], app, now),
    createdAt: now,
    updatedAt: now,
  };
  return {
    state: {
      ...state,
      vocabularyEntries: [entry, ...state.vocabularyEntries],
    },
    entry,
  };
}

function addOrUpdatePendingCandidate(
  state: PersonalDictionaryState,
  text: string,
  sourceText: string,
  decision: VocabularyCandidate['decision'],
  reasons: string[],
  observationId: string,
  app: { name: string; bundleId: string },
  now: string,
): PersonalDictionaryState {
  const existing = state.vocabularyCandidates.find(candidate => (
    candidate.status === 'pending' && textKey(candidate.text) === textKey(text)
  ));
  if (existing) {
    const updated: VocabularyCandidate = {
      ...existing,
      sourceText,
      decision,
      classificationReasons: [...new Set([...existing.classificationReasons, ...reasons])],
      observationIds: [...new Set([observationId, ...existing.observationIds])],
      observedApps: nextObservedApps(existing.observedApps, app, now),
      updatedAt: now,
    };
    return {
      ...state,
      vocabularyCandidates: state.vocabularyCandidates.map(candidate => (
        candidate.id === updated.id ? updated : candidate
      )),
    };
  }

  const candidate: VocabularyCandidate = {
    id: randomUUID(),
    text,
    sourceText,
    status: 'pending',
    decision,
    classificationReasons: reasons,
    observationIds: [observationId],
    observedApps: nextObservedApps([], app, now),
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...state,
    vocabularyCandidates: [candidate, ...state.vocabularyCandidates].slice(0, MAX_CANDIDATES),
  };
}

function nextAutoRuleStatus(
  rules: ReplacementRule[],
  source: string,
  replacement: string,
  distinctDictationCount: number,
  reasons: string[],
  excludeId?: string,
): ReplacementRuleStatus {
  if (distinctDictationCount < 2) return 'pending';
  if (isCommonWordLike(source)) return 'pending';
  if (hasReplacementConflict(rules, source, replacement, excludeId)) return 'pending';
  if (reasons.some(reason => reason.startsWith('ineligible_') || reason.startsWith('ambiguous_'))) return 'pending';
  return 'active';
}

function addOrUpdateLearnedRule(
  state: PersonalDictionaryState,
  source: string,
  replacement: string,
  vocabularyEntryId: string | null,
  reasons: string[],
  observationId: string,
  dictationId: string,
  app: { name: string; bundleId: string },
  now: string,
): PersonalDictionaryState {
  if (state.replacementRules.length >= MAX_REPLACEMENT_RULES) return state;
  const existing = state.replacementRules.find(rule => (
    textKey(rule.source) === textKey(source) && textKey(rule.replacement) === textKey(replacement)
  ));
  const observedApps = existing
    ? nextObservedApps(existing.observedApps, app, now)
    : nextObservedApps([], app, now);
  const observationIds = existing
    ? [...new Set([observationId, ...existing.observationIds])]
    : [observationId];
  const distinctDictationIds = new Set(
    state.correctionObservations
      .filter(observation => observationIds.includes(observation.id))
      .map(observation => observation.dictationId),
  );
  distinctDictationIds.add(dictationId);
  const distinctDictationCount = distinctDictationIds.size;
  const classificationReasons = [...new Set([...(existing?.classificationReasons ?? []), ...reasons])];
  if (isCommonWordLike(source)) classificationReasons.push('source_is_common_word');
  if (hasReplacementConflict(state.replacementRules, source, replacement, existing?.id)) {
    classificationReasons.push('conflicts_with_existing_rule');
  }
  const status = existing?.status === 'disabled' || existing?.status === 'suspended'
    ? existing.status
    : nextAutoRuleStatus(
      state.replacementRules,
      source,
      replacement,
      distinctDictationCount,
      classificationReasons,
      existing?.id,
    );

  const updated: ReplacementRule = {
    id: existing?.id ?? randomUUID(),
    source,
    replacement,
    vocabularyEntryId: vocabularyEntryId ?? existing?.vocabularyEntryId ?? null,
    status,
    origin: existing?.origin ?? 'learned',
    scope: existing?.scope ?? (isCommonWordLike(source) ? normalizeScope(undefined, app) : { kind: 'global' }),
    recurrenceCount: (existing?.recurrenceCount ?? 0) + 1,
    distinctDictationCount,
    observationIds,
    classificationReasons: [...new Set(classificationReasons)],
    observedApps,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    suspendedAt: existing?.suspendedAt,
    suspensionReason: existing?.suspensionReason,
  };

  return {
    ...state,
    replacementRules: existing
      ? state.replacementRules.map(rule => rule.id === updated.id ? updated : rule)
      : [updated, ...state.replacementRules],
  };
}

export function listDictionaryEntries(): PersonalDictionaryState {
  return loadState();
}

export function createDictionaryEntry(input: CreateDictionaryEntryInput): PersonalDictionaryState {
  const preferred = normalizeText(input?.preferred, 'preferred');
  const aliases = normalizeAliases(input?.aliases).filter(alias => alias !== textKey(preferred));
  const now = new Date().toISOString();
  const app = { name: 'Manual entry', bundleId: '' };
  let state = loadState();
  const ensured = ensureVocabularyEntry(state, preferred, 'manual', app, now, Boolean(input?.pinned));
  state = ensured.state;

  for (const alias of aliases) {
    state = createReplacementRuleInState(state, {
      source: alias,
      replacement: ensured.entry.text,
      vocabularyEntryId: ensured.entry.id,
      scope: { kind: 'global' },
    }, 'manual', now);
  }

  return saveState(state);
}

export function updateDictionaryEntry(id: string, input: UpdateDictionaryEntryInput): PersonalDictionaryState {
  if (!input || typeof input !== 'object') throw new Error('Dictionary update is required');
  const state = loadState();
  const existing = state.vocabularyEntries.find(entry => entry.id === id);
  if (!existing) throw new Error('Vocabulary entry not found');
  const text = input.preferred === undefined ? existing.text : normalizeText(input.preferred, 'preferred');
  const status = input.status === undefined ? existing.status : input.status;
  if (!isVocabularyStatus(status)) throw new Error('Invalid vocabulary status');
  const updated: VocabularyEntry = {
    ...existing,
    text,
    status,
    pinned: input.pinned === undefined ? existing.pinned : Boolean(input.pinned),
    updatedAt: new Date().toISOString(),
  };
  const nextRules = state.replacementRules.map(rule => (
    rule.vocabularyEntryId === id && textKey(rule.replacement) === textKey(existing.text)
      ? { ...rule, replacement: text, updatedAt: updated.updatedAt }
      : rule
  ));
  return saveState({
    ...state,
    vocabularyEntries: state.vocabularyEntries.map(entry => entry.id === id ? updated : entry),
    replacementRules: nextRules,
  });
}

export function deleteDictionaryEntry(id: string): PersonalDictionaryState {
  const state = loadState();
  return saveState({
    ...state,
    vocabularyEntries: state.vocabularyEntries.filter(entry => entry.id !== id),
    replacementRules: state.replacementRules.filter(rule => rule.vocabularyEntryId !== id),
    vocabularyCandidates: state.vocabularyCandidates.filter(candidate => candidate.id !== id),
  });
}

function createReplacementRuleInState(
  state: PersonalDictionaryState,
  input: CreateReplacementRuleInput,
  origin: ReplacementRuleOrigin,
  now: string,
): PersonalDictionaryState {
  const source = normalizeText(input.source, 'source');
  const replacement = normalizeText(input.replacement, 'replacement');
  if (textKey(source) === textKey(replacement)) throw new Error('Replacement source and target must differ');
  if (state.replacementRules.length >= MAX_REPLACEMENT_RULES) {
    throw new Error(`Personal dictionary is limited to ${MAX_REPLACEMENT_RULES} replacement rules`);
  }
  const existing = state.replacementRules.find(rule => (
    textKey(rule.source) === textKey(source) && textKey(rule.replacement) === textKey(replacement)
  ));
  const classification = classifyCorrectionPair(source, replacement);
  const rule: ReplacementRule = {
    id: existing?.id ?? randomUUID(),
    source,
    replacement,
    vocabularyEntryId: input.vocabularyEntryId ?? existing?.vocabularyEntryId ?? null,
    status: 'active',
    origin,
    scope: normalizeScope(input.scope),
    recurrenceCount: existing?.recurrenceCount ?? 0,
    distinctDictationCount: existing?.distinctDictationCount ?? 0,
    observationIds: existing?.observationIds ?? [],
    classificationReasons: [...new Set([
      ...(existing?.classificationReasons ?? []),
      ...classification.reasons,
      ...(isCommonWordLike(source) ? ['source_is_common_word', 'manual_common_word_approved'] : []),
    ])],
    observedApps: existing?.observedApps ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    ...state,
    replacementRules: existing
      ? state.replacementRules.map(item => item.id === existing.id ? rule : item)
      : [rule, ...state.replacementRules],
  };
}

export function createReplacementRule(input: CreateReplacementRuleInput): PersonalDictionaryState {
  let state = loadState();
  const now = new Date().toISOString();
  let vocabularyEntryId = input.vocabularyEntryId ?? null;
  if (!vocabularyEntryId) {
    const app = { name: 'Manual entry', bundleId: '' };
    const ensured = ensureVocabularyEntry(state, input.replacement, 'manual', app, now, false);
    state = ensured.state;
    vocabularyEntryId = ensured.entry.id;
  }
  return saveState(createReplacementRuleInState(state, { ...input, vocabularyEntryId }, 'manual', now));
}

export function updateReplacementRule(id: string, input: UpdateReplacementRuleInput): PersonalDictionaryState {
  if (!input || typeof input !== 'object') throw new Error('Replacement rule update is required');
  const state = loadState();
  const existing = state.replacementRules.find(rule => rule.id === id);
  if (!existing) throw new Error('Replacement rule not found');
  const source = input.source === undefined ? existing.source : normalizeText(input.source, 'source');
  const replacement = input.replacement === undefined ? existing.replacement : normalizeText(input.replacement, 'replacement');
  if (textKey(source) === textKey(replacement)) throw new Error('Replacement source and target must differ');
  const status = input.status === undefined ? existing.status : input.status;
  if (!isReplacementRuleStatus(status)) throw new Error('Invalid replacement rule status');
  const classification = classifyCorrectionPair(source, replacement);
  const updated: ReplacementRule = {
    ...existing,
    source,
    replacement,
    status,
    scope: input.scope === undefined ? existing.scope : normalizeScope(input.scope),
    classificationReasons: [...new Set([
      ...existing.classificationReasons,
      ...classification.reasons,
      ...(isCommonWordLike(source) ? ['source_is_common_word', 'manual_common_word_approved'] : []),
    ])],
    updatedAt: new Date().toISOString(),
    suspendedAt: status === 'suspended' ? existing.suspendedAt ?? new Date().toISOString() : undefined,
    suspensionReason: status === 'suspended' ? existing.suspensionReason ?? 'manual' : undefined,
  };
  return saveState({
    ...state,
    replacementRules: state.replacementRules.map(rule => rule.id === id ? updated : rule),
  });
}

export function deleteReplacementRule(id: string): PersonalDictionaryState {
  const state = loadState();
  return saveState({
    ...state,
    replacementRules: state.replacementRules.filter(rule => rule.id !== id),
  });
}

export function updateVocabularyCandidate(
  id: string,
  input: UpdateVocabularyCandidateInput,
): PersonalDictionaryState {
  const state = loadState();
  const candidate = state.vocabularyCandidates.find(item => item.id === id);
  if (!candidate) throw new Error('Vocabulary candidate not found');
  const now = new Date().toISOString();
  if (input.status === 'accepted') {
    const app = candidate.observedApps[0] ?? { name: 'Candidate', bundleId: '' };
    const ensured = ensureVocabularyEntry(state, candidate.text, 'learned', app, now, false);
    return saveState({
      ...ensured.state,
      vocabularyCandidates: ensured.state.vocabularyCandidates.map(item => (
        item.id === id ? { ...item, status: 'accepted', updatedAt: now } : item
      )),
    });
  }
  if (input.status === 'rejected') {
    return saveState({
      ...state,
      vocabularyCandidates: state.vocabularyCandidates.map(item => (
        item.id === id ? { ...item, status: 'rejected', updatedAt: now } : item
      )),
    });
  }
  throw new Error('Invalid candidate status');
}

export function getActiveDictionaryVoiceEntries(app?: { name: string; bundleId: string } | null): DictionaryVoiceEntry[] {
  return loadState().replacementRules
    .filter(rule => rule.status === 'active' && ruleMatchesApp(rule, app))
    .map(rule => ({
      id: rule.id,
      preferred: rule.replacement,
      aliases: [rule.source],
      scope: rule.scope,
    }));
}

export function getActiveVocabularyVoiceEntries(
  app?: { name: string; bundleId: string } | null,
): VocabularyVoiceEntry[] {
  const appIdentity = app ? (app.bundleId || app.name) : '';
  return loadState().vocabularyEntries
    .filter(entry => entry.status === 'active')
    .sort((a, b) => {
      const aObserved = appIdentity && a.observedApps.some(item => (item.bundleId || item.name) === appIdentity);
      const bObserved = appIdentity && b.observedApps.some(item => (item.bundleId || item.name) === appIdentity);
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (aObserved !== bObserved) return aObserved ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, VOCABULARY_GUIDANCE_LIMIT)
    .map(entry => ({ id: entry.id, text: entry.text, pinned: entry.pinned }));
}

export function recordLearnedCorrection(
  aliasValue: string,
  preferredValue: string,
  app: { name: string; bundleId: string },
  metadata: TranscriptionObservationMetadata = {},
): PersonalDictionaryState | null {
  const alias = normalizeText(aliasValue, 'alias');
  const preferred = normalizeText(preferredValue, 'preferred');
  if (textKey(alias) === textKey(preferred)) return null;

  const nowDate = new Date();
  const now = nowDate.toISOString();
  const classification = classifyCorrectionPair(alias, preferred);
  let state = loadState();
  const observation: CorrectionObservation = {
    id: randomUUID(),
    dictationId: metadata.dictationId ?? randomUUID(),
    originalText: metadata.originalText ?? alias,
    correctedText: metadata.correctedText ?? preferred,
    alias,
    preferred,
    app,
    classificationDecision: classification.decision,
    classificationReasons: classification.reasons,
    provider: metadata.provider,
    model: metadata.model,
    usedVocabularyGuidance: metadata.usedVocabularyGuidance,
    fallbackUsed: metadata.fallbackUsed,
    createdAt: now,
    expiresAt: new Date(nowDate.getTime() + OBSERVATION_RETENTION_MS).toISOString(),
  };
  state = {
    ...state,
    correctionObservations: [observation, ...state.correctionObservations],
  };

  let vocabularyEntryId: string | null = null;
  if (classification.decision === 'eligible') {
    const ensured = ensureVocabularyEntry(state, preferred, 'learned', app, now, false);
    state = ensured.state;
    vocabularyEntryId = ensured.entry.id;
  } else if (classification.decision === 'ambiguous') {
    state = addOrUpdatePendingCandidate(
      state,
      preferred,
      alias,
      classification.decision,
      classification.reasons,
      observation.id,
      app,
      now,
    );
  }

  if (classification.decision !== 'ineligible') {
    state = addOrUpdateLearnedRule(
      state,
      alias,
      preferred,
      vocabularyEntryId,
      classification.reasons,
      observation.id,
      observation.dictationId,
      app,
      now,
    );
  }

  return saveState(state);
}

export function recordRuleRejection(ruleId: string, rejectedText: string): PersonalDictionaryState {
  const state = loadState();
  const now = new Date().toISOString();
  const rules = state.replacementRules.map(rule => {
    if (rule.id !== ruleId) return rule;
    if (rule.origin === 'manual') {
      return {
        ...rule,
        classificationReasons: [...new Set([...rule.classificationReasons, 'manual_rule_rejected'])],
        updatedAt: now,
      };
    }
    return {
      ...rule,
      status: 'suspended' as const,
      suspendedAt: now,
      suspensionReason: `rejected_output:${rejectedText.slice(0, 80)}`,
      classificationReasons: [...new Set([...rule.classificationReasons, 'auto_rule_rejected'])],
      updatedAt: now,
    };
  });
  return saveState({ ...state, replacementRules: rules });
}
