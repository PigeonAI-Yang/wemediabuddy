# WMB-5218 知识飞轮最终集成验收证据

- fixture：single real SQLite workspace (temp, cleaned at end)
- 全部读写经真实 migrations / store / compiler / query-writeback / usage 链 / outcome-feedback / health lint API；断言只读回数据库真实行。

## A. Ingest 编译
- 首次编译：ChangeSet=891c7181-f249-463b-89ae-82a9871faf39 Receipt=ab9aca69-89de-4e38-b0bf-47f097f1199b（trigger=ingest，affectedTopics 恰关联 Topic）
  - Entity 1（agentforge）新建；Claim/Method Note 2；版本 2；locator 证据 2；Topic Wiki 版本 wver-6fe07302adbbfef6c80787a9705682e8（采纳 2 版本）
- 二次摄取（Source r2）：Entity 匹配 1 零重复；新 Claim 1 + 旧 Method qualified（appliesTo=xiaohongshu）+ 旧 Claim contradicted→disputed；版本 3；Wiki 版本 wver-c843ff4dbf588440be7f991cc9f117b5（采纳 5 版本，retainedDisputes=1）
- 争议 Note=note-e2785c9e2328c75ed1f811881bed742b；Method=note-d6f7dc1495737f1bb3da6a7af8e9d85b；新 Claim=note-6af3c881334bf64655eab561ecde2081
- 选题上下文：冻结当前 Wiki 版本=wver-c843ff4dbf588440be7f991cc9f117b5，Note 版本 5，证据 5，上下文包 73097107-73aa-4ec2-a760-1f906da171a9

## B. Query 写回
- 冻结读取集：Wiki 版本 wver-c843ff4dbf588440be7f991cc9f117b5 + 5 Note 版本 + 5 证据
- 纯复述：decision=skipped_repetition（零知识写），Artifact=4ad43f63-ed4d-4d07-ae8b-c7c78ce675f5，Receipt=qrec-a189c7042a9b9c9055f911bc9715e541
- 同问重放：duplicate=true，同一 Artifact=true（零写）
- 新综合：Note=qnote-f8efb980e29de43880a57b61551da625（insight/inference/mixed），Synthesis Wiki 页=qpage-a492923cef436932eb0ddbac9d9742e9 版本=qwver-be7297811b4922a3414ba177000fb4a7，derived_from 证据 6 只指向冻结集，Receipt=qrec-f984e49736dcd1fa20a34da307d6ae7b
- 知识更新后（Wiki=wver-fc3964a64545d4f35190f2dbb87c626a）：Synthesis 冻结 Wiki 仍 wver-c843ff4dbf588440be7f991cc9f117b5，Artifact 冻结 Wiki 仍 wver-c843ff4dbf588440be7f991cc9f117b5（不回读未来）
- 用户经验 FreeNote=qfn-d8bc068bd9e87b4deec686b8270bb911（原文不可变，零知识 Note）

## C. 创作 Usage 链
- 全程冻结同一 Wiki 版本 wver-fc3964a64545d4f35190f2dbb87c626a：提案包=86a9cf96-11ee-4ccc-ba37-8f113260395a、简报包=3acbcf69-958f-463a-aad6-7ce4995b33ec（used 1 consulting 采纳集）、核心 V1 包=7bc7324b-5095-49e9-b243-1a3c926a5aaf、核心 V2 包=88829583-fa3d-4ea7-b720-d114dad26a2f、平台包=f080f98a-86ab-4090-aaab-d2712bb3eea2（used=structure_pattern）
- 平台换基（事实变化）：REQUEST_REPLAY_CONFLICT，拒绝后平台仍指向 9eb19c85-f84a-4287-a8dc-da83ba9f867a，revision=1；同基修订 revision=2

## D. Publication/Metric/final Review 回流
- 发布=c64d9258-4697-4eb2-ae1d-d15f941977b2，指标快照=31e9038a-a2b4-467e-8d05-47ea3b3803cd，final Review=d397cefc-4715-42f4-ac3a-f27bbedb9b3f；outcome ChangeSet requestId=outcome:review:d397cefc-4715-42f4-ac3a-f27bbedb9b3f
- case 观察 Note=of-case-2dd6ee1f874fa999e87ef621d49adaf3 版本=of-case-ver-2dd6ee1f874fa999e87ef621d49adaf3（unverified/outcome_observed，语句含“不证明因果”）；血缘=7 条冻结版本；证据 review+publication+metric_snapshot
- 回执=54ad9638-def1-4bca-bfb4-a83eaffbe5c8（trigger=review，affectedTopics 含 Topic）；零因果 Method=true，零 pattern=true
- Topic Wiki 同 ChangeSet 重编译：当前版本=of-wver-239977235d4ff56505b1b4296f0fc51e，recentOutcomes=1（Review 后立即可见）；重放零写=true

## E. Health Lint
- 可信冲突 Issue=health-ba030239195d0edfa8ed0e529f8fe9d9 状态 open（不自动裁决）；重复扫描去重
- broken 证据 Issue=health-b0c9bfd07e7a6c35110de895eb654b9d 状态 open（不可变不自动删）
- broken 关系 rel-ghost-e2e 自动原子修复：Issue=health-27c704a64c8ab0cd6d344cf750506f20 resolved，lint 回执=d8f8fd33-3efd-4ed6-b8b2-98f67462f464
- stale Wiki Issue=health-3c11542d8545ec8c5e45b96e9c976e38 状态 open
- 周期 Lint：run=lint-1786580578468-9e2199a0 completed=true，扫描 19 对象；崩溃重试零写=true，第二轮零新增=true，取消=true

## F. 并发 / 恢复 / 弱 Source
- 弱 Source=f48eb46a-a369-403b-aee2-7fa7efc67cbf：notesCreated=0，skippedLowValue=1（零 Note 落库，回执=cd40aa7a-84fd-4d37-9986-38a554fbec62）
- 并发同基：首成语句=V3A，第二拒绝 REVISION_CONFLICT（零新增版本）
- restore：revision=4 changeType=restored，restoredFromVersionId=b8fd5105-dc7d-4fbf-89ce-a65ec1b761a4，版本链 4 全保留

## G. 边界
- 链完整性：orphan adopted=0，orphan evidence=0，orphan receipt=0，orphan note/page current=0/0
- 单 Topic 单 Wiki=true
- data-root 隔离：跨 root 写拒绝=true，data-root B 计数={"changeSets":0,"notes":0,"wikiPages":0}
- Canvas 删除（canvas=a1c11b2b-0e16-48bf-8a5a-7fa6e8f86357）：节点删除后正式 Topic/Review/case Note/Wiki 均保留=true
- 不可变版本=true；FreeNote 原文不可变=true
- 生产 dispatcher：command=knowledge_flywheel.change_set_apply，command_receipts=1，ChangeSet=1，回执读回=dispatcher 路径验收，直写被 guard 拒绝=true
