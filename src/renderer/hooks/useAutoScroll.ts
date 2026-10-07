import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export const AUTO_SCROLL_BOTTOM_THRESHOLD = 60;

export function isNearBottom(container: HTMLElement, threshold = AUTO_SCROLL_BOTTOM_THRESHOLD): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

interface AutoScrollOptions {
  /** Pin to the bottom after growth while true (e.g. streaming). */
  active: boolean;
  /** Distance in px from the bottom that still counts as "at the bottom". */
  threshold?: number;
  /** Fires only on real following transitions (user scrolled away / came back). */
  onFollowingChange?: (following: boolean) => void;
}

/**
 * Shared sticky-bottom behavior for the conversation container and the
 * inner thinking box. The follow decision lives in a persistent ref fed by
 * real scroll events — never in a post-growth measurement — so a single
 * large update can't silently kill auto-scroll.
 */
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  { active, threshold = AUTO_SCROLL_BOTTOM_THRESHOLD, onFollowingChange }: AutoScrollOptions,
) {
  const followingRef = useRef(true);
  const onFollowingChangeRef = useRef(onFollowingChange);
  useEffect(() => {
    onFollowingChangeRef.current = onFollowingChange;
  });

  const setFollowing = useCallback((following: boolean) => {
    if (followingRef.current === following) return;
    followingRef.current = following;
    onFollowingChangeRef.current?.(following);
  }, []);

  // A (re)started stream begins pinned to the bottom.
  useEffect(() => {
    if (active) setFollowing(true);
  }, [active, setFollowing]);

  // Pin after content growth while following. Programmatic pins read back
  // as near-bottom, so they never toggle the state themselves.
  useLayoutEffect(() => {
    if (!active || !followingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => setFollowing(isNearBottom(container, threshold));
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [active, containerRef, setFollowing, threshold]);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    setFollowing(true);
  }, [containerRef, setFollowing]);

  return { followingRef, scrollToBottom };
}
