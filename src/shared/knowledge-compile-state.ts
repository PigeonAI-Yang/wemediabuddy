// WMB-5233：主题 Wiki 编译三态（诚实空壳语义）共享契约。
// 只读投影派生，不新增 schema/表/DB CHECK；不扩展 HealthIssue 枚举。
// 语义：
// - uncompiled：Topic 尚无任何正式编译（无 active Topic Wiki 页/版本）；
// - legacy_shell：active Wiki 页由历史初始化（migration/derived-from-legacy）创建，
//   当前版本零采纳知识 —— 空壳不得显示为“已编译/当前”；
// - compiled：有正式编译版本（ingest/query/review/creation/lint 等）或已采纳知识版本。
export type KnowledgeCompileState = 'uncompiled' | 'legacy_shell' | 'compiled';
