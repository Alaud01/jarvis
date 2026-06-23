export type DictionaryEntrySource = 'manual' | 'learned';
export type DictionaryEntryStatus = 'active' | 'learning' | 'disabled';

export type DictionaryObservedApp = {
  name: string;
  bundleId: string;
  lastObservedAt: string;
};

export type LegacyDictionaryEntry = {
  id: string;
  preferred: string;
  aliases: string[];
  source: DictionaryEntrySource;
  status: DictionaryEntryStatus;
  recurrenceCount: number;
  observedApps: DictionaryObservedApp[];
  createdAt: string;
  updatedAt: string;
};

// Backward-compatible name for legacy store migrations and old tests.
export type DictionaryEntry = LegacyDictionaryEntry;

export type VocabularyEntryStatus = 'active' | 'disabled';
export type VocabularyEntrySource = 'manual' | 'learned' | 'migrated';

export type VocabularyEntry = {
  id: string;
  text: string;
  status: VocabularyEntryStatus;
  source: VocabularyEntrySource;
  pinned: boolean;
  observedApps: DictionaryObservedApp[];
  createdAt: string;
  updatedAt: string;
};

export type ReplacementRuleStatus = 'active' | 'pending' | 'suspended' | 'disabled';
export type ReplacementRuleOrigin = 'manual' | 'learned' | 'migrated';

export type ReplacementRuleScope =
  | { kind: 'global' }
  | { kind: 'app'; app: { name: string; bundleId: string } };

export type ReplacementRule = {
  id: string;
  source: string;
  replacement: string;
  vocabularyEntryId: string | null;
  status: ReplacementRuleStatus;
  origin: ReplacementRuleOrigin;
  scope: ReplacementRuleScope;
  recurrenceCount: number;
  distinctDictationCount: number;
  observationIds: string[];
  classificationReasons: string[];
  observedApps: DictionaryObservedApp[];
  createdAt: string;
  updatedAt: string;
  suspendedAt?: string;
  suspensionReason?: string;
};

export type VocabularyCandidateStatus = 'pending' | 'accepted' | 'rejected';
export type VocabularyCandidateDecision = 'eligible' | 'ambiguous' | 'ineligible';

export type VocabularyCandidate = {
  id: string;
  text: string;
  sourceText: string;
  status: VocabularyCandidateStatus;
  decision: VocabularyCandidateDecision;
  classificationReasons: string[];
  observationIds: string[];
  observedApps: DictionaryObservedApp[];
  createdAt: string;
  updatedAt: string;
};

export type CorrectionObservation = {
  id: string;
  dictationId: string;
  originalText: string;
  correctedText: string;
  alias: string;
  preferred: string;
  app: { name: string; bundleId: string };
  classificationDecision: VocabularyCandidateDecision;
  classificationReasons: string[];
  provider?: string;
  model?: string;
  usedVocabularyGuidance?: boolean;
  fallbackUsed?: boolean;
  createdAt: string;
  expiresAt: string;
};

export type ApplicationContextWindow = {
  beforeText: string;
  afterText: string;
  beforeTokens: string[];
  afterTokens: string[];
};

export type RuleApplicationTrace = {
  ruleId: string;
  source: string;
  replacement: string;
  start: number;
  end: number;
  context: ApplicationContextWindow;
};

export type PersonalDictionaryState = {
  vocabularyEntries: VocabularyEntry[];
  replacementRules: ReplacementRule[];
  vocabularyCandidates: VocabularyCandidate[];
  correctionObservations: CorrectionObservation[];
};

export type CreateDictionaryEntryInput = {
  preferred: string;
  aliases?: string[];
  pinned?: boolean;
};

export type UpdateDictionaryEntryInput = {
  preferred?: string;
  status?: VocabularyEntryStatus;
  pinned?: boolean;
};

export type CreateReplacementRuleInput = {
  source: string;
  replacement: string;
  vocabularyEntryId?: string | null;
  scope?: ReplacementRuleScope;
};

export type UpdateReplacementRuleInput = {
  source?: string;
  replacement?: string;
  status?: ReplacementRuleStatus;
  scope?: ReplacementRuleScope;
};

export type UpdateVocabularyCandidateInput = {
  status: 'accepted' | 'rejected';
};

export type DictionaryVoiceEntry = {
  id: string;
  preferred: string;
  aliases: string[];
  scope: ReplacementRuleScope;
};

export type VocabularyVoiceEntry = {
  id: string;
  text: string;
  pinned: boolean;
};
