import { useEffect, useState } from 'react';
import sourceIndex from '../../skills/wemedia-intelligence-engine/references/source-index.json';
import { findSourceLogo, type RegisteredSourceLogo } from '../shared/source-logo';
import { brandIconUrl, normalizePlatformId } from './platform-mark';

const logoAssets = import.meta.glob('../../images/source-logos/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;
const registeredSources = sourceIndex.sources as RegisteredSourceLogo[];

function platformIdFromUrl(canonicalUrl: string | null): string | null {
  if (!canonicalUrl) return null;
  try {
    const host = new URL(canonicalUrl).hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'xhslink.com') return 'xiaohongshu';
    if (host === 'mp.weixin.qq.com' || host.endsWith('.weixin.qq.com')) return 'wechat';
    if (host === 'okjike.com' || host.endsWith('.okjike.com')) return 'jike';
    return normalizePlatformId(host.split('.')[0] || null);
  } catch {
    return null;
  }
}

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function SourceMark({ canonicalUrl, aiSourcePresentation, avatarUrl = null }: {
  canonicalUrl: string | null;
  aiSourcePresentation: boolean;
  avatarUrl?: string | null;
}): React.JSX.Element {
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  if (!avatarFailed && isHttpUrl(avatarUrl)) {
    return <span className="source-mark source-mark-avatar" title="作者头像">
      <img src={avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" decoding="async" onError={() => setAvatarFailed(true)}/>
    </span>;
  }

  const registered = aiSourcePresentation ? findSourceLogo(canonicalUrl, registeredSources) : null;
  const registeredLogoUrl = registered ? logoAssets[`../../images/source-logos/${registered.logo}`] : null;
  if (registered && registeredLogoUrl && registered.kind !== 'professional_account') {
      return <span className="source-mark">
        <img src={registeredLogoUrl} alt=""/>
      </span>;
    }

  const platformId = platformIdFromUrl(canonicalUrl);
  const platformLogo = brandIconUrl(platformId);
  if (platformId && platformLogo) {
    return <span className={`source-mark source-mark-platform pf-${platformId}`} title={platformId}>
      <img src={platformLogo} alt=""/>
    </span>;
  }

  return <span className="source-mark source-mark-fallback" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/></svg>
  </span>;
}

/** Compact platform/source identity for metadata rows; never replaces the author avatar. */
export function SourcePlatformMark({ canonicalUrl, aiSourcePresentation }: {
  canonicalUrl: string | null;
  aiSourcePresentation: boolean;
}): React.JSX.Element {
  const platformId = platformIdFromUrl(canonicalUrl);
  const platformLogo = brandIconUrl(platformId);
  if (platformId && platformLogo) {
    return <i className={`platform-mark pf-${platformId} feed-source-platform`} aria-hidden="true">
      <img src={platformLogo} alt="" width={128} height={128} decoding="async"/>
    </i>;
  }

  const registered = aiSourcePresentation ? findSourceLogo(canonicalUrl, registeredSources) : null;
  const registeredLogoUrl = registered ? logoAssets[`../../images/source-logos/${registered.logo}`] : null;
  if (registeredLogoUrl) {
    return <i className="feed-source-platform feed-source-platform-registered" aria-hidden="true">
      <img src={registeredLogoUrl} alt="" decoding="async"/>
    </i>;
  }

  return <i className="feed-source-platform feed-source-platform-fallback" aria-hidden="true">
    <svg viewBox="0 0 16 16"><path d="M5 2.5h6l2 2v9H5z"/><path d="M10.5 2.5v2.5H13M7 8h4M7 10.5h4"/></svg>
  </i>;
}
