# WMB-5218 知识飞轮最终集成验收证据

- fixture：single real SQLite workspace (temp, cleaned at end)
- 全部读写经真实 migrations / store / compiler / query-writeback / usage 链 / outcome-feedback / health lint API；断言只读回数据库真实行。

## A. Ingest 编译
- 首次编译：ChangeSet=ed0f1de6-ff90-46c5-b176-e4fd8313ee35 Receipt=c3e0e34b-5bd6-42c2-9187-d98aa590a1dc（trigger=ingest，affectedTopics 恰关联 Topic）
  - Entity 1（agentforge）新建；Claim/Method Note 2；版本 2；locator 证据 2；Topic Wiki 版本 wver-78eefe21c97de96b362232e85e3cccfa（采纳 2 版本）
- 二次摄取（Source r2）：Entity 匹配 1 零重复；新 Claim 1 + 旧 Method qualified（appliesTo=xiaohongshu）+ 旧 Claim contradicted→disputed；版本 3；Wiki 版本 wver-2d79fa6119a0019d92c4df81bc42320c（采纳 5 版本，retainedDisputes=1）
- 争议 Note=note-e2785c9e2328c75ed1f811881bed742b；Method=note-d6f7dc1495737f1bb3da6a7af8e9d85b；新 Claim=note-6af3c881334bf64655eab561ecde2081
- 选题上下文：冻结当前 Wiki 版本=wver-2d79fa6119a0019d92c4df81bc42320c，Note 版本 5，证据 5，上下文包 f93270b4-8e23-407c-97ab-a326ea2a4132

## B. Query 写回
- 冻结读取集：Wiki 版本 wver-2d79fa6119a0019d92c4df81bc42320c + 5 Note 版本 + 5 证据
- 纯复述：decision=skipped_repetition（零知识写），Artifact=30581a09-63cc-42c7-a77f-485548ecdd88，Receipt=qrec-a189c7042a9b9c9055f911bc9715e541
- 同问重放：duplicate=true，同一 Artifact=true（零写）
- 新综合：Note=qnote-f8efb980e29de43880a57b61551da625（insight/inference/mixed），Synthesis Wiki 页=qpage-a492923cef436932eb0ddbac9d9742e9 版本=qwver-be7297811b4922a3414ba177000fb4a7，derived_from 证据 6 只指向冻结集，Receipt=qrec-f984e49736dcd1fa20a34da307d6ae7b
- 知识更新后（Wiki=wver-7703fee7ddd8045267253b2a7cacdc0e）：Synthesis 冻结 Wiki 仍 wver-2d79fa6119a0019d92c4df81bc42320c，Artifact 冻结 Wiki 仍 wver-2d79fa6119a0019d92c4df81bc42320c（不回读未来）
- 用户经验 FreeNote=qfn-d8bc068bd9e87b4deec686b8270bb911（原文不可变，零知识 Note）

## C. 创作 Usage 链
- 全程冻结同一 Wiki 版本 wver-7703fee7ddd8045267253b2a7cacdc0e：提案包=a233a22b-0d57-48a6-8a79-1c72bbdfc081、简报包=f2eba743-2056-4bf6-8805-e25e574f2647（used 1 consulting 采纳集）、核心 V1 包=e15887da-2184-4de9-92eb-4f15a902377b、核心 V2 包=37385cef-ace9-4935-84a8-6bb09f888584、平台包=b25d6362-1ff5-4e11-b96c-3878cc47e11d（used=structure_pattern）
- 平台换基（事实变化）：REQUEST_REPLAY_CONFLICT，拒绝后平台仍指向 b25d3328-b57c-4f20-bc7e-3420aa0a9a49，revision=1；同基修订 revision=2

## D. Publication/Metric/final Review 回流
- 发布=e9e66f07-7b0a-4ee3-a884-82e14fa3472a，指标快照=d4c06f98-5b4c-4ce8-a026-ef5f80259a81，final Review=061c3eb9-bdd6-494a-8415-959127a0a2fa；outcome ChangeSet requestId=outcome:review:061c3eb9-bdd6-494a-8415-959127a0a2fa
- case 观察 Note=of-case-cd8e2e87556afe070892044a68818609 版本=of-case-ver-cd8e2e87556afe070892044a68818609（unverified/outcome_observed，语句含“不证明因果”）；血缘=7 条冻结版本；证据 review+publication+metric_snapshot
- 回执=e4d5e04b-f6be-4912-9455-d163651543ef（trigger=review，affectedTopics 含 Topic）；零因果 Method=true，零 pattern=true
- Topic Wiki 同 ChangeSet 重编译：当前版本=of-wver-f57619796195ffbaa72d60bf963bfe48，recentOutcomes=1（Review 后立即可见）；重放零写=true

## E. Health Lint
- 可信冲突 Issue=health-ba030239195d0edfa8ed0e529f8fe9d9 状态 open（不自动裁决）；重复扫描去重
- broken 证据 Issue=health-c13d0af7b96979b89480d641b7048dce 状态 open（不可变不自动删）
- broken 关系 rel-ghost-e2e 自动原子修复：Issue=health-27c704a64c8ab0cd6d344cf750506f20 resolved，lint 回执=dbdb907e-ccf3-4d41-82b0-8c67cb82d7ac
- stale Wiki Issue=health-3c11542d8545ec8c5e45b96e9c976e38 状态 open
- 周期 Lint：run=lint-1786755293534-24d7cff8 completed=true，扫描 24 对象；崩溃重试零写=true，第二轮零新增=true，取消=true

## F. 并发 / 恢复 / 弱 Source
- 弱 Source=c7c6f02b-2153-47dd-a479-ea39e3e583a9：notesCreated=0，skippedLowValue=1（零 Note 落库，回执=be834b23-6a79-4548-b498-541fba12d54a）
- 并发同基：首成语句=V3A，第二拒绝 REVISION_CONFLICT（零新增版本）
- restore：revision=4 changeType=restored，restoredFromVersionId=87495fa0-2df5-4192-ad07-37592da985ea，版本链 4 全保留

## G. 边界
- 链完整性：orphan adopted=0，orphan evidence=0，orphan receipt=0，orphan note/page current=0/0
- 单 Topic 单 Wiki=true
- data-root 隔离：跨 root 写拒绝=true，data-root B 计数={"changeSets":0,"notes":0,"wikiPages":0}
- Canvas 删除（canvas=836530e1-469c-4747-9bcb-3ed496b06810）：节点删除后正式 Topic/Review/case Note/Wiki 均保留=true
- 不可变版本=true；FreeNote 原文不可变=true
- 生产 dispatcher：command=knowledge_flywheel.change_set_apply，command_receipts=1，ChangeSet=1，回执读回=dispatcher 路径验收，直写被 guard 拒绝=true
