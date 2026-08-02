import sourceIndex from '../../skills/wemedia-intelligence-engine/references/source-index.json';
import { findSourceLogo, type RegisteredSourceLogo } from '../shared/source-logo';

const logoAssets = import.meta.glob('../../images/source-logos/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;
const registeredSources = sourceIndex.sources as RegisteredSourceLogo[];

export function SourceMark({ canonicalUrl, aiSourcePresentation }: { canonicalUrl: string | null; aiSourcePresentation: boolean }): React.JSX.Element {
  const source = aiSourcePresentation ? findSourceLogo(canonicalUrl, registeredSources) : null;
  const logoUrl = source ? logoAssets[`../../images/source-logos/${source.logo}`] : null;
  if (!source || !logoUrl) {
    return <span className="source-mark source-mark-fallback" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 11h6M9 15h6"/></svg>
    </span>;
  }
  return <span className={`source-mark${source.kind === 'professional_account' ? ' source-mark-profile' : ''}`}>
    <img src={logoUrl} alt=""/>
  </span>;
}
