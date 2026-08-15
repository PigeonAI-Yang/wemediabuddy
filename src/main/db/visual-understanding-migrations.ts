// WMB-5245：图片理解 region 支持（设计 §9 图片理解）。
// 版本 69 唯一属于 ImageUnderstanding；MediaSchema 64-66、Governance 67、Recommendations 68。
//
// - knowledge_visual_runs.region_json：可选归一化矩形区域 `{"x","y","width","height"}`，
//   四值均 ∈ [0,1] 有限数（设计 §9 区域契约，与 shared/media-bindings.ts CropRegion 同校验语义）。
//   NULL = 整图（旧行为不变；存量行全部为整图 run）。
//   区域是 run 的输入属性（理解原图某区域），不是幂等键的一部分——
//   入队键保持 sourceId/sourceRevisionKey/assetId/schemaVersion（设计 §9）。

export const visualUnderstandingMigrations = [
  {
    version: 69,
    sql: `
      ALTER TABLE knowledge_visual_runs ADD COLUMN region_json TEXT;
    `
  }
] as const;
