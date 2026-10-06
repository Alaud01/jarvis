import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeletedConversationMetadata } from '../types';

interface RecentlyDeletedProps {
  onRestore: (id: string) => Promise<void>;
  isStoreMutationPending: boolean;
}

export default function RecentlyDeleted({ onRestore, isStoreMutationPending }: RecentlyDeletedProps) {
  const [conversations, setConversations] = useState<DeletedConversationMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const invalidate = useCallback(() => { ++requestRef.current; }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const deleted = await window.assistant.storeListDeletedConversations();
      if (request !== requestRef.current) return;
      setConversations(deleted.filter(c => Date.parse(c.expiresAt) > Date.now()));
      setNow(Date.now());
      setError(null);
    } catch {
      if (request === requestRef.current) setError('Recently Deleted could not be loaded. Please try again.');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = () => { if (!busyRef.current) void refresh(); };
    const timer = window.setInterval(poll, 30_000);
    window.addEventListener('focus', poll);
    return () => {
      invalidate();
      window.clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [invalidate, refresh]);

  const handleAction = async (conversation: DeletedConversationMetadata, permanent: boolean) => {
    if (busyRef.current || isStoreMutationPending) return;
    if (permanent && !window.confirm(`Permanently delete "${conversation.title}"? This cannot be undone.`)) return;
    busyRef.current = true;
    ++requestRef.current;
    setPendingId(conversation.id);
    setError(null);
    setNotice(null);
    try {
      if (permanent) {
        const result = await window.assistant.storePermanentlyDeleteConversation(conversation.id);
        if (!result.success) throw new Error('Deletion failed');
      } else {
        await onRestore(conversation.id);
      }
      setConversations(prev => prev.filter(c => c.id !== conversation.id));
      setNotice(permanent ? 'Conversation permanently deleted.' : 'Conversation restored. Find it in your sidebar.');
      await refresh();
    } catch {
      setError(permanent
        ? 'The conversation could not be permanently deleted. Please try again.'
        : 'The conversation could not be restored. It may have expired. Refresh and try again.');
    } finally {
      busyRef.current = false;
      setPendingId(null);
    }
  };

  const disabled = pendingId !== null || isStoreMutationPending;
  return (
    <section aria-labelledby="recently-deleted-title" className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-12 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 border-b border-border-primary pb-6">
          <p className="mb-3 font-mono text-[0.65rem] uppercase tracking-[2px] text-text-muted">Conversation history</p>
          <h1 id="recently-deleted-title" className="text-2xl font-medium tracking-tight text-text-primary">Recently Deleted</h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-text-secondary">Deleted conversations stay here for 30 days before being permanently removed. Restore a conversation to bring it back to your sidebar.</p>
        </header>
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="font-mono text-xs text-text-tertiary">{loading ? 'Loading...' : `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`}</p>
          <button type="button" disabled={disabled || loading} onClick={() => void refresh()} className="px-3 py-2 text-xs text-text-secondary hover:bg-bg-hover disabled:opacity-40">Refresh</button>
        </div>
        {error && <p role="alert" className="mb-4 border border-red-500/40 p-3 text-sm text-text-primary">{error}</p>}
        {notice && <p role="status" className="mb-4 text-sm text-text-secondary">{notice}</p>}
        {loading ? <p role="status" className="py-12 text-center text-sm text-text-tertiary">Loading deleted conversations...</p>
          : !error && conversations.length === 0 ? <div className="border border-dashed border-border-secondary px-6 py-14 text-center">
            <h2 className="text-base text-text-primary">No recently deleted conversations</h2>
            <p className="mt-2 text-sm text-text-tertiary">Conversations you delete will appear here.</p>
          </div> : <ul className="divide-y divide-border-primary border-y border-border-primary">
            {conversations.map(conversation => {
              const days = Math.max(0, Math.ceil((Date.parse(conversation.expiresAt) - now) / 86_400_000));
              return <li key={conversation.id} className="flex flex-wrap items-center justify-between gap-4 py-5">
                <div className="min-w-0 flex-1 basis-48">
                  <h2 className="break-words text-sm font-medium text-text-primary">{conversation.title}</h2>
                  <p className="mt-1 font-mono text-xs text-text-tertiary" title={`Permanently removed ${new Date(conversation.expiresAt).toLocaleString()}`}>
                    {days === 0 ? 'Expiring now' : `${days} day${days === 1 ? '' : 's'} remaining`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={disabled} aria-label={`Restore ${conversation.title}`} onClick={() => void handleAction(conversation, false)} className="border border-border-primary px-3 py-2 text-xs text-text-primary hover:bg-bg-hover disabled:opacity-40">Restore</button>
                  <button type="button" disabled={disabled} aria-label={`Permanently delete ${conversation.title}`} onClick={() => void handleAction(conversation, true)} className="px-3 py-2 text-xs text-red-400 hover:bg-bg-hover disabled:opacity-40">Delete permanently</button>
                </div>
                {pendingId === conversation.id && <p role="status" className="w-full text-xs text-text-tertiary">Updating conversation...</p>}
              </li>;
            })}
          </ul>}
      </div>
    </section>
  );
}
