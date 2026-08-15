import { useCallback, useLayoutEffect, useRef } from 'react';
import motionLibraryUrl from '../../docs/design/brand-motion/wmb-creature-motion-library.html?url';

export type WmbCreatureMotionAction = 'connect' | 'settle' | 'sleep';

const EMBED_STYLE = `
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
body{display:grid;place-items:center}
.card{position:absolute;left:calc(50% - 115px);top:calc(50% - 79px);width:230px;height:158px;min-height:0;padding:0;border:0;border-radius:0;background:transparent;overflow:visible;transform:scale(.4);transform-origin:center}
.card>h3,.card>p,.icon-sample{display:none}
.stage{width:230px;height:158px;padding:0;place-items:center;transform:translateY(-16.5px)}
`;
function syncMotionAsset(frame: HTMLIFrameElement, action: WmbCreatureMotionAction): void {
  const doc = frame.contentDocument;
  if (!doc?.body) return;
  const card = doc.querySelector<HTMLElement>(`.card[data-action="${action}"]`);
  if (!card) return;
  doc.body.replaceChildren(card);
  let style = doc.getElementById('wmb-product-embed-style') as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = 'wmb-product-embed-style';
    doc.head.append(style);
  }
  style.textContent = EMBED_STYLE;
  const hostStyle = getComputedStyle(document.documentElement);
  doc.documentElement.style.setProperty('--violet', hostStyle.getPropertyValue('--accent').trim());
  doc.documentElement.style.setProperty('--ink', hostStyle.getPropertyValue('--ink').trim());
}

/**
 * Product bridge for the Owner-approved executable motion atlas.
 * The frame loads the frozen HTML asset and keeps its selected action DOM/CSS;
 * it does not redraw the mark through the application's static Logo component.
 */
export function WmbCreatureMotionAsset({ action, className = '' }: { action: WmbCreatureMotionAction; className?: string }): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sync = useCallback(() => {
    if (frameRef.current) syncMotionAsset(frameRef.current, action);
  }, [action]);

  useLayoutEffect(() => {
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    sync();
    return () => observer.disconnect();
  }, [sync]);

  const separator = motionLibraryUrl.includes('?') ? '&' : '?';
  return <iframe
    ref={frameRef}
    className={`wmb-creature-motion-asset${className ? ` ${className}` : ''}`}
    src={`${motionLibraryUrl}${separator}wmb-motion-action=${action}`}
    title="WMB 编排状态动画"
    aria-hidden="true"
    tabIndex={-1}
    onLoad={sync}
  />;
}
