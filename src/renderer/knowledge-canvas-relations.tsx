import { relationNames } from './knowledge-canvas-types';

export function CanvasRelations({ canvas, selectedRelation, setSelectedRelation, setPendingRelation, projectionMode }: {
  canvas: any;
  selectedRelation: any;
  setSelectedRelation: (value: any) => void;
  setPendingRelation: (value: any) => void;
  projectionMode?: 'relation' | 'change' | 'health';
}) {
  return (canvas?.relations ?? []).map((relation: any) => {
    const from = canvas.nodes.find((node: any) => node.id === relation.fromNodeId);
    const to = canvas.nodes.find((node: any) => node.id === relation.toNodeId);
    if (!from || !to || relation.hidden) return null;
    const zoom = canvas.zoom ?? 1;
    const x1 = (from.x + from.width / 2) * zoom;
    const y1 = (from.y + from.height / 2) * zoom;
    const x2 = (to.x + to.width / 2) * zoom;
    const y2 = (to.y + to.height / 2) * zoom;
    // 变化模式：两端都被本次 ChangeSet 影响的边做相邻强调（关系本身不是正式知识）。
    const adjacent =
      projectionMode === 'change' &&
      Array.isArray(from.changes) &&
      from.changes.length > 0 &&
      Array.isArray(to.changes) &&
      to.changes.length > 0;
    return (
      <g
        key={relation.id}
        className={`${selectedRelation?.id === relation.id ? 'selected' : ''}${adjacent ? ' changed-adjacent' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          setSelectedRelation(relation);
          setPendingRelation(null);
        }}
      >
        <line className="kc-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
        <line className="kc-edge-visible" markerEnd="url(#kc-arrow)" x1={x1} y1={y1} x2={x2} y2={y2} />
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 7}>
          {relation.label || relationNames[relation.relationType]}
        </text>
      </g>
    );
  });
}
