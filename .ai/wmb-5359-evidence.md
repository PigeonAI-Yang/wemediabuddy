# WMB-5359 验收证据

- 日期：2026-08-28
- 状态：done
- 范围：实体别名消歧、旧证据重激活、跨日 Evidence Pack。

## 可证伪结果

- 强身份正文可将新正式名与已确认旧代号归一，并保留 evidence gap。
- 多 Entity 候选不猜测，返回 `ENTITY_AMBIGUOUS`。
- 同名但 external identity 冲突的强身份候选不会自动合并，而是创建独立 Entity 意图。
- 历史搜索受时间、数量、正文字符数和关系跳数硬上限约束。
- 旧 Source 和触发身份揭晓的 current Source 均冻结 revision；任一陈旧时重激活失败且不写 Topic 关系。
- 旧/新 Source 同时进入 Planner 的 reactivated Evidence Pack；未经核实的“国产算力集群提供 100T”保持 evidence gap。
- 已有正式 Topic 关系走 fast path，不调用路由模型。

## Gate

```text
node --test --test-concurrency=1 \
  tests/wmb-5359-knowledge-reactivation.test.mjs \
  tests/wmb-5358-persistent-knowledge-routing.test.mjs \
  tests/editorial-brief.test.mjs \
  tests/brief-increment-effective-only.test.mjs \
  tests/wmb-5229-knowledge-compile-trigger.test.mjs

34 tests, 34 pass, 0 fail

npm run typecheck
PASS
```

## 审查收口

独立只读审查在 30 分钟内未返回可验收结果，已按项目生命周期规则终止。主 Agent 直接复核并用失败实验关闭了两项真实缺口：external identity 偶合误并与 current Source revision 未冻结。
