import { randomUUID } from 'node:crypto';
import type {
  CreateDictionaryEntryInput,
  DictionaryEntry,
  DictionaryEntryStatus,
  DictionaryObservedApp,
  DictionaryVoiceEntry,
  UpdateDictionaryEntryInput,
} from '../shared/dictionary';
import { loadDictionaryEntries, saveDictionaryEntries } from './store';
import { nextLearnedStatus } from '../shared/correctionLearning';

const MAX_ENTRY_TEXT = 120;
const MAX_ALIASES = 12;
const MAX_ENTRIES = 1000;

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

function isStatus(value: unknown): value is DictionaryEntryStatus {
  return value === 'active' || value === 'learning' || value === 'disabled';
}

function sortEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listDictionaryEntries(): DictionaryEntry[] {
  return sortEntries(loadDictionaryEntries());
}

export function createDictionaryEntry(input: CreateDictionaryEntryInput): DictionaryEntry {
  const preferred = normalizeText(input?.preferred, 'preferred');
  const aliases = normalizeAliases(input?.aliases).filter(alias => alias !== preferred);
  const entries = loadDictionaryEntries();
  if (entries.length >= MAX_ENTRIES) throw new Error(`Personal dictionary is limited to ${MAX_ENTRIES} entries`);
  const now = new Date().toISOString();
  const entry: DictionaryEntry = {
    id: randomUUID(),
    preferred,
    aliases,
    source: 'manual',
    status: 'active',
    recurrenceCount: 0,
    observedApps: [],
    createdAt: now,
    updatedAt: now,
  };
  saveDictionaryEntries([entry, ...entries]);
  return entry;
}

export function updateDictionaryEntry(id: string, input: UpdateDictionaryEntryInput): DictionaryEntry {
  if (!input || typeof input !== 'object') throw new Error('Dictionary update is required');
  const entries = loadDictionaryEntries();
  const existing = entries.find(entry => entry.id === id);
  if (!existing) throw new Error('Dictionary entry not found');
  const preferred = input.preferred === undefined ? existing.preferred : normalizeText(input.preferred, 'preferred');
  const aliases = input.aliases === undefined
    ? existing.aliases
    : normalizeAliases(input.aliases).filter(alias => alias !== preferred);
  const status = input.status === undefined ? existing.status : input.status;
  if (!isStatus(status)) throw new Error('Invalid dictionary status');
  const updated: DictionaryEntry = {
    ...existing,
    preferred,
    aliases,
    status,
    updatedAt: new Date().toISOString(),
  };
  saveDictionaryEntries(entries.map(entry => entry.id === id ? updated : entry));
  return updated;
}

export function deleteDictionaryEntry(id: string): void {
  saveDictionaryEntries(loadDictionaryEntries().filter(entry => entry.id !== id));
}

export function getActiveDictionaryVoiceEntries(): DictionaryVoiceEntry[] {
  return loadDictionaryEntries()
    .filter(entry => entry.status === 'active')
    .map(entry => ({ preferred: entry.preferred, aliases: entry.aliases }));
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

export function recordLearnedCorrection(
  aliasValue: string,
  preferredValue: string,
  app: { name: string; bundleId: string },
): DictionaryEntry | null {
  const alias = normalizeText(aliasValue, 'alias');
  const preferred = normalizeText(preferredValue, 'preferred');
  if (alias === preferred) return null;

  const entries = loadDictionaryEntries();
  const now = new Date().toISOString();
  const existing = entries.find(entry => (
    entry.preferred.toLowerCase() === preferred.toLowerCase()
    && entry.aliases.some(item => item.toLowerCase() === alias.toLowerCase())
  ));

  if (existing) {
    const recurrenceCount = existing.recurrenceCount + 1;
    const updated: DictionaryEntry = {
      ...existing,
      recurrenceCount,
      status: nextLearnedStatus(existing.status, recurrenceCount),
      observedApps: nextObservedApps(existing.observedApps, app, now),
      updatedAt: now,
    };
    saveDictionaryEntries(entries.map(entry => entry.id === existing.id ? updated : entry));
    return updated;
  }

  if (entries.length >= MAX_ENTRIES) return null;
  const entry: DictionaryEntry = {
    id: randomUUID(),
    preferred,
    aliases: [alias.toLowerCase()],
    source: 'learned',
    status: 'learning',
    recurrenceCount: 1,
    observedApps: nextObservedApps([], app, now),
    createdAt: now,
    updatedAt: now,
  };
  saveDictionaryEntries([entry, ...entries]);
  return entry;
}
