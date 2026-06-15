import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CreateDictionaryEntryInput,
  DictionaryEntry,
  DictionaryEntryStatus,
  UpdateDictionaryEntryInput,
} from '../../shared/dictionary';

type Filter = 'all' | DictionaryEntryStatus;

function splitAliases(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function formatObserved(entry: DictionaryEntry): string {
  const app = entry.observedApps[0];
  if (!app) return entry.source === 'manual' ? 'Added manually' : 'No app recorded';
  return `${app.name || app.bundleId} · ${new Date(app.lastObservedAt).toLocaleDateString()}`;
}

const PersonalDictionary: React.FC = () => {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [preferred, setPreferred] = useState('');
  const [alias, setAlias] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPreferred, setEditPreferred] = useState('');
  const [editAliases, setEditAliases] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setEntries(await window.assistant.dictionaryList());
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load personal dictionary');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refresh]);

  const counts = useMemo(() => ({
    all: entries.length,
    active: entries.filter(entry => entry.status === 'active').length,
    learning: entries.filter(entry => entry.status === 'learning').length,
    disabled: entries.filter(entry => entry.status === 'disabled').length,
  }), [entries]);

  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter(entry => {
      if (filter !== 'all' && entry.status !== filter) return false;
      if (!query) return true;
      return entry.preferred.toLowerCase().includes(query)
        || entry.aliases.some(item => item.toLowerCase().includes(query))
        || entry.observedApps.some(app => app.name.toLowerCase().includes(query));
    });
  }, [entries, filter, search]);

  const createEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const input: CreateDictionaryEntryInput = {
        preferred,
        aliases: alias.trim() ? [alias] : [],
      };
      const created = await window.assistant.dictionaryCreate(input);
      setEntries(prev => [created, ...prev]);
      setPreferred('');
      setAlias('');
      setError('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not add entry');
    }
  };

  const beginEdit = (entry: DictionaryEntry) => {
    setEditingId(entry.id);
    setEditPreferred(entry.preferred);
    setEditAliases(entry.aliases.join(', '));
  };

  const updateEntry = async (id: string, input: UpdateDictionaryEntryInput) => {
    try {
      const updated = await window.assistant.dictionaryUpdate(id, input);
      setEntries(prev => prev.map(entry => entry.id === id ? updated : entry));
      setError('');
      return updated;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update entry');
      return null;
    }
  };

  const finishEdit = async (entry: DictionaryEntry) => {
    const updated = await updateEntry(entry.id, {
      preferred: editPreferred,
      aliases: splitAliases(editAliases),
    });
    if (updated) setEditingId(null);
  };

  const deleteEntry = async (entry: DictionaryEntry) => {
    if (!window.confirm(`Delete "${entry.preferred}" from your personal dictionary?`)) return;
    try {
      await window.assistant.dictionaryDelete(entry.id);
      setEntries(prev => prev.filter(item => item.id !== entry.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete entry');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-8 py-10">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">Voice</div>
            <h1 className="mt-2 text-2xl font-semibold text-text-primary">Personal Dictionary</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-tertiary">
              Teach voice flow the names, terms, and phrases that matter to you. Recurring corrections become active after they are observed twice.
            </p>
          </div>
          <div className="rounded-md border border-border-primary bg-bg-secondary px-4 py-3 text-right">
            <div className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Active vocabulary</div>
            <div className="mt-1 text-xl text-text-primary">{counts.active}</div>
          </div>
        </header>

        <form onSubmit={createEntry} className="grid gap-3 rounded-lg border border-border-primary bg-bg-secondary p-5 md:grid-cols-[1fr_1fr_auto]">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Preferred word or phrase</span>
            <input
              value={preferred}
              onChange={event => setPreferred(event.target.value)}
              className="border border-border-primary bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-tertiary"
              placeholder="e.g. Jarvis"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Common mishearing (optional)</span>
            <input
              value={alias}
              onChange={event => setAlias(event.target.value)}
              className="border border-border-primary bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-tertiary"
              placeholder="e.g. jar viss"
            />
          </label>
          <button className="self-end bg-text-primary px-5 py-2 text-xs font-medium text-bg-primary transition-opacity hover:opacity-80">
            Add entry
          </button>
        </form>

        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              className="min-w-[220px] flex-1 border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-text-tertiary"
              placeholder="Search terms, aliases, or apps"
            />
            <div className="flex border border-border-primary bg-bg-secondary p-0.5">
              {(['all', 'active', 'learning', 'disabled'] as Filter[]).map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={`px-3 py-1.5 text-[0.65rem] capitalize transition-colors ${filter === value ? 'bg-text-primary text-bg-primary' : 'text-text-tertiary hover:text-text-primary'}`}
                >
                  {value} {counts[value]}
                </button>
              ))}
            </div>
          </div>

          {error ? <div className="border border-red-400/40 bg-red-400/5 px-3 py-2 text-sm text-red-400">{error}</div> : null}

          <div className="overflow-hidden rounded-lg border border-border-primary">
            {loading ? (
              <div className="px-5 py-10 text-center text-sm text-text-tertiary">Loading dictionary...</div>
            ) : filteredEntries.length === 0 ? (
              <div className="px-5 py-12 text-center">
                <div className="text-sm text-text-secondary">{entries.length === 0 ? 'Your personal dictionary is empty.' : 'No entries match this view.'}</div>
                <div className="mt-1 text-xs text-text-tertiary">Add a term above or correct a dictated phrase twice to teach it automatically.</div>
              </div>
            ) : (
              <table className="w-full table-fixed text-left text-xs">
                <colgroup>
                  <col className="w-12" />
                  <col className="min-w-[160px]" />
                  <col className="min-w-[180px]" />
                  <col className="w-[140px]" />
                  <col className="min-w-[140px]" />
                  <col className="w-[90px]" />
                </colgroup>
                <thead className="bg-bg-secondary font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">On</th>
                    <th className="px-3 py-2 font-medium">Preferred</th>
                    <th className="px-3 py-2 font-medium">Mishearings</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Observed</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEntries.map(entry => (
                    <tr key={entry.id} className="border-t border-border-primary">
                      {editingId === entry.id ? (
                        <>
                          <td className="px-3 py-2 align-middle" colSpan={2}>
                            <input className="w-full border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none" value={editPreferred} onChange={event => setEditPreferred(event.target.value)} />
                          </td>
                          <td className="px-3 py-2 align-middle" colSpan={2}>
                            <input className="w-full border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary outline-none" value={editAliases} onChange={event => setEditAliases(event.target.value)} placeholder="Aliases, comma separated" />
                          </td>
                          <td className="px-3 py-2 align-middle" colSpan={2}>
                            <div className="flex justify-end gap-2">
                              <button type="button" onClick={() => void finishEdit(entry)} className="bg-text-primary px-3 py-1 text-[0.65rem] text-bg-primary">Save</button>
                              <button type="button" onClick={() => setEditingId(null)} className="border border-border-primary px-3 py-1 text-[0.65rem] text-text-secondary">Cancel</button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-1.5 align-middle">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={entry.status === 'active'}
                              title={entry.status === 'active' ? 'Disable entry' : 'Enable entry'}
                              onClick={() => void updateEntry(entry.id, { status: entry.status === 'active' ? 'disabled' : 'active' })}
                              className={`relative h-3 w-6 shrink-0 rounded-full transition-colors ${entry.status === 'active' ? 'bg-text-primary' : 'bg-border-secondary'}`}
                            >
                              <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-bg-primary transition-transform ${entry.status === 'active' ? 'translate-x-[12px]' : 'translate-x-0.5'}`} />
                            </button>
                          </td>
                          <td className="px-3 py-1.5 align-middle font-medium text-text-primary">{entry.preferred}</td>
                          <td className="px-3 py-1.5 align-middle">
                            {entry.aliases.length > 0 ? <span className="block truncate text-text-secondary">{entry.aliases.join(', ')}</span> : <span className="text-text-muted">—</span>}
                          </td>
                          <td className="px-3 py-1.5 align-middle">
                            <span className="rounded border border-border-primary px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-text-muted">{entry.source}</span>
                            {' '}
                            <span className="rounded border border-border-primary px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-text-muted">
                              {entry.status === 'learning' ? `${entry.recurrenceCount}/2` : entry.status}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 align-middle text-[10px] text-text-tertiary">{formatObserved(entry)}</td>
                          <td className="px-3 py-1.5 align-middle text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button type="button" onClick={() => beginEdit(entry)} className="text-text-tertiary hover:text-text-primary">Edit</button>
                              <button type="button" onClick={() => void deleteEntry(entry)} className="text-text-tertiary hover:text-red-400">Delete</button>
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export default PersonalDictionary;
