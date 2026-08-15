// WMB-5243：知识浮卡 —— 单击节点在节点附近打开，空白点击关闭；不占固定侧栏。
// 卡片第一屏只回答"这项知识是什么"：完整认识 → 适用范围 → 证据边界 → 依据摘要 →
// 相关认识 → 最近更新时间。对象 ID/表名/ChangeSet/Receipt/编译状态/版本号不进第一屏。
import type {
  KnowledgeNetworkNode,
  KnowledgeNetworkNodeDetail,
} from '../shared/knowledge-network';
import { KNOWLEDGE_NETWORK_NODE_TYPE_LABELS } from '../shared/knowledge-network';
import {
  evidenceBoundaryChips,
  relativeTime,
  relationKeyLabel,
  sourceNatureLabel,
} from './knowledge-network-format';

export type KnowledgeCardAnchor = { left: number; top: number };

export function KnowledgeNetworkCard({
  node,
  detail,
  detailError,
  anchor,
  jumpLabel,
  onJump,
  onClose,
  onOpenRelated,
  notice,
}: {
  node: KnowledgeNetworkNode | null;
  detail: KnowledgeNetworkNodeDetail | null;
  detailError: boolean;
  anchor: KnowledgeCardAnchor;
  jumpLabel: string | null;
  onJump: () => void;
  onClose: () => void;
  onOpenRelated: (nodeId: string) => void;
  /** 可观察反馈（note/entity 无正式页面降级；空白/Esc 关闭卡片即消失）。 */
  notice: string | null;
}) {
  const knowledge = detail?.knowledge ?? null;
  const primaryLabel =
    node?.objectType === 'topic'
      ? '主题当前综合'
      : node?.objectType === 'knowledge_entity'
        ? '实体核心说明'
        : '完整认识';
  const evidenceEntries = knowledge?.evidenceSummary ?? [];
  const related = knowledge?.related ?? [];
  const boundaryChips = knowledge
    ? evidenceBoundaryChips(knowledge.evidenceBoundary)
    : [];
  return (
    <article
      className="kn-knowledge-card kc-knowledge-card"
      data-kc-knowledge-card
      data-kc-card-node-id={node?.id ?? ''}
      aria-label={`${node?.shortTitle ?? ''} 知识详情`}
      style={{ left: anchor.left, top: anchor.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header className="kc-card-head">
        <div>
          <small>{node ? KNOWLEDGE_NETWORK_NODE_TYPE_LABELS[node.objectType] : ''}</small>
          <strong>{node?.shortTitle ?? ''}</strong>
        </div>
        <button
          type="button"
          data-kc-card-close
          aria-label="关闭知识卡片"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {notice && (
        <p className="kc-card-notice" data-kc-card-notice role="status">
          {notice}
        </p>
      )}
      {!detail && !detailError && <p className="kc-panel-empty">正在读取知识正文…</p>}
      {detailError && <p className="kc-panel-empty">详情读取失败，以下为投影摘要。</p>}
      {detail && (
        <div className="kc-card-body">
          <section data-kc-card-primary>
            <span>{primaryLabel}</span>
            <p>{knowledge?.primary || node?.summary || '暂无正式认识'}</p>
          </section>
          <section data-kc-card-scope>
            <span>适用范围</span>
            <p>{knowledge?.scope || '暂无适用范围说明'}</p>
          </section>
          <section data-kc-card-evidence-boundary>
            <span>证据边界</span>
            {boundaryChips.length > 0 ? (
              <div>
                {boundaryChips.map((chip) => (
                  <span key={chip} className="kn-chip-token">
                    {chip}
                  </span>
                ))}
              </div>
            ) : (
              <p>暂无依据</p>
            )}
          </section>
          <section data-kc-card-evidence>
            <span>依据摘要</span>
            {evidenceEntries.length > 0 ? (
              <ul className="kc-evidence-list">
                {evidenceEntries.map((entry, index) => (
                  <li key={index}>
                    <span className="kc-evidence-meta">
                      {relationKeyLabel(entry.relation)} ·{' '}
                      {sourceNatureLabel(entry.sourceNature)}
                    </span>
                    {entry.excerpt ? <p>{entry.excerpt}</p> : null}
                    {entry.sourceTitle || entry.locator ? (
                      <small>
                        {entry.sourceTitle ?? ''}
                        {entry.sourceTitle && entry.locator ? ' · ' : ''}
                        {entry.locator ?? ''}
                      </small>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kc-panel-empty">暂无依据摘要（正式知识尚未沉淀证据）。</p>
            )}
          </section>
          {related.length > 0 && (
            <section data-kc-card-related>
              <span>相关认识</span>
              <div className="kc-card-related">
                {related.map((entry) => (
                  <button
                    key={entry.nodeId}
                    type="button"
                    className="kc-card-related-item"
                    onClick={() => onOpenRelated(entry.nodeId)}
                  >
                    <i>
                      {entry.objectType === 'topic'
                        ? '题'
                        : entry.objectType === 'knowledge_entity'
                          ? '体'
                          : '识'}
                    </i>
                    <span>{entry.title}</span>
                    <em>{relationKeyLabel(entry.relationKey)}</em>
                  </button>
                ))}
              </div>
            </section>
          )}
          <footer data-kc-card-updated>
            <span>最近更新</span>
            <p>{relativeTime(knowledge?.updatedAt ?? node?.updatedAt ?? null)}</p>
          </footer>
        </div>
      )}
      {jumpLabel && (
        <button
          type="button"
          className="kc-card-jump"
          data-kc-card-jump
          onClick={onJump}
        >
          {jumpLabel}
        </button>
      )}
    </article>
  );
}
