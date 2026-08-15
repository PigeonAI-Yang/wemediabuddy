/**
 * WmbCreatureMark — the WMB brand creature in its six orchestration
 * states (idle / connect / working / settling / sleep / scout).
 * Decorative mark for topbar, Today scout, and Pi presence;
 * always aria-hidden. Do not approximate the geometry — copy from
 * src/renderer/wmb-brand-mark.tsx.
 *
 * Usage:
 *   <WmbCreatureMark state="working" />
 *   <WmbCreatureMark state="sleep" className="my-mark" />
 *
 * Props:
 * - state: 'idle' | 'connect' | 'working' | 'settling' | 'sleep' | 'scout'
 * - className: extra class appended to .wmb-creature-mark
 */
export interface WmbCreatureMarkProps {
  state?: 'idle' | 'connect' | 'working' | 'settling' | 'sleep' | 'scout';
  className?: string;
}
