import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const harnessMod = await import("file:///" + path.join(repoRoot, "tests/e2e/harness.mjs").replace(/\\/g,"/"));
const { launchApp, waitForAppReady, navigateTo, delay } = harnessMod;
const REPORT_DIR = path.join(repoRoot, ".ai", "frontend-debug-loop", "reports");
mkdirSync(REPORT_DIR, {recursive:true});

console.log("[audit-running] launching");
const { app, page, evidence, workspace } = await launchApp({
  workspaceId: "audit-running-" + Date.now(),
  displayName: "audit-running",
  headless: false,
});
let out=null;
try{
  await waitForAppReady(page);
  await page.setViewportSize({width:1280,height:800});
  await delay(1000);
  await navigateTo(page, "today");
  await page.waitForSelector('.today-overview',{timeout:15000});
  await delay(800);
  // install instrumentation similar but simpler, focusing on metrics flash and viewTransition and app-shell stability
  await page.evaluate(()=>{
    window.__audit2={metricsCalls:0, metricsNullFlash:0, todayCalls:0, viewTransitions:0, reloads:0, mutations:[], polls:[], overviewSame:true, lastVals:""};
    const origMetrics=window.wmb.getTodayOverviewMetrics;
    window.wmb.getTodayOverviewMetrics=async(...args)=>{
      window.__audit2.metricsCalls++;
      // record time before
      const beforeVals=[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
      const res=await origMetrics.apply(window.wmb, args);
      window.__audit2.polls.push({t:Date.now(), before: beforeVals, afterVals: res ? [res.sources.value, res.opportunities.value, res.projects.value, res.publications.value].join('|') : 'null'});
      return res;
    };
    const origToday=window.wmb.getToday;
    window.wmb.getToday=async(...args)=>{
      window.__audit2.todayCalls++;
      const res=await origToday.apply(window.wmb, args);
      return res;
    };
    const origVT=document.startViewTransition;
    if(origVT){
      document.startViewTransition=function(cb){ window.__audit2.viewTransitions++; return origVT.call(document, cb); };
    }
    window.addEventListener('beforeunload',()=>window.__audit2.reloads++);
    // observe overview node identity
    const overview=document.querySelector('.today-overview');
    window.__audit2.overviewNode=overview;
    window.__audit2.overviewWeak=new WeakRef(overview);
    const target=document.querySelector('.today-layout')||document.body;
    const mo=new MutationObserver((muts)=>{
      for(const m of muts){
        if(m.type==='childList'){
          const cur=document.querySelector('.today-overview');
          if(cur!==window.__audit2.overviewNode){
            if(window.__audit2.overviewWeak.deref() && !document.contains(window.__audit2.overviewWeak.deref())){
              window.__audit2.mutations.push({type:'remount',t:Date.now()});
              window.__audit2.overviewSame=false;
            } else if(cur){
              window.__audit2.mutations.push({type:'rerender-childList',t:Date.now(),added:m.addedNodes.length});
            }
            window.__audit2.overviewNode=cur;
            if(cur) window.__audit2.overviewWeak=new WeakRef(cur);
          }
        }
      }
    });
    mo.observe(target,{childList:true, subtree:true});
    // poll vals every 100ms to detect dash flash
    let last=[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
    window.__audit2.lastVals=last;
    setInterval(()=>{
      const cur=[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
      if(cur!==last){
        const isDash=cur.includes('—');
        window.__audit2.mutations.push({type:'vals-change',t:Date.now(),cur,isDash});
        if(isDash) window.__audit2.metricsNullFlash++;
        last=cur;
        window.__audit2.lastVals=cur;
      }
    },100);
    // also watch overviewMetrics state via intercepting TodayView effect? Can't directly, but we can watch data-unknown attr
    const mo2=new MutationObserver((muts)=>{
      for(const m of muts){
        if(m.attributeName==='data-unknown'){
          window.__audit2.mutations.push({type:'data-unknown-change',t:Date.now(),target: m.target.className});
        }
      }
    });
    mo2.observe(document.body,{attributes:true, subtree:true, attributeFilter:['data-unknown']});
  });
  console.log("[audit-running] instrumented");
  // check initial vals
  const init=await page.evaluate(()=>({vals:[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),metricsCalls:window.__audit2.metricsCalls, todayCalls:window.__audit2.todayCalls}));
  console.log("[audit-running] init",init);
  // Start daily intelligence
  const startResult=await page.evaluate(async ()=>{
    const businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    try{
      const r=await window.wmb.startDailyIntelligence({businessDate});
      return {ok:!!r.ok, data:r.data, error:r.error, businessDate};
    }catch(e){ return {error: String(e)}; }
  });
  console.log("[audit-running] startDailyIntelligence", JSON.stringify(startResult,null,2));
  await delay(3000);
  const afterStart=await page.evaluate(()=>({
    metricsCalls:window.__audit2.metricsCalls,
    todayCalls:window.__audit2.todayCalls,
    viewTransitions:window.__audit2.viewTransitions,
    polls:window.__audit2.polls,
    lastVals:window.__audit2.lastVals,
    mutations:window.__audit2.mutations.slice(-20),
    hasRunningBar: !!document.querySelector('.today-overview-run'),
    hasIntelligenceBar: !!document.querySelector('.intelligence-bar'),
    overviewSame: window.__audit2.overviewSame,
  }));
  console.log("[audit-running] afterStart 3s", JSON.stringify(afterStart,null,2));
  // observe for 30s while running (should cover ~6 polls of 5s)
  console.log("[audit-running] observing while running for 30s...");
  await delay(30000);
  const runningObs=await page.evaluate(()=>({
    metricsCalls:window.__audit2.metricsCalls,
    todayCalls:window.__audit2.todayCalls,
    viewTransitions:window.__audit2.viewTransitions,
    reloads:window.__audit2.reloads,
    polls:window.__audit2.polls,
    mutations:window.__audit2.mutations,
    dashFlashes:window.__audit2.metricsNullFlash,
    lastVals:window.__audit2.lastVals,
    overviewSame:window.__audit2.overviewSame,
    hasRunningBar: !!document.querySelector('.today-overview-run'),
    overviewRect: document.querySelector('.today-overview')?.getBoundingClientRect() ? {w:document.querySelector('.today-overview').getBoundingClientRect().width, h:document.querySelector('.today-overview').getBoundingClientRect().height} : null,
    computed: (()=>{ const el=document.querySelector('.today-overview'); if(!el) return null; const cs=getComputedStyle(el); return {display:cs.display, opacity:cs.opacity, height:cs.height, transition:cs.transition, animation:cs.animation}; })(),
    appShellClass:document.querySelector('.app-shell')?.className,
  }));
  console.log("[audit-running] runningObs", JSON.stringify(runningObs,null,2));
  // also capture console evidence from harness
  console.log("[audit-running] harness console last 20", JSON.stringify(evidence.console.slice(-20),null,2));
  console.log("[audit-running] harness errors", JSON.stringify(evidence.errors,null,2));
  console.log("[audit-running] harness pageerrors", JSON.stringify(evidence.pageerrors,null,2));

  // kill running task via cancel to stop polling before close
  const cancelRes=await page.evaluate(async()=>{
    try{
      const runningCheck=document.querySelector('.today-overview-run');
      if(!runningCheck) return {skipped:true};
      // try to find task id via window
      // fallback to getTodayManager? Use getManagerTask via wmb?
      // Use window.wmb.getToday to infer? Just call control via page evaluate calling window.wmb
      // We need to fetch manager task via wmb.getAgentTask?
      // Let's try to use controlDailyIntelligence with first running task found via evaluate of internal state? Instead just call via UI: click cancel/save? easier to just leave running; harness close will kill
      return {hasRunning: !!runningCheck};
    }catch(e){return {error:String(e)}}
  });
  console.log("[audit-running] cancel check",cancelRes);

  const snap=await page.evaluate(()=>({
    vals: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),
    trends: document.querySelectorAll('.today-metric-trend svg').length,
    overviewHtml: document.querySelector('.today-overview')?.outerHTML?.slice(0,2000),
  }));
  const evidencePath=path.join(REPORT_DIR,"audit-today-running-evidence.json");
  writeFileSync(evidencePath, JSON.stringify({init, startResult, afterStart, runningObs, snap, harnessEvidence:{console:evidence.console.slice(-50), errors:evidence.errors, pageerrors:evidence.pageerrors}}, null,2));
  console.log("[audit-running] saved",evidencePath);
  await page.screenshot({path:path.join(REPORT_DIR,"audit-today-running-final.png")});
  out=evidencePath;
}catch(e){
  console.error("[audit-running] error",e);
  throw e;
}finally{
  await delay(1000);
  await harnessMod.closeApp(app, {}).catch(()=>{});
  console.log("[audit-running] closed");
}
