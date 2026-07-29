import type { ToolDefinition } from './wmb-mcp-client.ts';
import { coreTools } from './wmb-mcp-tools-core.ts';
import { contentTools } from './wmb-mcp-tools-content.ts';

export default function (pi: { registerTool(tool: ToolDefinition): void }) {
  for (const tool of [...coreTools, ...contentTools]) pi.registerTool(tool);
}
