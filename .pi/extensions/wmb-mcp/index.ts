import type { ToolDefinition } from './wmb-mcp-client.ts';
import { coreTools } from './wmb-mcp-tools-core.ts';
import { contentTools } from './wmb-mcp-tools-content.ts';
import { xListTools } from './wmb-mcp-tools-x-lists.ts';
import { xhsTools } from './wmb-mcp-tools-xhs.ts';

export default function (pi: { registerTool(tool: ToolDefinition): void }) {
  for (const tool of [...coreTools, ...contentTools, ...xListTools, ...xhsTools]) pi.registerTool(tool);
}
