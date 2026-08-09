
import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(1500);
// ensure open
await page.evaluate(() => {
  const shell=document.querySelector('.app-shell');
  if (shell?.classList.contains('pi-collapsed')) {
    const btn=document.querySelector('.pi-dock-toggle');
    const key=Object.keys(btn||{}).find(k=>k.startsWith('__reactProps$'));
    btn?.[key]?.onClick?.({preventDefault(){},stopPropagation(){},detail:1,currentTarget:btn,target:btn});
  }
});
await page.waitForTimeout(400);
const r = await page.evaluate(() => {
  const b=document.querySelector('.pi-dock-toggle').getBoundingClientRect();
  return {x:b.x+b.width/2,y:b.y+b.height/2};
});
await page.mouse.move(r.x, r.y);
await page.waitForTimeout(300);
const info = await page.evaluate(() => {
  const btn = document.querySelector('.pi-dock-toggle');
  const cs = getComputedStyle(btn);
  // matches via CSSOM
  const matched = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules=[...sheet.cssRules]; } catch { continue; }
    const walk = (list) => {
      for (const rule of list) {
        if (rule.type === CSSRule.MEDIA_RULE) { walk([...rule.cssRules]); continue; }
        if (rule.type !== CSSRule.STYLE_RULE) continue;
        const sel = rule.selectorText || '';
        if (!sel.includes('pi-dock-toggle')) continue;
        try {
          if (btn.matches(sel.split(',').map(s=>s.trim()).find(s=>s.includes('pi-dock-toggle') && !s.includes('::')) || 'never')) {
            matched.push({sel, opacity: rule.style.opacity, href: sheet.href||'inline', cssText: rule.cssText.slice(0,200)});
          }
        } catch {}
        // also check each selector part
        for (const part of sel.split(',').map(s=>s.trim())) {
          if (!part.includes('pi-dock-toggle') || part.includes('::')) continue;
          try {
            if (btn.matches(part)) matched.push({sel: part, opacity: rule.style.opacity, important: rule.style.getPropertyPriority('opacity'), href: sheet.href||'inline'});
          } catch {}
        }
      }
    };
    walk(rules);
  }
  return {
    classList: [...btn.classList],
    parentClass: btn.parentElement?.className,
    shell: document.querySelector('.app-shell')?.className,
    opacity: cs.opacity,
    hovered: btn.matches(':hover'),
    matched: matched.filter(m => m.opacity !== '').slice(0,40),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close().catch(()=>{});
