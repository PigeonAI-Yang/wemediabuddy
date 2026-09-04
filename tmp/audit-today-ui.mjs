import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const repoRoot=path.resolve(__dirname,"..");
const harnessMod=await import("file:///" + path.join(repoRoot,"tests/e2e/harness.mjs").replace(/\\/g,"/"));
const {launchApp, waitForAppReady, navigateTo, delay}=harnessMod;
const REPORT_DIR=path.join(repoRoot,".ai/frontend-debug-loop/reports");
mkdirSync(REPORT_DIR,{recursive:true});
console.log("[audit-ui] launching");
const {app, page, evidence}=await launchApp({workspaceId:"audit-ui-"+Date.now(), displayName:"audit-ui", headless:false});
try{
 await waitForAppReady(page);
 await page.setViewportSize({width:1280,height:800});
 await delay(1000);
 await navigateTo(page,"today");
 await page.waitForSelector('.today-overview',{timeout:15000});
 await delay(800);
 // instrument after initial mount
 await page.evaluate(()=>{
   window.__audit={metricsCalls:[], todayCalls:[], viewTransitions:0, reloads:0, mutations:[], overviewSame:true, dashFlashes:0};
   const origM=window.wmb.getTodayOverviewMetrics;
   window.wmb.getTodayOverviewMetrics=async(...args)=>{
     const t=Date.now(); window.__audit.metricsCalls.push({t, before: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|')});
     const res=await origM.apply(window.wmb, args);
     window.__audit.metricsCalls[window.__audit.metricsCalls.length-1].afterTime=Date.now();
     window.__audit.metricsCalls[window.__audit.metricsCalls.length-1].afterVals=[res.sources.value, res.opportunities.value, res.projects.value, res.publications.value].join('|');
     window.__audit.metricsCalls[window.__audit.metricsCalls.length-1].duration=Date.now()-t;
     return res;
   };
   const origT=window.wmb.getToday;
   window.wmb.getToday=async(...args)=>{ window.__audit.todayCalls.push(Date.now()); return await origT.apply(window.wmb,args); };
   const origVT=document.startViewTransition;
   if(origVT) document.startViewTransition=function(cb){ window.__audit.viewTransitions++; return origVT.call(document,cb); };
   window.addEventListener('beforeunload',()=>window.__audit.reloads++);
   // observe overview node identity and metric vals flash
   const overview=document.querySelector('.today-overview');
   window.__audit.overviewNode=overview;
   window.__audit.overviewWeak=new WeakRef(overview);
   const target=document.querySelector('.today-layout')||document.body;
   const mo=new MutationObserver((muts)=>{
     for(const m of muts){
       if(m.type==='childList'){
         const cur=document.querySelector('.today-overview');
         if(cur!==window.__audit.overviewNode){
           if(window.__audit.overviewWeak.deref() && !document.contains(window.__audit.overviewWeak.deref())){
             window.__audit.mutations.push({type:'remount',t:Date.now()});
             window.__audit.overviewSame=false;
           } else if(cur){
             window.__audit.mutations.push({type:'childList-change',t:Date.now()});
           }
           window.__audit.overviewNode=cur;
           if(cur) window.__audit.overviewWeak=new WeakRef(cur);
         }
       }
     }
   });
   mo.observe(target,{childList:true, subtree:true});
   let last=[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
   setInterval(()=>{
     const cur=[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|');
     if(cur!==last){
       if(cur.includes('—')) window.__audit.dashFlashes++;
       window.__audit.mutations.push({type:'vals-change',t:Date.now(), cur, wasDash:cur.includes('—')});
       last=cur;
     }
   },80);
 });
 const init=await page.evaluate(()=>({vals:[...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|')}));
 console.log("[audit-ui] init vals",init);
 // click primary button
 const btn=page.locator('.today-overview .primary-button');
 const btnText=await btn.textContent();
 console.log("[audit-ui] primary btn",btnText);
 await btn.click();
 console.log("[audit-ui] clicked primary");
 await delay(1500);
 const afterClick=await page.evaluate(()=>({
   hasRunningBar: !!document.querySelector('.today-overview-run'),
   hasIntelligenceBar: !!document.querySelector('.intelligence-bar'),
   headline: document.querySelector('.today-overview-head span')?.textContent || null,
   metricsVals: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),
   metricsCalls: window.__audit.metricsCalls.length,
   todayCalls: window.__audit.todayCalls.length,
   viewTransitions: window.__audit.viewTransitions,
   mutations: window.__audit.mutations.slice(-10),
 }));
 console.log("[audit-ui] afterClick 1.5s", JSON.stringify(afterClick,null,2));
 // observe for 35s while running (should cover 5s polls *6)
 console.log("[audit-ui] observing 35s...");
 await delay(35000);
 const late=await page.evaluate(()=>({
   metricsCalls: window.__audit.metricsCalls,
   todayCallsCount: window.__audit.todayCalls.length,
   viewTransitions: window.__audit.viewTransitions,
   reloads: window.__audit.reloads,
   mutations: window.__audit.mutations,
   dashFlashes: window.__audit.dashFlashes,
   overviewSame: window.__audit.overviewSame,
   hasRunningBar: !!document.querySelector('.today-overview-run'),
   vals: [...document.querySelectorAll('.today-metric-value')].map(e=>e.textContent).join('|'),
   computed: (()=>{ const el=document.querySelector('.today-overview'); if(!el) return null; const cs=getComputedStyle(el); return {display:cs.display, opacity:cs.opacity, height:cs.height, transition:cs.transition, animation:cs.animation}; })(),
   overviewRect: document.querySelector('.today-overview')?.getBoundingClientRect()? {w:document.querySelector('.today-overview').getBoundingClientRect().width, h:document.querySelector('.today-overview').getBoundingClientRect().height} : null,
   pagescroll: document.querySelector('.workspace')?.scrollTop,
   harnessTodayCalls: window.__audit.todayCalls.length,
 }));
 console.log("[audit-ui] late", JSON.stringify(late,null,2));
 console.log("[audit-ui] harness console", JSON.stringify(evidence.console.slice(-30),null,2));
 const evidencePath=path.join(REPORT_DIR,"audit-today-ui-evidence.json");
 writeFileSync(evidencePath, JSON.stringify({init, afterClick, late, harnessEvidence:{console:evidence.console.slice(-50), errors:evidence.errors, pageerrors:evidence.pageerrors}}, null,2));
 console.log("[audit-ui] saved",evidencePath);
 await page.screenshot({path:path.join(REPORT_DIR,"audit-today-ui-final.png")});
 // try to cancel via harness? just keep running; close will kill
}catch(e){ console.error(e); throw e; } finally {
 await delay(1000);
 await harnessMod.closeApp(app, {}).catch(()=>{});
 console.log("[audit-ui] closed");
}
