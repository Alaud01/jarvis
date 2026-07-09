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
      >
        <JarvisIconMark />
      </span>
      <span
        ref={restRef}
        className={`jarvis-wordmark-rest${restRevealed ? ' is-revealed' : ''}`}
        style={{ transitionDuration: `${REST_REVEAL_MS}ms` }}
      >{REST}</span>
    </div>
  );
};

const JarvisIconMark: React.FC = () => (
  <svg
    className="jarvis-wordmark-mark"
    viewBox="604 366 699 1253"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M1302.98 1222.43C1302.98 1325.36 1287.76 1405.32 1257.32 1462.32C1200.88 1566.35 1093.52 1618.37 935.254 1618.37C843.945 1618.37 765.918 1593.75 701.172 1544.5C636.426 1494.69 604.053 1406.43 604.053 1279.7V1192.54H759.277V1279.7C759.277 1346.11 773.942 1396.19 803.271 1429.95C833.154 1463.15 879.362 1479.75 941.895 1479.75C1029.88 1479.75 1087.43 1449.59 1114.55 1389.27C1131.15 1352.19 1139.45 1282.19 1139.45 1179.26V366.615H1302.98V1222.43Z"
      fill="currentColor"
    />
  </svg>
);

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
