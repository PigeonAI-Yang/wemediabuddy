import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '../src/main/data-root.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { startMcp } from '../src/main/mcp.ts';
import { searchSources } from '../src/main/sources.ts';
import { PiRpcSupervisor } from '../src/main/pi-runtime.ts';

const apiKey = process.env.WMB_PI_API_KEY;
const piCli = process.env.WMB_PI_CLI
  ?? path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const piExecutable = process.env.WMB_PI_EXECUTABLE ?? process.execPath;
if (!apiKey) throw new Error('WMB_PI_API_KEY is required.');

const root = await mkdtemp(path.join(os.tmpdir(), 'wmb-pi-spike-'));
const agentDir = path.join(root, 'pi-agent');
await openDataRoot(root);
const initial = migrateDatabase(path.join(root, 'wmb.db'));
initial.close();
await mkdir(agentDir);
await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({
  providers: {
    'wmb-cpa': {
      baseUrl: 'http://localhost:61946/v1',
      api: 'openai-responses',
      apiKey: '$WMB_PI_API_KEY',
      models: [{ id: 'gpt-5.6-sol', reasoning: true, contextWindow: 272000, maxTokens: 16000 }]
    }
  }
}), 'utf8');

const mcp = await startMcp(root);
const events = [];
const pi = new PiRpcSupervisor(piExecutable, [
  piCli, '--mode', 'rpc', '--no-session', '--provider', 'wmb-cpa', '--model', 'gpt-5.6-sol',
  '-e', path.resolve('.pi/extensions/wmb-mcp.ts')
], {
    ...process.env,
    ...(process.env.WMB_PI_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    PI_CODING_AGENT_DIR: agentDir,
    WMB_MCP_URL: mcp.url
  }, (event) => events.push(event));

try {
  await pi.start();
  const prompt = await pi.prompt('Call wmb_save_source exactly once with requestId \"wmb-pi-spike:source\", title \"WMB Pi RPC MCP spike\", originalUrl \"https://pi.dev/docs/latest/rpc\", and summary \"A real Pi RPC process wrote this source through the WMB MCP proxy.\" Then reply briefly.');
  await waitUntil(() => events.some((event) => event.type === 'agent_end'), 60000);
  const database = migrateDatabase(path.join(root, 'wmb.db'));
  const sources = searchSources(database, 'WMB Pi RPC MCP spike');
  database.close();
  if (sources.length !== 1 || sources[0].originalUrl !== 'https://pi.dev/docs/latest/rpc') {
    throw new Error(`Pi MCP readback failed: ${JSON.stringify(sources)}`);
  }
  const abort = await pi.abort();
  console.log(JSON.stringify({
    piVersion: '0.82.1',
    model: 'wmb-cpa/gpt-5.6-sol',
    sourceId: sources[0].id,
    rpcAccepted: prompt.success,
    toolCompleted: events.some((event) => event.type === 'tool_execution_end' && event.toolName === 'wmb_save_source'),
    abortAccepted: abort.success
  }));
} finally {
  await pi.stop();
  await mcp.close();
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Pi RPC.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
