import type { DictionaryVoiceEntry, VocabularyVoiceEntry } from './dictionary';

export type VoiceDestinationKind =
  | 'chat'
  | 'email'
  | 'document'
  | 'code'
  | 'terminal'
  | 'jarvis'
  | 'generic';

export type VoiceAccessibilityStatus =
  | 'captured'
  | 'not_requested'
  | 'denied'
  | 'unavailable'
  | 'secure_field'
  | 'failed';

export type VoiceContext = {
  app: {
    name: string;
    bundleId: string;
    pid: number | null;
  } | null;
  destination: VoiceDestinationKind;
  field: {
    role: string | null;
    subrole: string | null;
    textBeforeCursor: string;
    selectedText: string;
    textAfterCursor: string;
  } | null;
  accessibilityStatus: VoiceAccessibilityStatus;
  dictionary: DictionaryVoiceEntry[];
  vocabulary: VocabularyVoiceEntry[];
};

export const EMPTY_VOICE_CONTEXT: VoiceContext = {
  app: null,
  destination: 'generic',
  field: null,
  accessibilityStatus: 'not_requested',
  dictionary: [],
  vocabulary: [],
};
