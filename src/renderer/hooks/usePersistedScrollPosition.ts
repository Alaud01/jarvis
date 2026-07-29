import { useEffect, useLayoutEffect, useRef } from 'react';

const SCROLL_SAVE_DEBOUNCE_MS = 200;
const SCROLL_RESTORE_SETTLE_MS = 500;
const SCROLL_RESTORE_RESIZE_EXTEND_MS = 250;

function clampScrollTop(container: HTMLElement, top: number): number {
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.min(Math.max(0, top), maxScrollTop);
}

/**
 * Restores and persists scrollTop for a container keyed by storageKey.
 * Re-applies the restored offset briefly while layout settles (e.g. virtualized lists).
 */
export function usePersistedScrollPosition(
  containerRef: React.RefObject<HTMLElement | null>,
  storageKey: string | null,
  getSavedPosition: (key: string) => number | undefined,
  onPositionChange: (key: string, top: number) => void,
  settleRevision: string | number | boolean | null = null,
): void {
  const activeKeyRef = useRef<string | null>(null);
  const pendingRestoreRef = useRef<number | null>(null);
  const restoreUntilRef = useRef(0);
  const getSavedPositionRef = useRef(getSavedPosition);
  const onPositionChangeRef = useRef(onPositionChange);

  useLayoutEffect(() => {
    getSavedPositionRef.current = getSavedPosition;
    onPositionChangeRef.current = onPositionChange;
  }, [getSavedPosition, onPositionChange]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!storageKey || !container) {
      if (!storageKey) {
        activeKeyRef.current = null;
        pendingRestoreRef.current = null;
      }
      return;
    }

    if (activeKeyRef.current !== storageKey) {
      const previousKey = activeKeyRef.current;
      if (previousKey) {
        // The same container is reused when switching conversation tabs. Save its
        // outgoing position before applying the incoming tab's restored position.
        onPositionChangeRef.current(previousKey, container.scrollTop);
      }

      activeKeyRef.current = storageKey;
      const saved = getSavedPositionRef.current(storageKey);
      pendingRestoreRef.current = typeof saved === 'number' ? saved : 0;
      restoreUntilRef.current = performance.now() + SCROLL_RESTORE_SETTLE_MS;
    }

    if (pendingRestoreRef.current === null || performance.now() > restoreUntilRef.current) {
      return;
    }

    container.scrollTop = clampScrollTop(container, pendingRestoreRef.current);
  }, [containerRef, storageKey, settleRevision]);

  useEffect(() => {
    const container = containerRef.current;
    if (!storageKey || !container) {
      return;
    }

    const applyPendingRestore = () => {
      if (pendingRestoreRef.current === null) {
        return;
      }
      if (performance.now() > restoreUntilRef.current) {
        pendingRestoreRef.current = null;
        return;
      }
      container.scrollTop = clampScrollTop(container, pendingRestoreRef.current);
    };

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        if (pendingRestoreRef.current === null) {
          return;
        }
        restoreUntilRef.current = Math.max(
          restoreUntilRef.current,
          performance.now() + SCROLL_RESTORE_RESIZE_EXTEND_MS,
        );
        applyPendingRestore();
      });

    resizeObserver?.observe(container);
    const firstChild = container.firstElementChild;
    if (firstChild instanceof HTMLElement) {
      resizeObserver?.observe(firstChild);
    }

    let saveTimer: number | null = null;

    const flushSave = () => {
      // A newer key may already have restored this shared container by the time
      // the previous effect cleans up. Do not write that position to the old key.
      if (
        activeKeyRef.current !== null
        && activeKeyRef.current !== storageKey
      ) {
        return;
      }
      onPositionChangeRef.current(storageKey, container.scrollTop);
    };

    const handleScroll = () => {
      if (pendingRestoreRef.current !== null) {
        const target = clampScrollTop(container, pendingRestoreRef.current);
        if (Math.abs(container.scrollTop - target) > 2) {
          pendingRestoreRef.current = null;
        }
      }

      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }
      saveTimer = window.setTimeout(flushSave, SCROLL_SAVE_DEBOUNCE_MS);
    };

    const abandonRestore = () => {
      pendingRestoreRef.current = null;
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', abandonRestore, { passive: true });
    container.addEventListener('touchmove', abandonRestore, { passive: true });

    return () => {
      resizeObserver?.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', abandonRestore);
      container.removeEventListener('touchmove', abandonRestore);
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
      }
      flushSave();
    };
  }, [containerRef, storageKey]);
}
