import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harnessPath = path.join(repoRoot, "tests/e2e/harness.mjs");
const harnessMod = await import("file:///" + path.join(repoRoot, "tests/e2e/harness.mjs").replace(/\\/g,"/"));
const { launchApp, waitForAppReady, navigateTo, delay } = harnessMod;
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
mkdirSync(REPORT_DIR, {recursive:true});

console.log("[audit] launching isolated app for flicker observation");
const { app, page, evidence, workspace } = await launchApp({
  workspaceId: "audit-flicker-" + Date.now(),
  displayName: "audit-flicker",
  headless: false,
  artifactsDir: REPORT_DIR,
});
let finalResult = null;
try {
  await waitForAppReady(page);
  await page.setViewportSize({width: 1280, height: 800});
  await delay(1200);
  await navigateTo(page, "today");
  await page.waitForSelector('[aria-label="今日经营概况"]', {timeout:15000}).catch(()=>{});
  await page.waitForSelector('.today-overview', {timeout:15000});
  await delay(1000);

  // take initial screenshot
  const screenshotPath = path.join(REPORT_DIR, "audit-today-flicker-t0.png");
  await page.screenshot({path: screenshotPath, fullPage:false});
  console.log("[audit] t0 screenshot", screenshotPath);

  // instrument page
  const instrumentation = await page.evaluate(async () => {
    const result = {
      url: location.href,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      initialOverviewHtml: document.querySelector('.today-overview')?.outerHTML?.slice(0,2000) || null,
      initialOverviewMetricsText: (() => {
        const vals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent);
        const changes = [...document.querySelectorAll('.today-metric-change')].map(e=>e.textContent);
        return {vals, changes};
      })(),
      overviewExists: !!document.querySelector('.today-overview'),
      overviewRect: document.querySelector('.today-overview')?.getBoundingClientRect() ? {w: document.querySelector('.today-overview').getBoundingClientRect().width, h: document.querySelector('.today-overview').getBoundingClientRect().height} : null,
      computedStyle: (() => {
        const el = document.querySelector('.today-overview');
        if(!el) return null;
        const cs = getComputedStyle(el);
        return {display: cs.display, opacity: cs.opacity, visibility: cs.visibility, animation: cs.animation, transition: cs.transition, height: cs.height, overflow: cs.overflow};
      })(),
      appShellExists: !!document.querySelector('.app-shell'),
      todayLayoutExists: !!document.querySelector('.today-layout'),
    };
    // attach audit markers
    const overview = document.querySelector('.today-overview');
    if(overview){
      overview.setAttribute('data-audit-id','overview-1');
      // @ts-ignore
      window.__auditOverviewNode = overview;
      // @ts-ignore
      window.__auditOverviewWeak = new WeakRef(overview);
    }
    // setup counters
    // @ts-ignore
    window.__audit = {
      metricsCalls: [],
      todayCalls: [],
      renderCount: 0,
      mutations: [],
      viewTransitions: 0,
      reloads: 0,
      beforeunload: 0,
      dataChanged: [],
      visibilityChanges: [],
      overviewRemounts: 0,
      overviewRerenders: 0,
      setNullEvents: 0,
    };
    const audit = window.__audit;
    // hook getTodayOverviewMetrics
    const origMetrics = window.wmb.getTodayOverviewMetrics;
    if(origMetrics){
      window.wmb.getTodayOverviewMetrics = async (...args) => {
        const ts = Date.now();
        audit.metricsCalls.push({ts, args});
        const res = await origMetrics.apply(window.wmb, args);
        audit.metricsCalls[audit.metricsCalls.length-1].done = Date.now();
        audit.metricsCalls[audit.metricsCalls.length-1].value = res ? {updatedAt: res.updatedAt, sources: res.sources?.value, opps: res.opportunities?.value, projects: res.projects?.value, pubs: res.publications?.value} : null;
        return res;
      };
    }
    const origToday = window.wmb.getToday;
    if(origToday){
      window.wmb.getToday = async (...args) => {
        const ts = Date.now();
        audit.todayCalls.push({ts, args});
        const res = await origToday.apply(window.wmb, args);
        audit.todayCalls[audit.todayCalls.length-1].done = Date.now();
        return res;
      };
    }
    // hook startViewTransition
    const origVT = document.startViewTransition;
    if(origVT){
      document.startViewTransition = function(cb){
        audit.viewTransitions++;
        // @ts-ignore
        return origVT.call(document, cb);
      };
    }
    window.addEventListener('beforeunload', ()=>{ audit.beforeunload++; audit.reloads++; });
    document.addEventListener('visibilitychange', ()=>{ audit.visibilityChanges.push({ts: Date.now(), hidden: document.hidden}); });
    // dataChanged listener
    if(window.wmb.onDataChanged){
      window.wmb.onDataChanged((event)=>{ audit.dataChanged.push({ts: Date.now(), scopes: event.scopes, reason: event.reason}); });
    }
    // MutationObserver on overview parent and app-shell
    const target = document.querySelector('.today-layout') || document.body;
    let lastOverview = document.querySelector('.today-overview');
    let lastWeak = lastOverview ? new WeakRef(lastOverview) : null;
    const mo = new MutationObserver((mutations)=>{
      for(const m of mutations){
        if(m.type==='childList'){
          audit.mutations.push({ts: Date.now(), type:'childList', added: m.addedNodes.length, removed: m.removedNodes.length, target: (m.target && m.target.className ? String(m.target.className).slice(0,60) : "")});
          // check overview remount
          const cur = document.querySelector('.today-overview');
          if(cur !== lastOverview){
            if(lastWeak && lastWeak.deref() && cur !== lastWeak.deref()){
              // previous node detached and new node created = remount
              // check if previous still in DOM
              if(!document.contains(lastWeak.deref())){
                audit.overviewRemounts++;
              } else {
                audit.overviewRerenders++;
              }
            } else if(cur && !lastOverview){
              // first mount already counted?
            }
            lastOverview = cur;
            if(cur) lastWeak = new WeakRef(cur);
          }
        } else if(m.type==='attributes'){
          if(m.target && m.target.matches && m.target.matches('.today-overview, .today-overview *')){
            audit.mutations.push({ts: Date.now(), type:'attributes', attr: m.attributeName, target: (m.target && m.target.className ? String(m.target.className).slice(0,60) : "")});
          }
        }
      }
    });
    mo.observe(target, {childList:true, subtree:true, attributes:true, attributeFilter:['class','style','data-unknown']});
    // also observe app-shell for route/window reload
    const appShell = document.querySelector('.app-shell');
    if(appShell){
      const mo2 = new MutationObserver((ms)=>{
        for(const m of ms){
          audit.mutations.push({ts: Date.now(), type:'appShell-'+m.type, target: (m.target && m.target.className ? String(m.target.className).slice(0,40) : "")});
        }
      });
      mo2.observe(appShell, {childList:true, subtree:true});
    }
    // poll overview metrics text every 200ms to detect flicker "—"
    let lastVals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
    const interval = setInterval(()=>{
      const curVals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
      if(curVals !== lastVals){
        audit.overviewRerenders++;
        // detect flash to "—"
        const vals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent);
        const isDash = vals.includes('—');
        audit.mutations.push({ts: Date.now(), type:'metric-change', vals: vals.join('|'), isDash});
        lastVals = curVals;
      }
      // check if overview node identity changed
      const cur = document.querySelector('.today-overview');
      // @ts-ignore
      const weak = window.__auditOverviewWeak;
      if(cur && weak && weak.deref() !== cur){
        // remount detected via weak
        // will be counted via childList but also here
      }
    }, 200);
    // @ts-ignore
    window.__auditInterval = interval;
    // @ts-ignore
    window.__auditMO = mo;
    return result;
  });
  console.log("[audit] initial instrumentation", JSON.stringify(instrumentation, null, 2));

  // observe for 35 seconds idle (covers 5s poll if running, but running is likely false initially)
  console.log("[audit] observing idle for 35s...");
  // trigger a manual dataChanged refresh after 5s to see overview null flash
  await delay(5000);
  // capture mid state
  const mid1 = await page.evaluate(() => {
    const audit = window.__audit;
    const vals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent);
    const cur = document.querySelector('.today-overview');
    // @ts-ignore
    const weak = window.__auditOverviewWeak;
    const sameNode = weak ? weak.deref() === cur : null;
    return {vals: vals.join('|'), sameNode, metricsCalls: audit.metricsCalls.length, todayCalls: audit.todayCalls.length, mutations: audit.mutations.slice(-5), viewTransitions: audit.viewTransitions, remounts: audit.overviewRemounts, rerenders: audit.overviewRerenders, dashEvents: audit.mutations.filter(m=>m.type==='metric-change' && m.isDash).length};
  });
  console.log("[audit] mid1 after 5s", JSON.stringify(mid1, null, 2));

  // Force a today refresh that will trigger overviewMetrics effect
  console.log("[audit] forcing window.wmb.getToday -> triggers overview fetch");
  await page.evaluate(async () => {
    const planDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
    await window.wmb.getToday(planDate);
  });
  await delay(2000);
  const afterForce = await page.evaluate(() => {
    const audit = window.__audit;
    const vals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent);
    const changes = [...document.querySelectorAll('.today-metric-change')].map(e=>e.textContent);
    const trends = document.querySelectorAll('.today-metric-trend svg').length;
    return {
      vals: vals.join('|'),
      changes: changes.join('|'),
      trends,
      metricsCalls: audit.metricsCalls.slice(-3),
      todayCalls: audit.todayCalls.slice(-3),
      mutations: audit.mutations.slice(-10),
      viewTransitions: audit.viewTransitions,
      remounts: audit.overviewRemounts,
      rerenders: audit.overviewRerenders,
    };
  });
  console.log("[audit] afterForce", JSON.stringify(afterForce, null, 2));

  // Observe another 15s
  await delay(15000);
  const late = await page.evaluate(() => {
    const audit = window.__audit;
    return {
      totalMetricsCalls: audit.metricsCalls.length,
      totalTodayCalls: audit.todayCalls.length,
      viewTransitions: audit.viewTransitions,
      reloads: audit.reloads,
      beforeunload: audit.beforeunload,
      mutationsCount: audit.mutations.length,
      remounts: audit.overviewRemounts,
      rerenders: audit.overviewRerenders,
      metricsCalls: audit.metricsCalls,
      todayCalls: audit.todayCalls,
      dataChanged: audit.dataChanged.slice(-10),
      recentMutations: audit.mutations.slice(-20),
      currentVals: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),
      sameNode: (()=>{ const cur=document.querySelector('.today-overview'); const w=window.__auditOverviewWeak; return w? w.deref()===cur : null; })(),
      computed: (()=>{ const el=document.querySelector('.today-overview'); if(!el) return null; const cs=getComputedStyle(el); return {display: cs.display, opacity: cs.opacity, height: cs.height, transition: cs.transition, animation: cs.animation}; })(),
      overviewRect: document.querySelector('.today-overview')?.getBoundingClientRect() ? {w: document.querySelector('.today-overview').getBoundingClientRect().width, h: document.querySelector('.today-overview').getBoundingClientRect().height} : null,
    };
  });
  console.log("[audit] late after 15s idle", JSON.stringify(late, null, 2));

  // Now test running state: start daily intelligence if not running, to trigger 5s poll loop
  // Check running state via TodayView internal? We can check existence of .today-overview-run (running bar)
  const runningBefore = await page.evaluate(()=> !!document.querySelector('.today-overview-run'));
  console.log("[audit] runningBefore", runningBefore);
  // Try to start intelligence (will go through control)
  // Only if not running, attempt to intercept start to measure flicker; but we don't want to actually trigger long job
  // Instead, we can simulate polling by directly calling load loop via window.wmb.getToday repeatedly
  console.log("[audit] simulating rapid today polling (5s interval burst) to observe overview null flash");
  await page.evaluate(async () => {
    const audit = window.__audit;
    audit.metricsCalls = []; // reset for this burst
    audit.mutations = [];
    audit.overviewRerenders=0;
    audit.overviewRemounts=0;
  });
  for(let i=0;i<3;i++){
    await page.evaluate(async () => {
      const planDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
      // trigger getToday which in real app would fire via onDataChanged -> refreshToday -> today prop change -> overview effect
      // To simulate the overview effect directly, we trigger the effect by dispatching data:changed event? Instead, directly call getTodayOverviewMetrics via effect path
      // The TodayView effect does setOverviewMetrics(null) then fetch. We simulate by calling same sequence
      // But we can just call window.wmb.getTodayOverviewMetrics to see render count; the real flicker is set null before fetch, which we need to observe
      // Let's emulate the effect's set null: we poke React by forcing a today prop change via window event?
      // Simpler: directly test if rapid today changes cause overviewMetrics to flash
      window.dispatchEvent(new CustomEvent('test-audit-tick'));
    });
    // manually trigger a data:changed to cause App refreshToday?
    // Instead we directly evaluate that overviewMetrics effect would fire; we can observe by checking if metricsCalls increase and vals flash to —
    await delay(1000);
    // Check vals during this period
    const vals = await page.evaluate(()=> [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'));
    console.log(`[audit] burst ${i} vals`, vals);
  }
  // Capture burst result
  const burst = await page.evaluate(() => {
    const audit = window.__audit;
    return {
      metricsCalls: audit.metricsCalls,
      rerenders: audit.overviewRerenders,
      remounts: audit.overviewRemounts,
      mutations: audit.mutations.slice(-30),
      currentVals: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),
    };
  });
  console.log("[audit] burst result", JSON.stringify(burst, null, 2));

  // Now do direct set-null test: instrument the component's setOverviewMetrics(null) path by measuring interval between null and re-fetch
  // We can monkey-patch React state? Simpler: we observe existing metricsCalls timing and val dash duration
  // Force a single overview fetch with intermediate null check via polling metrics text every 50ms
  const flashTest = await page.evaluate(async () => {
    const audit = window.__audit;
    // record metric values at 50ms granularity for 3s while triggering a fetch
    const samples = [];
    const start = Date.now();
    const planDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
    // start sampling
    let stopped=false;
    const sampler = setInterval(()=>{
      const vals = [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
      samples.push({t: Date.now()-start, vals});
      if(Date.now()-start>3000){ clearInterval(sampler); stopped=true; }
    }, 50);
    // trigger fetch that mimics effect: we will directly call setOverviewMetrics path? Can't directly, but we can trigger App's refreshToday then see if effect fires
    // Do App refresh: call getToday then rely on effect dependency [today] -> should cause overview null flash if today changes
    // To guarantee today changes, we can call window.wmb.getToday and then manually setOverviewMetrics(null) simulation via React DevTools? Instead we just call getTodayOverviewMetrics directly and see if UI flashes: it shouldn't flash unless set null happens
    // So we test both: first just call getTodayOverviewMetrics (no set null) - should not flash
    await window.wmb.getTodayOverviewMetrics(planDate);
    await new Promise(r=>setTimeout(r, 500));
    // Now simulate effect's set null by dispatching a fake today change: we cannot set React state directly, but we can check sampling during second fetch which includes set null
    // The effect's set null happens synchronously before fetch; we haven't triggered it yet via true today change, so we will force it by reloading TodayView? Instead we manually cause the effect to run by changing planDate? planDate is stable (today), not change.
    // So to truly test, we need to cause today prop to change. We'll do window.wmb.getToday and then if returned value differs, App will setToday new object, causing TodayView's effect -> set null. Let's do that.
    // First get current today
    const before = await window.wmb.getToday(planDate);
    // Wait a bit and get again - should be same, not trigger? But we can force App's refreshToday by calling it via page evaluate calling the inner function? App's refreshToday is not exposed directly, but we can trigger via data:changed event which App listens to
    // Trigger data:changed today event to force App to refetch today -> which may cause today prop change if DB changed? But DB not changed, so no new today, so no effect.
    // To force effect, we can directly invoke the effect's logic: setOverviewMetrics(null) is not exposed. So we simulate by checking if after a data:changed, the component does or doesn't flash.
    // For now, just sample during a forced App-side fetch via dispatching data:changed
    // Use internal broadcast via window.dispatchEvent? App listens to window.wmb.onDataChanged, which is an ipcRenderer event, not window event. Hard to trigger externally.
    // We'll just have samples covering the one fetch we did
    await new Promise(r=>{
      const check = setInterval(()=>{ if(stopped) {clearInterval(check); r();} }, 100);
    });
    return {samples, auditMetrics: audit.metricsCalls.slice(-5)};
  });
  console.log("[audit] flashTest samples count", flashTest.samples.length);
  console.log("[audit] flashTest first 20", JSON.stringify(flashTest.samples.slice(0,20), null, 2));
  console.log("[audit] flashTest dash periods", JSON.stringify(flashTest.samples.filter(s=>s.vals.includes('—')), null, 2));

  // Final comprehensive snapshot
  const finalSnap = await page.evaluate(() => {
    const audit = window.__audit;
    const overview = document.querySelector('.today-overview');
    const layout = document.querySelector('.today-layout');
    const appShell = document.querySelector('.app-shell');
    return {
      url: location.href,
      viewport: {w: window.innerWidth, h: window.innerHeight},
      overviewOuter: overview?.outerHTML?.slice(0,3000) || null,
      overviewMetrics: [...document.querySelectorAll('.today-metric')].map(e=>({label:e.querySelector('.today-metric-label')?.textContent, val:e.querySelector('.today-metric-value')?.textContent, change:e.querySelector('.today-metric-change')?.textContent, unknown: e.querySelector('.today-metric-value')?.getAttribute('data-unknown')})),
      computedOverview: (()=>{ if(!overview) return null; const cs=getComputedStyle(overview); return {display: cs.display, opacity: cs.opacity, height: cs.height, transition: cs.transition, animation: cs.animation, gridTemplate: cs.gridTemplateColumns}; })(),
      computedLayout: (()=>{ if(!layout) return null; const cs=getComputedStyle(layout); return {display: cs.display, height: cs.height}; })(),
      appShellClass: appShell?.className || null,
      documentHidden: document.hidden,
      localStorageKeys: Object.keys(localStorage).filter(k=>k.includes('wmb')||k.includes('today')).slice(0,20),
      audit,
      consoleErrors: window.__audit ? null : null,
    };
  });
  console.log("[audit] finalSnap", JSON.stringify(finalSnap, null, 2).slice(0,8000));

  // Save evidence
  const evidencePath = path.join(REPORT_DIR, "audit-today-flicker-evidence.json");
  writeFileSync(evidencePath, JSON.stringify({instrumentation, mid1, afterForce, late, burst, flashTest, finalSnap, evidence: {console: evidence.console.slice(-50), errors: evidence.errors, pageerrors: evidence.pageerrors}}, null, 2));
  console.log("[audit] evidence saved", evidencePath);
  // screenshot final
  const finalShot = path.join(REPORT_DIR, "audit-today-flicker-final.png");
  await page.screenshot({path: finalShot, fullPage:false});
  console.log("[audit] final screenshot", finalShot);

  finalResult = {evidencePath, finalShot, workspace: workspace.dataRoot};

} catch(e){
  console.error("[audit] error", e);
  throw e;
} finally {
  await delay(1000);
  await harness.closeApp(app, {}).catch(()=>{});
  console.log("[audit] app closed");
}
