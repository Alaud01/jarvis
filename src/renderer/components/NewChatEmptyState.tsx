import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface NewChatEmptyStateProps {
  refreshKey: number;
}

const REST = 'arvis';
const FADE_MS = 420;
const FADE_DELAY = 60;
const SLIDE_MS = 900;
const SLIDE_DELAY = FADE_DELAY + FADE_MS;
const REST_REVEAL_MS = 1100;
const REST_REVEAL_DELAY = SLIDE_DELAY + SLIDE_MS + 80;

const NewChatEmptyState: React.FC<NewChatEmptyStateProps> = ({ refreshKey }) => {
  return (
    <div className="py-8">
      <div className="max-w-[800px] mx-auto px-6">
        <div className="relative flex flex-col items-center justify-center min-h-[60vh] text-center">
          <WordmarkVariant key={refreshKey} />
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Wordmark - bold J starts centered, slides smoothly to its final     */
/* left position (one motion), then "arvis" fades in as a whole from   */
/* the background color to the theme's text color.                     */
/* ------------------------------------------------------------------ */

const WordmarkVariant: React.FC = () => {
  const prefersReduced = usePrefersReducedMotion();
  const restRef = useRef<HTMLSpanElement>(null);
  const [restWidth, setRestWidth] = useState(0);
  const [measured, setMeasured] = useState(false);
  const [restRevealed, setRestRevealed] = useState(false);

  useLayoutEffect(() => {
    if (restRef.current) {
      setRestWidth(restRef.current.offsetWidth);
      setMeasured(true);
    }
  }, []);

  useEffect(() => {
    if (prefersReduced) {
      setRestRevealed(true);
      return;
    }
    const id = window.setTimeout(() => setRestRevealed(true), REST_REVEAL_DELAY);
    return () => window.clearTimeout(id);
  }, [prefersReduced]);

  return (
    <div className="jarvis-wordmark" aria-label="Jarvis">
      <span
        className={`jarvis-wordmark-j${measured ? ' is-animated' : ''}`}
        style={{ '--j-offset': `${restWidth / 2}px` } as React.CSSProperties}
      >J</span>
      <span
        ref={restRef}
        className={`jarvis-wordmark-rest${restRevealed ? ' is-revealed' : ''}`}
        style={{ transitionDuration: `${REST_REVEAL_MS}ms` }}
      >{REST}</span>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Shared hook                                                         */
/* ------------------------------------------------------------------ */

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
};

export default NewChatEmptyState;
