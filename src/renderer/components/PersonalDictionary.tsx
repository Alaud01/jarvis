import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PersonalDictionaryState,
  ReplacementRule,
  VocabularyCandidate,
  VocabularyEntry,
} from '../../shared/dictionary';

type Tab = 'vocabulary' | 'rules' | 'suggestions';

const EMPTY_STATE: PersonalDictionaryState = {
  vocabularyEntries: [],
  replacementRules: [],
  vocabularyCandidates: [],
  correctionObservations: [],
};

function formatObserved(apps: { name: string; bundleId: string; lastObservedAt: string }[]): string {
  const app = apps[0];
  if (!app) return 'No app recorded';
  return `${app.name || app.bundleId} · ${new Date(app.lastObservedAt).toLocaleDateString()}`;
}

function formatScope(rule: ReplacementRule): string {
  return rule.scope.kind === 'global'
    ? 'Global'
    : rule.scope.app.name || rule.scope.app.bundleId || 'App-specific';
}

function statusPill(value: string): JSX.Element {
  return (
    <span className="rounded border border-border-primary px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-text-muted">
      {value}
    </span>
  );
}

const PersonalDictionary: React.FC = () => {
  const [state, setState] = useState<PersonalDictionaryState>(EMPTY_STATE);
  const [tab, setTab] = useState<Tab>('vocabulary');
  const [search, setSearch] = useState('');
  const [vocabularyText, setVocabularyText] = useState('');
  const [pinned, setPinned] = useState(false);
  const [ruleSource, setRuleSource] = useState('');
  const [ruleReplacement, setRuleReplacement] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setState(await window.assistant.dictionaryList());
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

  const query = search.trim().toLowerCase();
  const visibleVocabulary = useMemo(() => {
    return state.vocabularyEntries.filter(entry => (
      !query
      || entry.text.toLowerCase().includes(query)
      || entry.observedApps.some(app => `${app.name} ${app.bundleId}`.toLowerCase().includes(query))
    ));
  }, [query, state.vocabularyEntries]);

  const visibleRules = useMemo(() => {
    return state.replacementRules.filter(rule => (
      !query
      || rule.source.toLowerCase().includes(query)
      || rule.replacement.toLowerCase().includes(query)
      || rule.classificationReasons.some(reason => reason.toLowerCase().includes(query))
    ));
  }, [query, state.replacementRules]);

  const visibleCandidates = useMemo(() => {
    return state.vocabularyCandidates.filter(candidate => (
      candidate.status === 'pending'
      && (
        !query
        || candidate.text.toLowerCase().includes(query)
        || candidate.sourceText.toLowerCase().includes(query)
        || candidate.classificationReasons.some(reason => reason.toLowerCase().includes(query))
      )
    ));
  }, [query, state.vocabularyCandidates]);

  const createVocabulary = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const next = await window.assistant.dictionaryCreate({ preferred: vocabularyText, pinned });
      setState(next);
      setVocabularyText('');
      setPinned(false);
      setError('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not add vocabulary');
    }
  };

  const createRule = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const next = await window.assistant.dictionaryRuleCreate({
        source: ruleSource,
        replacement: ruleReplacement,
        scope: { kind: 'global' },
      });
      setState(next);
      setRuleSource('');
      setRuleReplacement('');
      setError('');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not add replacement rule');
    }
  };

  const updateVocabulary = async (entry: VocabularyEntry, input: Parameters<typeof window.assistant.dictionaryUpdate>[1]) => {
    try {
      setState(await window.assistant.dictionaryUpdate(entry.id, input));
      setError('');
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update vocabulary');
    }
  };

  const updateRule = async (rule: ReplacementRule, input: Parameters<typeof window.assistant.dictionaryRuleUpdate>[1]) => {
    try {
      setState(await window.assistant.dictionaryRuleUpdate(rule.id, input));
      setError('');
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Could not update replacement rule');
    }
  };

  const deleteVocabulary = async (entry: VocabularyEntry) => {
    if (!window.confirm(`Delete "${entry.text}" and its linked rules from your personal dictionary?`)) return;
    try {
      setState(await window.assistant.dictionaryDelete(entry.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete vocabulary');
    }
  };

  const deleteRule = async (rule: ReplacementRule) => {
    if (!window.confirm(`Delete "${rule.source}" → "${rule.replacement}"?`)) return;
    try {
      setState(await window.assistant.dictionaryRuleDelete(rule.id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete replacement rule');
    }
  };

  const decideCandidate = async (candidate: VocabularyCandidate, status: 'accepted' | 'rejected') => {
    try {
      setState(await window.assistant.dictionaryCandidateUpdate(candidate.id, { status }));
      setError('');
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Could not update suggestion');
    }
  };

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'vocabulary', label: 'Vocabulary', count: state.vocabularyEntries.length },
    { id: 'rules', label: 'Replacement Rules', count: state.replacementRules.length },
    { id: 'suggestions', label: 'Suggestions', count: visibleCandidates.length },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-8 py-10">
        <header className="flex items-start justify-between gap-6">
          <div>
            <div className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">Voice</div>
            <h1 className="mt-2 text-2xl font-semibold text-text-primary">Personal Dictionary</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-tertiary">
              Manage vocabulary Jarvis should recognize separately from exact replacement rules it may apply after transcription.
            </p>
          </div>
          <div className="rounded-md border border-border-primary bg-bg-secondary px-4 py-3 text-right">
            <div className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Active vocabulary</div>
            <div className="mt-1 text-xl text-text-primary">
              {state.vocabularyEntries.filter(entry => entry.status === 'active').length}
            </div>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <input
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="min-w-[220px] flex-1 border border-border-primary bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-text-tertiary"
            placeholder="Search vocabulary, rules, reasons, or apps"
          />
          <div className="flex border border-border-primary bg-bg-secondary p-0.5">
            {tabs.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`px-3 py-1.5 text-[0.65rem] transition-colors ${tab === item.id ? 'bg-text-primary text-bg-primary' : 'text-text-tertiary hover:text-text-primary'}`}
              >
                {item.label} {item.count}
              </button>
            ))}
          </div>
        </div>

        {error ? <div className="border border-red-400/40 bg-red-400/5 px-3 py-2 text-sm text-red-400">{error}</div> : null}

        {tab === 'vocabulary' ? (
          <section className="flex flex-col gap-4">
            <form onSubmit={createVocabulary} className="grid gap-3 rounded-lg border border-border-primary bg-bg-secondary p-5 md:grid-cols-[1fr_auto_auto]">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Vocabulary word or phrase</span>
                <input
                  value={vocabularyText}
                  onChange={event => setVocabularyText(event.target.value)}
                  className="border border-border-primary bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-tertiary"
                  placeholder="e.g. Claude, Supabase, PostgreSQL"
                  required
                />
              </label>
              <label className="flex items-end gap-2 pb-2 text-xs text-text-tertiary">
                <input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} />
                Pin
              </label>
              <button className="self-end bg-text-primary px-5 py-2 text-xs font-medium text-bg-primary transition-opacity hover:opacity-80">
                Add vocabulary
              </button>
            </form>

            <div className="overflow-hidden rounded-lg border border-border-primary">
              {loading ? (
                <div className="px-5 py-10 text-center text-sm text-text-tertiary">Loading dictionary...</div>
              ) : visibleVocabulary.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-text-tertiary">No vocabulary entries match this view.</div>
              ) : (
                <table className="w-full table-fixed text-left text-xs">
                  <thead className="bg-bg-secondary font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
                    <tr>
                      <th className="w-12 px-3 py-2 font-medium">On</th>
                      <th className="px-3 py-2 font-medium">Vocabulary</th>
                      <th className="w-[150px] px-3 py-2 font-medium">Status</th>
                      <th className="w-[180px] px-3 py-2 font-medium">Observed</th>
                      <th className="w-[120px] px-3 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleVocabulary.map(entry => (
                      <tr key={entry.id} className="border-t border-border-primary">
                        <td className="px-3 py-1.5 align-middle">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={entry.status === 'active'}
                            onClick={() => void updateVocabulary(entry, { status: entry.status === 'active' ? 'disabled' : 'active' })}
                            className={`relative h-3 w-6 shrink-0 rounded-full transition-colors ${entry.status === 'active' ? 'bg-text-primary' : 'bg-border-secondary'}`}
                          >
                            <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-bg-primary transition-transform ${entry.status === 'active' ? 'translate-x-[12px]' : 'translate-x-0.5'}`} />
                          </button>
                        </td>
                        <td className="px-3 py-1.5 align-middle font-medium text-text-primary">{entry.text}</td>
                        <td className="px-3 py-1.5 align-middle">
                          {statusPill(entry.source)}
                          {' '}
                          {statusPill(entry.pinned ? 'pinned' : entry.status)}
                        </td>
                        <td className="px-3 py-1.5 align-middle text-[10px] text-text-tertiary">{formatObserved(entry.observedApps)}</td>
                        <td className="px-3 py-1.5 align-middle text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => void updateVocabulary(entry, { pinned: !entry.pinned })}
                              className="text-text-tertiary hover:text-text-primary"
                            >
                              {entry.pinned ? 'Unpin' : 'Pin'}
                            </button>
                            <button type="button" onClick={() => void deleteVocabulary(entry)} className="text-text-tertiary hover:text-red-400">Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'rules' ? (
          <section className="flex flex-col gap-4">
            <form onSubmit={createRule} className="grid gap-3 rounded-lg border border-border-primary bg-bg-secondary p-5 md:grid-cols-[1fr_1fr_auto]">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">When Jarvis hears</span>
                <input
                  value={ruleSource}
                  onChange={event => setRuleSource(event.target.value)}
                  className="border border-border-primary bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-tertiary"
                  placeholder="e.g. postgress"
                  required
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">Replace with</span>
                <input
                  value={ruleReplacement}
                  onChange={event => setRuleReplacement(event.target.value)}
                  className="border border-border-primary bg-bg-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-text-tertiary"
                  placeholder="e.g. PostgreSQL"
                  required
                />
              </label>
              <button className="self-end bg-text-primary px-5 py-2 text-xs font-medium text-bg-primary transition-opacity hover:opacity-80">
                Add rule
              </button>
            </form>

            <div className="overflow-hidden rounded-lg border border-border-primary">
              {loading ? (
                <div className="px-5 py-10 text-center text-sm text-text-tertiary">Loading rules...</div>
              ) : visibleRules.length === 0 ? (
                <div className="px-5 py-12 text-center text-sm text-text-tertiary">No replacement rules match this view.</div>
              ) : (
                <table className="w-full table-fixed text-left text-xs">
                  <thead className="bg-bg-secondary font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
                    <tr>
                      <th className="w-12 px-3 py-2 font-medium">On</th>
                      <th className="px-3 py-2 font-medium">Rule</th>
                      <th className="w-[130px] px-3 py-2 font-medium">Status</th>
                      <th className="w-[150px] px-3 py-2 font-medium">Scope</th>
                      <th className="w-[180px] px-3 py-2 font-medium">Evidence</th>
                      <th className="w-[110px] px-3 py-2 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRules.map(rule => (
                      <tr key={rule.id} className="border-t border-border-primary">
                        <td className="px-3 py-1.5 align-middle">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={rule.status === 'active'}
                            onClick={() => void updateRule(rule, { status: rule.status === 'active' ? 'disabled' : 'active' })}
                            className={`relative h-3 w-6 shrink-0 rounded-full transition-colors ${rule.status === 'active' ? 'bg-text-primary' : 'bg-border-secondary'}`}
                          >
                            <span className={`absolute top-0.5 h-2 w-2 rounded-full bg-bg-primary transition-transform ${rule.status === 'active' ? 'translate-x-[12px]' : 'translate-x-0.5'}`} />
                          </button>
                        </td>
                        <td className="px-3 py-1.5 align-middle text-text-primary">
                          <span className="text-text-secondary">{rule.source}</span>
                          <span className="px-2 text-text-muted">→</span>
                          <span className="font-medium">{rule.replacement}</span>
                        </td>
                        <td className="px-3 py-1.5 align-middle">
                          {statusPill(rule.origin)}
                          {' '}
                          {statusPill(rule.status)}
                        </td>
                        <td className="px-3 py-1.5 align-middle text-text-tertiary">{formatScope(rule)}</td>
                        <td className="px-3 py-1.5 align-middle text-[10px] text-text-tertiary">
                          {rule.distinctDictationCount}/2 dictations
                          {rule.classificationReasons.length > 0 ? ` · ${rule.classificationReasons[0]}` : ''}
                        </td>
                        <td className="px-3 py-1.5 align-middle text-right">
                          <div className="flex items-center justify-end gap-2">
                            {rule.status === 'suspended' ? (
                              <button type="button" onClick={() => void updateRule(rule, { status: 'active' })} className="text-text-tertiary hover:text-text-primary">Restore</button>
                            ) : null}
                            <button type="button" onClick={() => void deleteRule(rule)} className="text-text-tertiary hover:text-red-400">Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'suggestions' ? (
          <section className="overflow-hidden rounded-lg border border-border-primary">
            {loading ? (
              <div className="px-5 py-10 text-center text-sm text-text-tertiary">Loading suggestions...</div>
            ) : visibleCandidates.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-text-tertiary">No pending vocabulary suggestions.</div>
            ) : (
              <table className="w-full table-fixed text-left text-xs">
                <thead className="bg-bg-secondary font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Suggestion</th>
                    <th className="w-[180px] px-3 py-2 font-medium">From</th>
                    <th className="w-[220px] px-3 py-2 font-medium">Reason</th>
                    <th className="w-[130px] px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCandidates.map(candidate => (
                    <tr key={candidate.id} className="border-t border-border-primary">
                      <td className="px-3 py-1.5 align-middle font-medium text-text-primary">{candidate.text}</td>
                      <td className="px-3 py-1.5 align-middle text-text-tertiary">{candidate.sourceText || 'Correction'}</td>
                      <td className="px-3 py-1.5 align-middle text-[10px] text-text-tertiary">
                        {candidate.classificationReasons.join(', ') || candidate.decision}
                      </td>
                      <td className="px-3 py-1.5 align-middle text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button type="button" onClick={() => void decideCandidate(candidate, 'accepted')} className="text-text-tertiary hover:text-text-primary">Add</button>
                          <button type="button" onClick={() => void decideCandidate(candidate, 'rejected')} className="text-text-tertiary hover:text-red-400">Ignore</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
};

export default PersonalDictionary;
