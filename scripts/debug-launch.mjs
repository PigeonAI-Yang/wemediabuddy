import { launchApp, delay } from "../tests/e2e/harness.mjs";
import { seedWorkflowBase, seedStudioProject, openWriteDb } from "../tests/e2e/seed-workflow.mjs";
async function seed({dataRoot, workspaceId}) {
  await seedWorkflowBase(dataRoot, workspaceId);
  const db = openWriteDb(dataRoot);
  try { seedStudioProject(db, {title: "debug", coreV1: "a", coreV2: "b"}); } finally { db.close(); }
}
const launched = await launchApp({name: "debug-launch", seedFixture: seed, headless: false});
const {app, page, evidence} = launched;
console.log("launched");
page.on("console", m => console.log("console", m.type(), m.text()));
page.on("pageerror", e => console.log("pageerror", e.message));
await delay(8000);
console.log("evidence console", evidence.console.slice(0,20));
console.log("pageerrors", evidence.pageerrors);
console.log("errors", evidence.errors);
try { await page.screenshot({path: "J:/PigeonYang/WeMediaBuddy/.ai/debug.png"}); console.log("screenshot ok"); } catch(e){console.log("screenshot fail", e);}
const content = await page.content().catch(e=>"content error "+e);
console.log(content.slice(0,5000));
await app.close();
console.log("closed");
