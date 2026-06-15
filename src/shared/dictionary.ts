export type DictionaryEntrySource = 'manual' | 'learned';
export type DictionaryEntryStatus = 'active' | 'learning' | 'disabled';

export type DictionaryObservedApp = {
  name: string;
  bundleId: string;
  lastObservedAt: string;
};

export type DictionaryEntry = {
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

export type CreateDictionaryEntryInput = {
  preferred: string;
  aliases?: string[];
};

export type UpdateDictionaryEntryInput = {
  preferred?: string;
  aliases?: string[];
  status?: DictionaryEntryStatus;
};

export type DictionaryVoiceEntry = {
  preferred: string;
  aliases: string[];
};
