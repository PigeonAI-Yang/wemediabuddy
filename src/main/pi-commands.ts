export type PiCommandSource = 'extension' | 'prompt' | 'skill';

export type PiCommand = {
  name: string;
  description: string;
  source: PiCommandSource;
};

export function readPiCommands(response: unknown): PiCommand[] {
  if (!response || typeof response !== 'object') return [];
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return [];
  const commands = (data as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  const allowed = new Set<PiCommandSource>(['extension', 'prompt', 'skill']);
  return commands.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const command = item as { name?: unknown; description?: unknown; source?: unknown };
    const name = typeof command.name === 'string' ? command.name.trim() : '';
    if (!name || !allowed.has(command.source as PiCommandSource)) return [];
    return [{
      name,
      description: typeof command.description === 'string' ? command.description.trim() : '',
      source: command.source as PiCommandSource
    }];
  });
}
