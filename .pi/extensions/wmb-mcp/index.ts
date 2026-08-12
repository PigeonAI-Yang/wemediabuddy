import type { ToolDefinition } from './wmb-mcp-client.ts';
import { coreTools } from './wmb-mcp-tools-core.ts';
import { contentTools } from './wmb-mcp-tools-content.ts';
import { xListTools } from './wmb-mcp-tools-x-lists.ts';
import { xhsTools } from './wmb-mcp-tools-xhs.ts';
import { workspaceTools } from './wmb-mcp-tools-workspaces.ts';
import { intelligenceChannelTools } from './wmb-mcp-tools-intelligence-channels.ts';
import { managerTools } from './wmb-mcp-tools-manager.ts';
import { researchTools } from './wmb-mcp-tools-research.ts';

export default function (pi: { registerTool(tool: ToolDefinition): void }) {
  for (const tool of [...coreTools, ...contentTools, ...xListTools, ...xhsTools, ...workspaceTools, ...intelligenceChannelTools, ...managerTools, ...researchTools]) pi.registerTool(tool);
}
