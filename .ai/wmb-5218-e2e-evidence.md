# WMB-5218 知识飞轮最终集成验收证据

- fixture：single real SQLite workspace (temp, cleaned at end)
- 全部读写经真实 migrations / store / compiler / query-writeback / usage 链 / outcome-feedback / health lint API；断言只读回数据库真实行。

## A. Ingest 编译
- 首次编译：ChangeSet=57c81547-bb55-4d7f-945b-75a6df3438ef Receipt=490e3526-19b5-441d-85d0-e791e78fac89（trigger=ingest，affectedTopics 恰关联 Topic）
  - Entity 1（agentforge）新建；Claim/Method Note 2；版本 2；locator 证据 2；Topic Wiki 版本 wver-28c07e908ac8c7fe0f2fc9e0a88fee2a（采纳 2 版本）
- 二次摄取（Source r2）：Entity 匹配 1 零重复；新 Claim 1 + 旧 Method qualified（appliesTo=xiaohongshu）+ 旧 Claim contradicted→disputed；版本 3；Wiki 版本 wver-7920168b80c7408e085519e0dac94f1c（采纳 5 版本，retainedDisputes=1）
- 争议 Note=note-e2785c9e2328c75ed1f811881bed742b；Method=note-d6f7dc1495737f1bb3da6a7af8e9d85b；新 Claim=note-6af3c881334bf64655eab561ecde2081
- 选题上下文：冻结当前 Wiki 版本=wver-7920168b80c7408e085519e0dac94f1c，Note 版本 5，证据 5，上下文包 ee7206cb-5de2-4529-a682-e00f4786774e

## B. Query 写回
- 冻结读取集：Wiki 版本 wver-7920168b80c7408e085519e0dac94f1c + 5 Note 版本 + 5 证据
- 纯复述：decision=skipped_repetition（零知识写），Artifact=64ff4547-4388-4a2e-ad20-7eed75895556，Receipt=qrec-a189c7042a9b9c9055f911bc9715e541
- 同问重放：duplicate=true，同一 Artifact=true（零写）
- 新综合：Note=qnote-f8efb980e29de43880a57b61551da625（insight/inference/mixed），Synthesis Wiki 页=qpage-a492923cef436932eb0ddbac9d9742e9 版本=qwver-be7297811b4922a3414ba177000fb4a7，derived_from 证据 6 只指向冻结集，Receipt=qrec-f984e49736dcd1fa20a34da307d6ae7b
- 知识更新后（Wiki=wver-6f49156c6e3e4664e1919598e37220f3）：Synthesis 冻结 Wiki 仍 wver-7920168b80c7408e085519e0dac94f1c，Artifact 冻结 Wiki 仍 wver-7920168b80c7408e085519e0dac94f1c（不回读未来）
- 用户经验 FreeNote=qfn-d8bc068bd9e87b4deec686b8270bb911（原文不可变，零知识 Note）

## C. 创作 Usage 链
- 全程冻结同一 Wiki 版本 wver-6f49156c6e3e4664e1919598e37220f3：提案包=a02aa289-9888-4448-9a6f-a05009f46452、简报包=3b6a071e-7316-4783-be4b-3d00575c664a（used 1 consulting 采纳集）、核心 V1 包=85058790-c39c-4013-90cf-360b7aacb89f、核心 V2 包=ce617cfe-3ce7-401b-ba9e-a631b9ceb996、平台包=545d1a37-4328-4e4a-8d81-028f3c55dcfc（used=structure_pattern）
- 平台换基（事实变化）：REQUEST_REPLAY_CONFLICT，拒绝后平台仍指向 18d49864-2498-4c6b-aa82-4f2c7c829e79，revision=1；同基修订 revision=2

## D. Publication/Metric/final Review 回流
- 发布=52bca6e1-7d3e-49c7-a6e4-8de7f8d55e5e，指标快照=c0565444-3d0d-43d9-887c-f9260f25a46c，final Review=8c6a2cb2-8d75-4724-aafc-4dec149456ef；outcome ChangeSet requestId=outcome:review:8c6a2cb2-8d75-4724-aafc-4dec149456ef
- case 观察 Note=of-case-952ea061acdaf34000e4fca1d477b672 版本=of-case-ver-952ea061acdaf34000e4fca1d477b672（unverified/outcome_observed，语句含“不证明因果”）；血缘=7 条冻结版本；证据 review+publication+metric_snapshot
- 回执=12c20be8-5651-4286-a869-17b28d74d065（trigger=review，affectedTopics 含 Topic）；零因果 Method=true，零 pattern=true
- Topic Wiki 同 ChangeSet 重编译：当前版本=of-wver-b1605122247e7e6d3c44dcb54cae867a，recentOutcomes=1（Review 后立即可见）；重放零写=true

## E. Health Lint
- 可信冲突 Issue=health-ba030239195d0edfa8ed0e529f8fe9d9 状态 open（不自动裁决）；重复扫描去重
- broken 证据 Issue=health-a0ccb4e01463b708b424df72d82373e4 状态 open（不可变不自动删）
- broken 关系 rel-ghost-e2e 自动原子修复：Issue=health-27c704a64c8ab0cd6d344cf750506f20 resolved，lint 回执=6d675094-9a48-4eae-960c-a43b26f04ef9
- stale Wiki Issue=health-3c11542d8545ec8c5e45b96e9c976e38 状态 open
- 周期 Lint：run=lint-1786525042953-09ec95f1 completed=true，扫描 19 对象；崩溃重试零写=true，第二轮零新增=true，取消=true

## F. 并发 / 恢复 / 弱 Source
- 弱 Source=af9915e1-2779-448a-b9b2-a18d3bdd9dd4：notesCreated=0，skippedLowValue=1（零 Note 落库，回执=bd3342c3-e795-40f1-a109-f5879e0a0917）
- 并发同基：首成语句=V3A，第二拒绝 REVISION_CONFLICT（零新增版本）
- restore：revision=4 changeType=restored，restoredFromVersionId=e1bfe6a2-43cc-47b2-b40e-65e711dd6f2a，版本链 4 全保留

## G. 边界
- 链完整性：orphan adopted=0，orphan evidence=0，orphan receipt=0，orphan note/page current=0/0
- 单 Topic 单 Wiki=true
- data-root 隔离：跨 root 写拒绝=true，data-root B 计数={"changeSets":0,"notes":0,"wikiPages":0}
- Canvas 删除（canvas=1c9e348f-a77f-476b-9052-dbf02bc51edb）：节点删除后正式 Topic/Review/case Note/Wiki 均保留=true
- 不可变版本=true；FreeNote 原文不可变=true
- 生产 dispatcher：command=knowledge_flywheel.change_set_apply，command_receipts=1，ChangeSet=1，回执读回=dispatcher 路径验收，直写被 guard 拒绝=true
