import { useLayoutEffect, useRef } from 'react';
import { WmbCreatureMark } from './wmb-brand-mark';

const BUTTON_GAP_PX = 26;
const APPROVED_RIGHT_PEEK_SHIFT_PX = 25;

export function TodayScoutCreature(): React.JSX.Element {
  const stageRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const host = stage?.closest<HTMLElement>('.today-command');
    const actions = host?.querySelector<HTMLElement>('.today-command-actions');
    const firstAction = actions?.querySelector<HTMLElement>('button');
    const mark = stage?.querySelector<HTMLElement>('.today-scout-mark');
    if (!stage || !host || !actions || !firstAction || !mark) return;
    const sync = () => {
      const hostRect = host.getBoundingClientRect();
      const actionRect = firstAction.getBoundingClientRect();
      const markWidth = mark.getBoundingClientRect().width;
      const leftCenter = markWidth / 2 + APPROVED_RIGHT_PEEK_SHIFT_PX + BUTTON_GAP_PX;
      const center = actionRect.left - hostRect.left - markWidth / 2 - APPROVED_RIGHT_PEEK_SHIFT_PX - BUTTON_GAP_PX;
      stage.style.setProperty('--today-scout-left-x', `${leftCenter}px`);
      stage.style.setProperty('--today-scout-right-x', `${Math.max(markWidth / 2, center)}px`);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    observer.observe(actions);
    observer.observe(firstAction);
    sync();
    return () => observer.disconnect();
  }, []);
  return <span ref={stageRef} className="today-scout-stage"><WmbCreatureMark state="scout" className="today-scout-mark" /></span>;
}
