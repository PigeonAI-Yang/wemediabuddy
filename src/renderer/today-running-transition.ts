import { useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void | Promise<void>) => unknown;
};

export function useTodayRunningTransition(initialRunning = false): readonly [boolean, (next: boolean) => void] {
  const [running, setRunning] = useState(initialRunning);
  const current = useRef(initialRunning);
  const update = useCallback((next: boolean) => {
    if (current.current === next) return;
    current.current = next;
    const commit = () => setRunning(next);
    const transition = (document as TransitionDocument).startViewTransition;
    if (!transition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commit();
      return;
    }
    transition.call(document, () => flushSync(commit));
  }, []);
  return [running, update] as const;
}
