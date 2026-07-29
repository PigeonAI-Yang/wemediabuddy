export const relationNames: Record<string, string> = {
  supports: '支持',
  contradicts: '反驳',
  derived_from: '来源于',
  responds_to: '回应需求',
  uses_method: '使用方法',
  becomes_content: '形成内容',
  custom: '自定义'
};

export type CanvasAction =
  | { kind: 'move'; nodeId: string; before: { x: number; y: number }; after: { x: number; y: number } }
  | {
      kind: 'relation';
      id: string;
      before: { fromNodeId: string; toNodeId: string; relationType: string; label: string | null; hidden: boolean };
      after: { fromNodeId: string; toNodeId: string; relationType: string; label: string | null; hidden: boolean };
    };
