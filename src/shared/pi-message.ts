export type PiMessageSegment =
  | { kind: 'thinking' | 'text'; text: string; streamKey?: string }
  | { kind: 'tool'; text: string; toolName: string; toolCallId?: string; input?: string; output?: string; isError?: boolean };

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function short(value: string, limit = 72): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function piToolSummary(toolName = '', args?: unknown): string {
  const name = toolName || 'tool';
  const values = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = compact(values.command ?? values.cmd);
  const path = compact(values.path ?? values.file_path ?? values.filePath);
  const query = compact(values.query ?? values.pattern ?? values.q);
  let task = '执行任务';
  if (name === 'bash' && command) task = short(command);
  else if (name === 'read') task = path ? `读取 ${short(path)}` : '读取文件';
  else if (name === 'grep' || name === 'find') task = query ? `搜索 ${short(query)}` : '搜索内容';
  else if (name === 'edit' || name === 'write') task = path ? `更新 ${short(path)}` : '整理内容';
  else if (name.includes('search')) task = query ? `搜索 ${short(query)}` : '搜索资料';
  else if (name.includes('workbench')) task = '读取工作台';
  else if (name.includes('save')) task = '保存成果';
  else if (name.includes('read') || name.includes('get') || name.includes('list')) task = '读取资料';
  return `${name} · ${task}`;
}

export function printableToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
