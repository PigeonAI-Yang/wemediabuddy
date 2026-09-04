# WMB-5218 知识飞轮最终集成验收证据

- fixture：single real SQLite workspace (temp, cleaned at end)
- 全部读写经真实 migrations / store / compiler / query-writeback / usage 链 / outcome-feedback / health lint API；断言只读回数据库真实行。

## A. Ingest 编译
- 首次编译：ChangeSet=b690988e-d1ff-420d-b617-6b8ad62ebf48 Receipt=1dd73393-cc40-4212-a7a8-d9d6cef2a743（trigger=ingest，affectedTopics 恰关联 Topic）
  - Entity 1（agentforge）新建；Claim/Method Note 2；版本 2；locator 证据 2；Topic Wiki 版本 wver-222a7722b83a913d7dd0c092052a59a9（采纳 2 版本）
- 二次摄取（Source r2）：Entity 匹配 1 零重复；新 Claim 1 + 旧 Method qualified（appliesTo=xiaohongshu）+ 旧 Claim contradicted→disputed；版本 3；Wiki 版本 wver-cb48f2671264f2f6c5882a1e50b71b39（采纳 5 版本，retainedDisputes=1）
- 争议 Note=note-e2785c9e2328c75ed1f811881bed742b；Method=note-d6f7dc1495737f1bb3da6a7af8e9d85b；新 Claim=note-6af3c881334bf64655eab561ecde2081
- 选题上下文：冻结当前 Wiki 版本=wver-cb48f2671264f2f6c5882a1e50b71b39，Note 版本 5，证据 5，上下文包 9a489f1c-5122-41ac-ab33-867c769c4861

## B. Query 写回
- 冻结读取集：Wiki 版本 wver-cb48f2671264f2f6c5882a1e50b71b39 + 5 Note 版本 + 5 证据
- 纯复述：decision=skipped_repetition（零知识写），Artifact=c1f58edc-61f4-4f6d-b11d-a7e0d0319e33，Receipt=qrec-a189c7042a9b9c9055f911bc9715e541
- 同问重放：duplicate=true，同一 Artifact=true（零写）
- 新综合：Note=qnote-f8efb980e29de43880a57b61551da625（insight/inference/mixed），Synthesis Wiki 页=qpage-a492923cef436932eb0ddbac9d9742e9 版本=qwver-be7297811b4922a3414ba177000fb4a7，derived_from 证据 6 只指向冻结集，Receipt=qrec-f984e49736dcd1fa20a34da307d6ae7b
- 知识更新后（Wiki=wver-d8da35562195daeec72a30254651d42b）：Synthesis 冻结 Wiki 仍 wver-cb48f2671264f2f6c5882a1e50b71b39，Artifact 冻结 Wiki 仍 wver-cb48f2671264f2f6c5882a1e50b71b39（不回读未来）
- 用户经验 FreeNote=qfn-d8bc068bd9e87b4deec686b8270bb911（原文不可变，零知识 Note）

## C. 创作 Usage 链
- 全程冻结同一 Wiki 版本 wver-d8da35562195daeec72a30254651d42b：提案包=99a5dbea-eedb-468f-8fdb-1efdc2d52a46、简报包=c9404bc7-7bb3-409e-a051-b2fd5b53d3a6（used 1 consulting 采纳集）、核心 V1 包=9c5c62e3-e3f7-41ac-b531-888b8d12209d、核心 V2 包=7e958dc4-068a-4a0c-83af-7381d7ab1864、平台包=02968925-db6a-44b2-9ba8-cfbf9f51502b（used=structure_pattern）
- 平台换基（事实变化）：REQUEST_REPLAY_CONFLICT，拒绝后平台仍指向 b8dda97f-3776-4fd4-8801-39e1b543277f，revision=1；同基修订 revision=2

## D. Publication/Metric/final Review 回流
- 发布=a94e11d2-ce30-4e2e-918a-e69c466656fb，指标快照=76c3a429-8948-45f2-bfbc-e97788e83859，final Review=4f1ca875-0203-4fbb-bc6e-a14bf7f1452c；outcome ChangeSet requestId=outcome:review:4f1ca875-0203-4fbb-bc6e-a14bf7f1452c
- case 观察 Note=of-case-92eaf52d433fdc2cecd9662b93b559a6 版本=of-case-ver-92eaf52d433fdc2cecd9662b93b559a6（unverified/outcome_observed，语句含“不证明因果”）；血缘=7 条冻结版本；证据 review+publication+metric_snapshot
- 回执=5264b9a6-c2d1-4d78-a073-6f5ffdd38102（trigger=review，affectedTopics 含 Topic）；零因果 Method=true，零 pattern=true
- Topic Wiki 同 ChangeSet 重编译：当前版本=of-wver-941417ccd4411ba86c31795134c61e52，recentOutcomes=1（Review 后立即可见）；重放零写=true

## E. Health Lint
- 可信冲突 Issue=health-ba030239195d0edfa8ed0e529f8fe9d9 状态 open（不自动裁决）；重复扫描去重
- broken 证据 Issue=health-6fac08bcd67f0895673f581bbe215540 状态 open（不可变不自动删）
- broken 关系 rel-ghost-e2e 自动原子修复：Issue=health-27c704a64c8ab0cd6d344cf750506f20 resolved，lint 回执=b27c8008-1a4f-4fe5-a224-15ef89ad4332
- stale Wiki Issue=health-3c11542d8545ec8c5e45b96e9c976e38 状态 open
- 周期 Lint：run=lint-1788525206897-701ec66b completed=true，扫描 24 对象；崩溃重试零写=true，第二轮零新增=true，取消=true

## F. 并发 / 恢复 / 弱 Source
- 弱 Source=bfa0e5d9-abf5-4e9f-bded-84b5269c1aa9：notesCreated=0，skippedLowValue=1（零 Note 落库，回执=dd376193-31a7-4d06-9707-cb593d3b4eb9）
- 并发同基：首成语句=V3A，第二拒绝 REVISION_CONFLICT（零新增版本）
- restore：revision=4 changeType=restored，restoredFromVersionId=2ea8b509-57ad-48c2-b4cf-651321bf817c，版本链 4 全保留

## G. 边界
- 链完整性：orphan adopted=0，orphan evidence=0，orphan receipt=0，orphan note/page current=0/0
- 单 Topic 单 Wiki=true
- data-root 隔离：跨 root 写拒绝=true，data-root B 计数={"changeSets":0,"notes":0,"wikiPages":0}
- Canvas 删除（canvas=3713720c-eb22-4310-9714-96e254a0f7eb）：节点删除后正式 Topic/Review/case Note/Wiki 均保留=true
- 不可变版本=true；FreeNote 原文不可变=true
- 生产 dispatcher：command=knowledge_flywheel.change_set_apply，command_receipts=1，ChangeSet=1，回执读回=dispatcher 路径验收，直写被 guard 拒绝=true
