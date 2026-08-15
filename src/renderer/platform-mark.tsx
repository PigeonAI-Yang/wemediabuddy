const brandPngAssets = import.meta.glob('../../images/brand-icons/128/*.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const brandMasterAssets = import.meta.glob('../../images/brand-icons/masters/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const platformLogoAssets = import.meta.glob('../../images/platform-logos/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

/** Normalize DB/UI platform labels into canonical brand ids. */
const platformAliases: Record<string, string> = {
  x: 'x',
  X: 'x',
  twitter: 'x',
  Twitter: 'x',
  推特: 'x',
  wechat: 'wechat',
  WeChat: 'wechat',
  微信: 'wechat',
  公众号: 'wechat',
  微信公众号: 'wechat',
  xiaohongshu: 'xiaohongshu',
  小红书: 'xiaohongshu',
  red: 'xiaohongshu',
  RED: 'xiaohongshu',
  zhihu: 'zhihu',
  知乎: 'zhihu',
  jike: 'jike',
  即刻: 'jike'
};

function assetByFileName(assets: Record<string, string>, fileName: string): string | null {
  if (assets[fileName]) return assets[fileName];
  const hit = Object.entries(assets).find(([key]) => {
    const normalized = key.replaceAll('\\', '/');
    return normalized.slice(normalized.lastIndexOf('/') + 1) === fileName;
  });
  return hit?.[1] ?? null;
}

export function normalizePlatformId(platform?: string | null): string | null {
  if (!platform) return null;
  const raw = String(platform).trim();
  if (!raw) return null;
  return platformAliases[raw] ?? platformAliases[raw.toLowerCase()] ?? raw.toLowerCase();
}

export function brandIconUrl(brandId?: string | null): string | null {
  if (!brandId) return null;
  const id = normalizePlatformId(brandId) ?? brandId;
  return assetByFileName(brandPngAssets, `${id}.png`)
    ?? assetByFileName(brandMasterAssets, `${id}.svg`)
    ?? assetByFileName(platformLogoAssets, `${id}.svg`)
    ?? null;
}

export function platformLogoUrl(platform?: string | null): string | null {
  return brandIconUrl(normalizePlatformId(platform) ?? platform);
}

export function PlatformMark({ platform, className = '' }: { platform?: string | null; className?: string }): React.JSX.Element {
  const id = normalizePlatformId(platform) ?? 'unknown';
  const logoUrl = brandIconUrl(id);
  return <i className={`platform-mark pf-${id}${className ? ` ${className}` : ''}`} aria-hidden="true" title={platform || id}>
    {logoUrl
      ? <img src={logoUrl} alt="" width={128} height={128} decoding="async"/>
      : <span className="platform-mark-fallback">·</span>}
  </i>;
}

export function BrandMark({ brandId, className = '' }: { brandId?: string | null; className?: string }): React.JSX.Element {
  const id = normalizePlatformId(brandId) ?? (brandId || 'unknown');
  const logoUrl = brandIconUrl(id);
  return <i className={`platform-mark brand-mark brand-${id}${className ? ` ${className}` : ''}`} aria-hidden="true">
    {logoUrl
      ? <img src={logoUrl} alt="" width={128} height={128} decoding="async"/>
      : <span className="platform-mark-fallback">·</span>}
  </i>;
}
