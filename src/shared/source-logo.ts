export type RegisteredSourceLogo = {
  url: string;
  logo: string;
  kind: string;
  enabled?: boolean;
};

export function findSourceLogo(
  canonicalUrl: string | null,
  sources: RegisteredSourceLogo[]
): RegisteredSourceLogo | null {
  if (!canonicalUrl) return null;
  let item: URL;
  try {
    item = new URL(canonicalUrl);
  } catch {
    return null;
  }

  const candidates = sources
    .filter((source) => source.enabled !== false)
    .map((source) => ({ source, url: new URL(source.url) }))
    .filter(({ url }) => url.hostname === item.hostname);
  const exact = candidates
    .filter(({ url }) => pathContains(url.pathname, item.pathname))
    .sort((left, right) => right.url.pathname.length - left.url.pathname.length)[0]?.source;
  if (exact) return exact;

  const logos = new Set(candidates.map(({ source }) => source.logo));
  return logos.size === 1 ? candidates[0]?.source ?? null : null;
}

function pathContains(parent: string, child: string): boolean {
  if (parent === '/') return false;
  const normalized = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(normalized);
}
