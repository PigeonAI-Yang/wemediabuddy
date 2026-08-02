export const pyaireaderXProfileId = 'edge:pyaireader-default';
export const pyaireaderXEndpoint = 'http://127.0.0.1:9334';
export const pyaireaderWorkspaceProfilePrefix = 'edge:pyaireader-workspace-';

export type XListBrowserConfig = { id: string; cdpUrl?: string; workspaceId?: string; accountKey?: string };

export function isPyaireaderXProfile(config: XListBrowserConfig): boolean {
  if (config.id === pyaireaderXProfileId) return normalizeEndpoint(config.cdpUrl) === pyaireaderXEndpoint;
  if (!config.id.startsWith(pyaireaderWorkspaceProfilePrefix)) return false;
  if (!config.cdpUrl) return true;
  try {
    const url = new URL(config.cdpUrl);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number.isInteger(Number(url.port)) && Number(url.port) > 0;
  } catch { return false; }
}

export function isXHomeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^(?:www\.)?x\.com$/i.test(url.hostname) && url.pathname.replace(/\/$/, '') === '/home';
  } catch { return false; }
}

export function parseXListId(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^(?:www\.)?x\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/i\/lists\/(\d+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch { return null; }
}

export function xListUrl(listId: string): string {
  if (!/^\d+$/.test(listId)) throw new Error('X List ID 必须是数字。');
  return `https://x.com/i/lists/${listId}`;
}

export function cubicBezier(start: { x: number; y: number }, controlA: { x: number; y: number }, controlB: { x: number; y: number }, end: { x: number; y: number }, t: number): { x: number; y: number } {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * controlA.x + 3 * inverse * t ** 2 * controlB.x + t ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * controlA.y + 3 * inverse * t ** 2 * controlB.y + t ** 3 * end.y
  };
}

function normalizeEndpoint(value: string | undefined): string {
  return (value ?? '').replace(/\/$/, '');
}
