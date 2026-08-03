import type { PiCommand } from '../main/pi-commands';

export function filterPiCommands(commands: PiCommand[], draft: string): PiCommand[] {
  const query = draft.slice(1).toLocaleLowerCase().trim();
  if (!query) return commands;
  return commands
    .map((command, order) => {
      const name = command.name.toLocaleLowerCase();
      const description = command.description.toLocaleLowerCase();
      const rank = name.startsWith(query) ? 0 : name.includes(query) ? 1 : description.includes(query) ? 2 : -1;
      return { command, order, rank };
    })
    .filter((item) => item.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map((item) => item.command);
}

export function insertPiCommand(command: PiCommand): string {
  return `/${command.name} `;
}
