import { useEffect, useLayoutEffect, useRef } from 'react';

const SCROLL_POSITION_TOLERANCE_PX = 2;
const SCROLL_RESTORE_QUIET_MS = 150;
const SCROLL_RESTORE_MAX_MS = 2_000;
// Scroll positions are persisted as numbers across the preload boundary. A large,
// finite sentinel lets us retain the semantic position "bottom" without changing
// that storage format. It also survives JSON/electron-store serialization.
const SCROLL_BOTTOM = Number.MAX_SAFE_INTEGER;

function getMaxScrollTop(container: HTMLElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

function clampScrollTop(container: HTMLElement, top: number): number {
  const maxScrollTop = getMaxScrollTop(container);
  return Math.min(Math.max(0, top), maxScrollTop);
}

function isAtBottom(container: HTMLElement): boolean {
  return getMaxScrollTop(container) - container.scrollTop <= SCROLL_POSITION_TOLERANCE_PX;
}

function getPositionToPersist(container: HTMLElement): number {
  return isAtBottom(container) ? SCROLL_BOTTOM : container.scrollTop;
}

function applyRestoredPosition(container: HTMLElement, position: number): number {
  const restoredTop = position === SCROLL_BOTTOM
    ? getMaxScrollTop(container)
    : clampScrollTop(container, position);
  container.scrollTop = restoredTop;
  return restoredTop;
}

/**
 * Restores and persists scrollTop for a container keyed by storageKey.
 * Re-applies the restored offset while delayed or virtualized content settles.
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
  const lastAppliedRestoreTopRef = useRef<number | null>(null);
  const lastKnownTopRef = useRef(0);
  const getSavedPositionRef = useRef(getSavedPosition);
  const onPositionChangeRef = useRef(onPositionChange);

  useLayoutEffect(() => {
    getSavedPositionRef.current = getSavedPosition;
    onPositionChangeRef.current = onPositionChange;
  }, [getSavedPosition, onPositionChange]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (activeKeyRef.current !== storageKey) {
      const previousKey = activeKeyRef.current;
      if (previousKey) {
        // React has already committed the incoming conversation by this point, so
        // container.scrollTop may belong to its new DOM. The scroll listener keeps
        // the outgoing view's last real position synchronously for this hand-off.
        onPositionChangeRef.current(previousKey, lastKnownTopRef.current);
      }

      activeKeyRef.current = storageKey;
      if (!storageKey) {
        pendingRestoreRef.current = null;
        lastAppliedRestoreTopRef.current = null;
        lastKnownTopRef.current = 0;
        return;
      }

      const saved = getSavedPositionRef.current(storageKey) ?? 0;
      pendingRestoreRef.current = saved;
      lastAppliedRestoreTopRef.current = null;
      // Preserve the requested position until it can be applied. In particular,
      // do not replace it with a temporary zero while messages are still loading.
      lastKnownTopRef.current = saved;
    }

    if (!storageKey || !container || pendingRestoreRef.current === null) {
      return;
    }

    const requestedTop = pendingRestoreRef.current;
    const restoredTop = applyRestoredPosition(container, requestedTop);
    lastAppliedRestoreTopRef.current = restoredTop;

    if (
      requestedTop !== SCROLL_BOTTOM
      && Math.abs(restoredTop - requestedTop) <= SCROLL_POSITION_TOLERANCE_PX
    ) {
      pendingRestoreRef.current = null;
      lastAppliedRestoreTopRef.current = null;
      // A temporarily empty container is both at the top and bottom. Keep an
      // ordinary numeric restore numeric so a saved top position cannot be
      // mistaken for bottom before its content mounts.
      lastKnownTopRef.current = container.scrollTop;
    }
  }, [containerRef, storageKey, settleRevision]);

  useLayoutEffect(() => () => {
    const activeKey = activeKeyRef.current;
    if (activeKey) {
      onPositionChangeRef.current(activeKey, lastKnownTopRef.current);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!storageKey || !container) {
      return;
    }

    let animationFrameId: number | null = null;
    let quietTimerId: number | null = null;
    let hardTimerId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;

    const clearRestoreTimers = () => {
      if (quietTimerId !== null) {
        window.clearTimeout(quietTimerId);
        quietTimerId = null;
      }
      if (hardTimerId !== null) {
        window.clearTimeout(hardTimerId);
        hardTimerId = null;
      }
    };

    const finishPendingRestore = (captureCurrentPosition = false) => {
      const requestedTop = pendingRestoreRef.current;
      if (requestedTop === null) {
        return;
      }
      pendingRestoreRef.current = null;
      lastAppliedRestoreTopRef.current = null;
      lastKnownTopRef.current = captureCurrentPosition
        ? getPositionToPersist(container)
        : requestedTop;
      clearRestoreTimers();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };

    const scheduleRestoreSettlement = () => {
      if (pendingRestoreRef.current === null) {
        return;
      }
      if (quietTimerId !== null) {
        window.clearTimeout(quietTimerId);
      }
      quietTimerId = window.setTimeout(() => {
        quietTimerId = null;
        const requestedTop = pendingRestoreRef.current;
        if (requestedTop === null) {
          return;
        }

        // An empty container cannot establish bottom affinity yet. Keep waiting
        // for content until the hard deadline instead of converting it to top.
        if (requestedTop === SCROLL_BOTTOM && getMaxScrollTop(container) === 0) {
          return;
        }
        if (requestedTop === SCROLL_BOTTOM) {
          finishPendingRestore();
        }
      }, SCROLL_RESTORE_QUIET_MS);
    };

    const applyPendingRestore = () => {
      animationFrameId = null;
      if (activeKeyRef.current !== storageKey) {
        return;
      }

      if (pendingRestoreRef.current === null) {
        return;
      }

      const requestedTop = pendingRestoreRef.current;
      const restoredTop = applyRestoredPosition(container, requestedTop);
      lastAppliedRestoreTopRef.current = restoredTop;

      if (
        requestedTop !== SCROLL_BOTTOM
        && Math.abs(restoredTop - requestedTop) <= SCROLL_POSITION_TOLERANCE_PX
      ) {
        finishPendingRestore();
        return;
      }
      scheduleRestoreSettlement();
    };

    const schedulePendingRestore = () => {
      if (pendingRestoreRef.current === null || animationFrameId !== null) {
        return;
      }
      scheduleRestoreSettlement();
      animationFrameId = window.requestAnimationFrame(applyPendingRestore);
    };

    if (pendingRestoreRef.current !== null && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(schedulePendingRestore);
    }

    resizeObserver?.observe(container);

    const observeContentElements = () => {
      for (const child of Array.from(container.children)) {
        if (child instanceof HTMLElement) {
          resizeObserver?.observe(child);
        }
      }
    };

    observeContentElements();

    if (pendingRestoreRef.current !== null && typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(() => {
        observeContentElements();
        schedulePendingRestore();
      });
    }

    mutationObserver?.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    hardTimerId = window.setTimeout(() => {
      finishPendingRestore();
    }, SCROLL_RESTORE_MAX_MS);
    schedulePendingRestore();

    const flushSave = () => {
      // A newer key may already have restored this shared container by the time
      // the previous effect cleans up. Do not write that position to the old key.
      if (
        activeKeyRef.current !== null
        && activeKeyRef.current !== storageKey
      ) {
        return;
      }
      onPositionChangeRef.current(storageKey, lastKnownTopRef.current);
    };

    const handleScroll = () => {
      if (pendingRestoreRef.current !== null) {
        const requestedTop = pendingRestoreRef.current;
        const expectedTop = requestedTop === SCROLL_BOTTOM
          ? getMaxScrollTop(container)
          : clampScrollTop(container, requestedTop);
        const lastAppliedTop = lastAppliedRestoreTopRef.current;
        const matchesInternalRestore = (
          lastAppliedTop !== null
          && Math.abs(container.scrollTop - lastAppliedTop) <= SCROLL_POSITION_TOLERANCE_PX
        ) || Math.abs(container.scrollTop - expectedTop) <= SCROLL_POSITION_TOLERANCE_PX;

        if (matchesInternalRestore) {
          lastAppliedRestoreTopRef.current = container.scrollTop;
          return;
        }

        // Keyboard, scrollbar, accessibility, and programmatic navigation all
        // surface as divergence from the position we applied. Preserve that
        // actual position and stop restoration immediately.
        finishPendingRestore(true);
        flushSave();
        return;
      }

      lastKnownTopRef.current = getPositionToPersist(container);
      flushSave();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      clearRestoreTimers();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      container.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef, storageKey]);
}
