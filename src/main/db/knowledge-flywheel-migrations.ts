/**
 * WMB-5210 M1：知识飞轮核心存储（对象/版本契约 schema）。
 * Design: docs/spark/2026-08-12-wmb-knowledge-object-version-contract-design.md
 * 要点：SQLite 单一真源；不可变版本/证据/批注原文；原子 ChangeSet；requestId 幂等；
 * 无 AI 硬删除（DELETE 一律 RAISE）；scope = 'global' | 'lane:<key>'（格式由 CHECK 强制，
 * lane 注册校验在 store 层复用既有赛道身份）；当前对象只移动 current_version_id 并递增 revision。
 */
export const knowledgeFlywheelMigrations = [
  {
    version: 56,
    sql: `
      -- ===== ChangeSet：一次可解释知识变化的原子事务边界 =====
      CREATE TABLE knowledge_change_sets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('ingest','query','lint','creation','review','user','migration')),
        resolution_mode TEXT NOT NULL CHECK (resolution_mode IN ('replaced_current','time_bounded','scope_split','kept_disputed','insufficient','manual_correction','none')),
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, request_id)
      );
      CREATE INDEX knowledge_change_sets_created ON knowledge_change_sets(created_at DESC);
      CREATE TRIGGER knowledge_change_sets_immutable_update
        BEFORE UPDATE ON knowledge_change_sets
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_CHANGE_SET_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_change_sets_immutable_delete
        BEFORE DELETE ON knowledge_change_sets
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_CHANGE_SET_IMMUTABLE'); END;

      -- ===== FreeNote：原始记录（原文不可修改，处理状态可随 revision 变化） =====
      CREATE TABLE knowledge_free_notes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        source_nature TEXT NOT NULL CHECK (source_nature IN ('user_quick_note','page_note','pi_dialogue','user_approval_reason','observation','system_capture')),
        body TEXT NOT NULL,
        processing_state TEXT NOT NULL CHECK (processing_state IN ('captured','processed','partially_processed','ignored','archived')),
        processing_reason TEXT NOT NULL DEFAULT '',
        workspace_lane TEXT,
        page_ref TEXT,
        session_ref TEXT,
        task_ref TEXT,
        linked_object_type TEXT,
        linked_object_id TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE INDEX knowledge_free_notes_state ON knowledge_free_notes(scope, processing_state, created_at DESC);
      CREATE TRIGGER knowledge_free_notes_text_immutable
        BEFORE UPDATE ON knowledge_free_notes
        FOR EACH ROW
        WHEN OLD.body IS NOT NEW.body OR OLD.source_nature IS NOT NEW.source_nature
          OR OLD.workspace_lane IS NOT NEW.workspace_lane OR OLD.page_ref IS NOT NEW.page_ref
          OR OLD.session_ref IS NOT NEW.session_ref OR OLD.task_ref IS NOT NEW.task_ref
          OR OLD.linked_object_type IS NOT NEW.linked_object_type OR OLD.linked_object_id IS NOT NEW.linked_object_id
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_FREE_NOTE_TEXT_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_free_notes_delete_immutable
        BEFORE DELETE ON knowledge_free_notes
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_OBJECT_DELETE_FORBIDDEN'); END;

      -- ===== KnowledgeEntity：稳定实体身份（合并/替代保留历史） =====
      CREATE TABLE knowledge_entities (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person','organization','product','platform','policy','institution','place','publication_channel','other')),
        canonical_key TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        external_identity_json TEXT NOT NULL DEFAULT '{}',
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived','superseded','merged','rejected')),
        merged_into_entity_id TEXT REFERENCES knowledge_entities(id),
        superseded_by_entity_id TEXT REFERENCES knowledge_entities(id),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (scope, canonical_key),
        CHECK (lifecycle != 'merged' OR merged_into_entity_id IS NOT NULL),
        CHECK (lifecycle != 'superseded' OR superseded_by_entity_id IS NOT NULL)
      );
      CREATE INDEX knowledge_entities_scope_type ON knowledge_entities(scope, entity_type, lifecycle);
      CREATE INDEX knowledge_entities_lifecycle ON knowledge_entities(lifecycle, updated_at DESC);
      CREATE TRIGGER knowledge_entities_delete_immutable
        BEFORE DELETE ON knowledge_entities
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_OBJECT_DELETE_FORBIDDEN'); END;

      -- ===== KnowledgeNote：原子知识身份（当前对象；kind 创建后不变） =====
      CREATE TABLE knowledge_notes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        kind TEXT NOT NULL CHECK (kind IN ('claim','insight','concept','case','method','question','creative_pattern')),
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived','superseded','merged','rejected')),
        merged_into_note_id TEXT REFERENCES knowledge_notes(id),
        superseded_by_note_id TEXT REFERENCES knowledge_notes(id),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (scope, canonical_key),
        CHECK (lifecycle != 'merged' OR merged_into_note_id IS NOT NULL),
        CHECK (lifecycle != 'superseded' OR superseded_by_note_id IS NOT NULL)
      );
      CREATE INDEX knowledge_notes_scope_kind ON knowledge_notes(scope, kind, lifecycle);
      CREATE INDEX knowledge_notes_lifecycle ON knowledge_notes(lifecycle, updated_at DESC);
      CREATE TRIGGER knowledge_notes_delete_immutable
        BEFORE DELETE ON knowledge_notes
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_OBJECT_DELETE_FORBIDDEN'); END;

      -- ===== KnowledgeNoteVersion：不可变认识版本 =====
      CREATE TABLE knowledge_note_versions (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES knowledge_notes(id),
        version_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        statement TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        conclusion_status TEXT NOT NULL CHECK (conclusion_status IN ('unverified','supported','disputed','contradicted','superseded','not_applicable','inference')),
        evidence_level TEXT NOT NULL CHECK (evidence_level IN ('none','single','corroborated','primary','outcome_observed','mixed','insufficient')),
        applies_to TEXT NOT NULL DEFAULT '',
        valid_from TEXT,
        valid_until TEXT,
        adopted_entity_ids_json TEXT NOT NULL DEFAULT '[]',
        adopted_topic_ids_json TEXT NOT NULL DEFAULT '[]',
        adopted_knowledge_version_ids_json TEXT NOT NULL DEFAULT '[]',
        change_type TEXT NOT NULL CHECK (change_type IN ('created','strengthened','weakened','contradicted','qualified','superseded','merged','promoted','archived','rejected','restored','recompiled')),
        change_reason TEXT NOT NULL DEFAULT '',
        creator_nature TEXT NOT NULL CHECK (creator_nature IN ('user','pi','background_agent','system','migration')),
        change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        restored_from_version_id TEXT REFERENCES knowledge_note_versions(id),
        created_at TEXT NOT NULL,
        UNIQUE (note_id, version_number),
        -- 证据不足（none/insufficient）不得标记 supported/contradicted/disputed（契约 §8.2 / §19）
        CHECK (conclusion_status NOT IN ('supported','contradicted','disputed') OR evidence_level NOT IN ('none','insufficient')),
        -- 恢复必须是追加版本并指向被恢复版本（契约 §15.2）
        CHECK (change_type != 'restored' OR restored_from_version_id IS NOT NULL)
      );
      CREATE INDEX knowledge_note_versions_note ON knowledge_note_versions(note_id, version_number DESC);
      CREATE TRIGGER knowledge_note_versions_immutable_update
        BEFORE UPDATE ON knowledge_note_versions
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_note_versions_immutable_delete
        BEFORE DELETE ON knowledge_note_versions
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_VERSION_IMMUTABLE'); END;
      -- 循环引用分解：版本表就绪后再挂当前版本指针（仅 NULL 默认的列允许带 REFERENCES 追加）
      ALTER TABLE knowledge_notes ADD COLUMN current_version_id TEXT REFERENCES knowledge_note_versions(id);

      -- ===== WikiPage：综合阅读身份 =====
      CREATE TABLE knowledge_wiki_pages (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        page_type TEXT NOT NULL CHECK (page_type IN ('map','topic','entity','method','synthesis')),
        canonical_key TEXT NOT NULL,
        title TEXT NOT NULL,
        subject_type TEXT CHECK (subject_type IN ('scope','topic','entity','method_note')),
        subject_id TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived','superseded','merged','rejected')),
        merged_into_page_id TEXT REFERENCES knowledge_wiki_pages(id),
        superseded_by_page_id TEXT REFERENCES knowledge_wiki_pages(id),
        compile_status TEXT NOT NULL CHECK (compile_status IN ('current','stale','compiling','failed')),
        compile_note TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (scope, canonical_key),
        CHECK (subject_id IS NOT NULL OR page_type = 'synthesis'),
        CHECK (subject_type IS NOT NULL OR page_type = 'synthesis'),
        CHECK ((page_type = 'map' AND subject_type = 'scope') OR
               (page_type = 'topic' AND subject_type = 'topic') OR
               (page_type = 'entity' AND subject_type = 'entity') OR
               (page_type = 'method' AND subject_type = 'method_note') OR
               (page_type = 'synthesis' AND subject_type IS NULL)),
        CHECK (lifecycle != 'merged' OR merged_into_page_id IS NOT NULL),
        CHECK (lifecycle != 'superseded' OR superseded_by_page_id IS NOT NULL)
      );
      -- 同一 Scope 内一个 Subject 默认至多一个同类型 active 页面（契约 §9.3）
      CREATE UNIQUE INDEX knowledge_wiki_pages_active_subject
        ON knowledge_wiki_pages(scope, subject_type, subject_id)
        WHERE lifecycle = 'active' AND subject_id IS NOT NULL;
      CREATE INDEX knowledge_wiki_pages_scope_type ON knowledge_wiki_pages(scope, page_type, lifecycle);
      CREATE TRIGGER knowledge_wiki_pages_delete_immutable
        BEFORE DELETE ON knowledge_wiki_pages
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_OBJECT_DELETE_FORBIDDEN'); END;

      -- ===== WikiPageVersion：不可变综合版本 =====
      CREATE TABLE knowledge_wiki_page_versions (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES knowledge_wiki_pages(id),
        version_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body_json TEXT NOT NULL,
        adopted_note_version_ids_json TEXT NOT NULL DEFAULT '[]',
        business_object_refs_json TEXT NOT NULL DEFAULT '[]',
        flags_json TEXT NOT NULL DEFAULT '[]',
        change_summary TEXT NOT NULL,
        readable_diff TEXT NOT NULL DEFAULT '',
        compile_reason TEXT NOT NULL,
        creator_nature TEXT NOT NULL CHECK (creator_nature IN ('user','pi','background_agent','system','migration')),
        change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        restored_from_version_id TEXT REFERENCES knowledge_wiki_page_versions(id),
        created_at TEXT NOT NULL,
        UNIQUE (page_id, version_number)
      );
      CREATE INDEX knowledge_wiki_page_versions_page ON knowledge_wiki_page_versions(page_id, version_number DESC);
      CREATE TRIGGER knowledge_wiki_page_versions_immutable_update
        BEFORE UPDATE ON knowledge_wiki_page_versions
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_VERSION_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_wiki_page_versions_immutable_delete
        BEFORE DELETE ON knowledge_wiki_page_versions
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_VERSION_IMMUTABLE'); END;
      ALTER TABLE knowledge_wiki_pages ADD COLUMN current_version_id TEXT REFERENCES knowledge_wiki_page_versions(id);

      -- ===== KnowledgeFormalRelation：注册表 + 有身份可终结关系 =====
      -- 表名用 knowledge_formal_relations：既有 v18/v21 knowledge_relations 是画布可视化投影
      -- （from_node_id/to_node_id），不得同名/冒充正式知识关系（契约 §2 / §16）。
      CREATE TABLE knowledge_relation_registry (
        relation_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        directional INTEGER NOT NULL CHECK (directional IN (0,1)),
        allows_duplicate INTEGER NOT NULL CHECK (allows_duplicate IN (0,1)),
        participates_in_judgment INTEGER NOT NULL CHECK (participates_in_judgment IN (0,1)),
        in_creation_recall INTEGER NOT NULL CHECK (in_creation_recall IN (0,1)),
        reverse_name TEXT NOT NULL DEFAULT '',
        from_types_json TEXT NOT NULL,
        to_types_json TEXT NOT NULL,
        extension INTEGER NOT NULL DEFAULT 0 CHECK (extension IN (0,1))
      );
      INSERT INTO knowledge_relation_registry
        (relation_key, display_name, description, directional, allows_duplicate, participates_in_judgment, in_creation_recall, reverse_name, from_types_json, to_types_json)
      VALUES
        ('supports', '支持', '证据与推理：前项支持后项', 1, 0, 1, 1, 'supported_by', '["knowledge_note","knowledge_note_version"]', '["knowledge_note","knowledge_note_version"]'),
        ('contradicts', '反驳', '证据与推理：前项反驳后项', 1, 0, 1, 1, 'contradicted_by', '["knowledge_note","knowledge_note_version"]', '["knowledge_note","knowledge_note_version"]'),
        ('qualifies', '限定', '证据与推理：前项限定后项适用范围', 1, 0, 1, 1, 'qualified_by', '["knowledge_note","knowledge_note_version"]', '["knowledge_note","knowledge_note_version"]'),
        ('supersedes', '替代', '证据与推理：前项替代后项', 1, 0, 1, 1, 'superseded_by', '["knowledge_note","knowledge_note_version"]', '["knowledge_note","knowledge_note_version"]'),
        ('derived_from', '源于', '证据与推理：前项源于后项', 1, 0, 1, 1, 'derives', '["knowledge_note","knowledge_note_version"]', '["knowledge_note","knowledge_note_version","free_note","source","wiki_page"]'),
        ('about', '关于', '主题与归属：知识对象关于实体/主题', 1, 1, 0, 1, 'referenced_by', '["knowledge_note","knowledge_note_version"]', '["knowledge_entity","topic"]'),
        ('part_of', '属于', '主题与归属：部分-整体', 1, 1, 0, 1, 'has_part', '["knowledge_note"]', '["knowledge_note"]'),
        ('applies_to', '适用于', '主题与归属：知识适用于实体/主题', 1, 1, 0, 1, 'applied_by', '["knowledge_note"]', '["knowledge_entity","topic"]'),
        ('instance_of', '实例属于', '主题与归属：实例-类属', 1, 1, 0, 1, 'has_instance', '["knowledge_note","knowledge_entity"]', '["knowledge_entity"]'),
        ('related_to', '相关', '主题与归属：弱相关（非默认输出）', 0, 1, 0, 0, 'related_to', '["knowledge_note","knowledge_entity"]', '["knowledge_note","knowledge_entity"]'),
        ('uses_method', '使用方法', '创作与方法', 1, 1, 0, 1, 'used_by', '["knowledge_note"]', '["knowledge_note"]'),
        ('validates_pattern', '验证模式', '创作与方法', 1, 1, 1, 1, 'validated_by', '["knowledge_note"]', '["knowledge_note"]'),
        ('invalidates_pattern', '证伪模式', '创作与方法', 1, 1, 1, 1, 'invalidated_by', '["knowledge_note"]', '["knowledge_note"]'),
        ('effective_for', '对…有效', '创作与方法', 1, 1, 0, 1, 'effectively_used_by', '["knowledge_note"]', '["knowledge_entity","topic"]'),
        ('ineffective_for', '对…无效', '创作与方法', 1, 1, 0, 1, 'ineffectively_used_by', '["knowledge_note"]', '["knowledge_entity","topic"]'),
        ('inspired', '启发', '创作与方法', 1, 1, 0, 0, 'inspires', '["knowledge_note"]', '["knowledge_note"]'),
        ('created_by', '由…创建', '实体关系', 1, 1, 0, 0, 'creates', '["knowledge_note","knowledge_entity"]', '["knowledge_entity"]'),
        ('owned_by', '由…持有', '实体关系', 1, 1, 0, 0, 'owns', '["knowledge_note","knowledge_entity"]', '["knowledge_entity"]'),
        ('operated_by', '由…运营', '实体关系', 1, 1, 0, 0, 'operates', '["knowledge_note","knowledge_entity"]', '["knowledge_entity"]'),
        ('competes_with', '与…竞争', '实体关系', 0, 1, 0, 0, 'competes_with', '["knowledge_entity"]', '["knowledge_entity"]'),
        ('replaces', '取代', '实体关系', 1, 1, 1, 0, 'replaced_by', '["knowledge_entity","knowledge_note"]', '["knowledge_entity","knowledge_note"]');

      CREATE TABLE knowledge_formal_relations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        relation_key TEXT NOT NULL,
        from_object_type TEXT NOT NULL,
        from_object_id TEXT NOT NULL,
        to_object_type TEXT NOT NULL,
        to_object_id TEXT NOT NULL,
        created_change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        ended_change_set_id TEXT REFERENCES knowledge_change_sets(id),
        end_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        ended_at TEXT,
        CHECK (from_object_type != to_object_type OR from_object_id != to_object_id)
      );
      -- 活动关系去重；终结关系保留历史后可重新建立（契约 §11.3）
      CREATE UNIQUE INDEX knowledge_formal_relations_active
        ON knowledge_formal_relations(scope, from_object_type, from_object_id, relation_key, to_object_type, to_object_id)
        WHERE ended_change_set_id IS NULL;
      CREATE INDEX knowledge_formal_relations_from ON knowledge_formal_relations(from_object_type, from_object_id, relation_key);
      CREATE INDEX knowledge_formal_relations_to ON knowledge_formal_relations(to_object_type, to_object_id);
      CREATE TRIGGER knowledge_formal_relations_delete_immutable
        BEFORE DELETE ON knowledge_formal_relations
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_OBJECT_DELETE_FORBIDDEN'); END;

      -- ===== EvidenceLink：版本级证据（追加式不可变） =====
      CREATE TABLE knowledge_evidence_links (
        id TEXT PRIMARY KEY,
        knowledge_note_version_id TEXT NOT NULL REFERENCES knowledge_note_versions(id),
        evidence_object_type TEXT NOT NULL CHECK (evidence_object_type IN ('source','free_note','review','publication','metric_snapshot','knowledge_note_version','wiki_page_version','content_version','platform_version')),
        evidence_object_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','qualifies','derived_from')),
        source_nature TEXT NOT NULL CHECK (source_nature IN ('primary_source','secondary_source','user_statement','user_experience','business_record','performance_observation','review','derived_knowledge','ai_inference')),
        excerpt TEXT,
        locator TEXT,
        observed_at TEXT,
        creator_nature TEXT NOT NULL CHECK (creator_nature IN ('user','pi','background_agent','system','migration')),
        change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        created_at TEXT NOT NULL,
        -- derived_knowledge 必须引用具体 KnowledgeNoteVersion；其余来源性质不得冒充派生知识（契约 §12.1）
        CHECK ((source_nature = 'derived_knowledge') = (evidence_object_type = 'knowledge_note_version'))
      );
      CREATE INDEX knowledge_evidence_links_version ON knowledge_evidence_links(knowledge_note_version_id, relation);
      CREATE INDEX knowledge_evidence_links_object ON knowledge_evidence_links(evidence_object_type, evidence_object_id);
      CREATE TRIGGER knowledge_evidence_links_immutable_update
        BEFORE UPDATE ON knowledge_evidence_links
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_evidence_links_immutable_delete
        BEFORE DELETE ON knowledge_evidence_links
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_EVIDENCE_IMMUTABLE'); END;

      -- ===== KnowledgeAnnotation：用户干预（原文不可修改） =====
      CREATE TABLE knowledge_annotations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        target_type TEXT NOT NULL CHECK (target_type IN ('free_note','knowledge_entity','knowledge_note_version','wiki_page','wiki_page_version','knowledge_change_set')),
        target_id TEXT NOT NULL,
        quoted_text TEXT NOT NULL DEFAULT '',
        prefix_context TEXT NOT NULL DEFAULT '',
        suffix_context TEXT NOT NULL DEFAULT '',
        anchor_json TEXT NOT NULL DEFAULT '{}',
        intent TEXT NOT NULL CHECK (intent IN ('correction','qualify','downgrade','emphasize','research_request','merge','split','restore','comment')),
        body TEXT NOT NULL DEFAULT '',
        migration_state TEXT NOT NULL DEFAULT 'none' CHECK (migration_state IN ('none','migrated','deleted','ambiguous','user_removed')),
        processing_state TEXT NOT NULL DEFAULT 'open' CHECK (processing_state IN ('open','processed')),
        processed_change_set_id TEXT REFERENCES knowledge_change_sets(id),
        user_identity TEXT NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX knowledge_annotations_target ON knowledge_annotations(target_type, target_id);
      CREATE TRIGGER knowledge_annotations_text_immutable
        BEFORE UPDATE ON knowledge_annotations
        FOR EACH ROW
        WHEN OLD.quoted_text IS NOT NEW.quoted_text OR OLD.prefix_context IS NOT NEW.prefix_context
          OR OLD.suffix_context IS NOT NEW.suffix_context OR OLD.anchor_json IS NOT NEW.anchor_json
          OR OLD.body IS NOT NEW.body OR OLD.intent IS NOT NEW.intent OR OLD.user_identity IS NOT NEW.user_identity
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_ANNOTATION_TEXT_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_annotations_delete_immutable
        BEFORE DELETE ON knowledge_annotations
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_ANNOTATION_DELETE_FORBIDDEN'); END;

      -- ===== KnowledgeUpdateReceipt：可读知识变化回执（一等读模型，非新真源） =====
      CREATE TABLE knowledge_update_receipts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('ingest','query','lint','creation','review')),
        request_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        affected_topics_json TEXT NOT NULL DEFAULT '[]',
        affected_entities_json TEXT NOT NULL DEFAULT '[]',
        affected_methods_json TEXT NOT NULL DEFAULT '[]',
        affected_syntheses_json TEXT NOT NULL DEFAULT '[]',
        wiki_page_versions_json TEXT NOT NULL DEFAULT '[]',
        impact_json TEXT NOT NULL DEFAULT '{}',
        auto_resolutions_json TEXT NOT NULL DEFAULT '[]',
        retained_disputes_json TEXT NOT NULL DEFAULT '[]',
        failures_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, request_id)
      );
      CREATE INDEX knowledge_update_receipts_created ON knowledge_update_receipts(created_at DESC);
      CREATE TRIGGER knowledge_update_receipts_immutable_update
        BEFORE UPDATE ON knowledge_update_receipts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_update_receipts_immutable_delete
        BEFORE DELETE ON knowledge_update_receipts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_RECEIPT_IMMUTABLE'); END;

      -- ===== QueryArtifact：问答写回的有界处理记录（不可变） =====
      CREATE TABLE knowledge_query_artifacts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        question TEXT NOT NULL,
        answer_summary TEXT NOT NULL DEFAULT '',
        read_wiki_version_ids_json TEXT NOT NULL DEFAULT '[]',
        read_note_version_ids_json TEXT NOT NULL DEFAULT '[]',
        read_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        candidates_json TEXT NOT NULL DEFAULT '[]',
        write_back_decision TEXT NOT NULL CHECK (write_back_decision IN ('created','updated','skipped_repetition','skipped_low_value','skipped_transient','no_write_back')),
        skip_reason TEXT,
        change_set_id TEXT REFERENCES knowledge_change_sets(id),
        receipt_id TEXT REFERENCES knowledge_update_receipts(id),
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX knowledge_query_artifacts_created ON knowledge_query_artifacts(scope, created_at DESC);
      CREATE TRIGGER knowledge_query_artifacts_immutable_update
        BEFORE UPDATE ON knowledge_query_artifacts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_QUERY_ARTIFACT_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_query_artifacts_immutable_delete
        BEFORE DELETE ON knowledge_query_artifacts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_QUERY_ARTIFACT_IMMUTABLE'); END;

      -- ===== KnowledgeHealthIssue：Lint 结果契约（可终结，禁止硬删） =====
      CREATE TABLE knowledge_health_issues (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        issue_type TEXT NOT NULL CHECK (issue_type IN ('stale_claim','unresolved_contradiction','unsupported_claim','duplicate_entity','duplicate_knowledge','orphan_knowledge','missing_wiki_page','stale_wiki_page','broken_reference','unreturned_review','underperforming_method','overgeneralized_global','unanswered_high_value_question')),
        affected_object_type TEXT,
        affected_object_id TEXT,
        severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        suggested_action TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('open','repairing','resolved','accepted_risk','false_positive')),
        resolution_note TEXT,
        resolved_change_set_id TEXT REFERENCES knowledge_change_sets(id),
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        revision INTEGER NOT NULL
      );
      CREATE INDEX knowledge_health_issues_status ON knowledge_health_issues(status, detected_at DESC);
      CREATE INDEX knowledge_health_issues_scope_type ON knowledge_health_issues(scope, issue_type, status);
      CREATE TRIGGER knowledge_health_issues_delete_immutable
        BEFORE DELETE ON knowledge_health_issues
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_HEALTH_DELETE_FORBIDDEN'); END;
    `
  },
  {
    version: 57,
    sql: `
      -- ===== WMB-5215 M6：创作知识调用血缘（不可变 Usage Package + Usage Record） =====
      -- Design: docs/spark/2026-08-12-wmb-creation-knowledge-usage-protocol-design.md §2/§6。
      -- 要点：使用包是一次任务输入快照，不成为新知识真源（只固定 Wiki/Note/Evidence 版本引用，
      -- 不复制正式知识原文）；包与记录同事务提交（transaction=false 可嵌入内容保存事务）；
      -- 引用不存在版本/证据由 store 层拒绝；used/consulted 由 usage_kind 派生（DB CHECK 强制判别）；
      -- 全部不可变、禁止硬删；workspace/scope 隔离复用 v56 既有 gate（assertWorkspaceMatches/assertScopeAllowed）。

      CREATE TABLE knowledge_usage_packages (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        workspace_id TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('source_judgment','topic_proposal','creative_brief','core_draft','platform_adaptation','review')),
        request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        topic_id TEXT,
        source_ids_json TEXT NOT NULL DEFAULT '[]',
        plan_item_id TEXT,
        project_id TEXT,
        platform TEXT,
        audience TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL DEFAULT '',
        wiki_page_version_ids_json TEXT NOT NULL DEFAULT '[]',
        note_version_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        free_note_ids_json TEXT NOT NULL DEFAULT '[]',
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        selection_reasons_json TEXT NOT NULL DEFAULT '[]',
        cut_reasons_json TEXT NOT NULL DEFAULT '[]',
        compiler_schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, request_id)
      );
      CREATE INDEX knowledge_usage_packages_scope_stage ON knowledge_usage_packages(scope, stage, created_at DESC);
      CREATE INDEX knowledge_usage_packages_project ON knowledge_usage_packages(project_id, created_at DESC);
      CREATE INDEX knowledge_usage_packages_topic ON knowledge_usage_packages(topic_id, created_at DESC);
      CREATE TRIGGER knowledge_usage_packages_immutable_update
        BEFORE UPDATE ON knowledge_usage_packages
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_USAGE_PACKAGE_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_usage_packages_immutable_delete
        BEFORE DELETE ON knowledge_usage_packages
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_USAGE_DELETE_FORBIDDEN'); END;

      CREATE TABLE knowledge_usage_records (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        workspace_id TEXT NOT NULL,
        package_id TEXT NOT NULL REFERENCES knowledge_usage_packages(id),
        output_object_type TEXT NOT NULL CHECK (output_object_type IN ('source_item','topic_proposal','creative_brief','plan_item','content_version','platform_version','review','publication')),
        output_object_id TEXT NOT NULL,
        note_version_id TEXT REFERENCES knowledge_note_versions(id),
        wiki_page_version_id TEXT REFERENCES knowledge_wiki_page_versions(id),
        usage_kind TEXT NOT NULL CHECK (usage_kind IN ('quoted','paraphrased','reasoning_basis','structure_pattern','avoided_due_to_risk','rejected_by_user','consulted')),
        used INTEGER NOT NULL CHECK (used IN (0,1)),
        locator TEXT,
        reason TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        evidence_id TEXT REFERENCES knowledge_evidence_links(id),
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        -- 恰好固定一个知识版本（Note 版本 XOR Wiki 版本，XOR 由 CHECK 强制）
        CHECK ((note_version_id IS NULL) != (wiki_page_version_id IS NULL)),
        -- used/consulted 判别：六种用途 = 实际使用（used=1）；consulted = 仅读取未影响产物（used=0）
        CHECK ((usage_kind = 'consulted' AND used = 0) OR (usage_kind != 'consulted' AND used = 1))
      );
      -- 同包内同一（输出, 用途, 知识版本）至多一条（重放/重复追加幂等）
      CREATE UNIQUE INDEX knowledge_usage_records_dedupe
        ON knowledge_usage_records(package_id, output_object_type, output_object_id, usage_kind, note_version_id, wiki_page_version_id);
      CREATE INDEX knowledge_usage_records_package ON knowledge_usage_records(package_id, created_at DESC);
      CREATE INDEX knowledge_usage_records_output ON knowledge_usage_records(output_object_type, output_object_id);
      CREATE TRIGGER knowledge_usage_records_immutable_update
        BEFORE UPDATE ON knowledge_usage_records
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_USAGE_RECORD_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_usage_records_immutable_delete
        BEFORE DELETE ON knowledge_usage_records
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_USAGE_DELETE_FORBIDDEN'); END;
    `
  },
  {
    version: 58,
    sql: `
      -- ===== WMB-5217 M8：历史初始化基础设施 =====
      -- Design: docs/spark/2026-08-12-wmb-knowledge-flywheel-migration-delivery-acceptance-design.md §4/§7。
      -- 1) 初始化状态表：每个 active Topic 的历史初始化 checkpoint（migration 基础设施，非知识真源；
      --    知识对象写入仍只经 applyKnowledgeChangeSet）。topic_id 为主键 → 一 Topic 一 Wiki 身份；
      --    status 支持可重跑/可中断恢复：initialized 终态幂等跳过，failed 允许下次重试。
      CREATE TABLE knowledge_legacy_init_state (
        topic_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        migration_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('initialized','skipped_already_has_wiki','skipped_state_changed','skipped_inactive','failed')),
        wiki_page_id TEXT,
        change_set_id TEXT,
        receipt_id TEXT,
        last_error TEXT,
        completed_at TEXT NOT NULL
      );
      CREATE INDEX knowledge_legacy_init_state_workspace ON knowledge_legacy_init_state(workspace_id, completed_at DESC);

      -- 2) 回执 trigger_type 增加 'migration'（重建 knowledge_update_receipts；只追加 CHECK 取值，
      --    存量行原样保留，不改写正文/计数；不可变触发器与索引原样重建）。
      CREATE TABLE knowledge_update_receipts_v58 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id),
        trigger_type TEXT NOT NULL CHECK (trigger_type IN ('ingest','query','lint','creation','review','migration')),
        request_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        counts_json TEXT NOT NULL,
        affected_topics_json TEXT NOT NULL DEFAULT '[]',
        affected_entities_json TEXT NOT NULL DEFAULT '[]',
        affected_methods_json TEXT NOT NULL DEFAULT '[]',
        affected_syntheses_json TEXT NOT NULL DEFAULT '[]',
        wiki_page_versions_json TEXT NOT NULL DEFAULT '[]',
        impact_json TEXT NOT NULL DEFAULT '{}',
        auto_resolutions_json TEXT NOT NULL DEFAULT '[]',
        retained_disputes_json TEXT NOT NULL DEFAULT '[]',
        failures_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL CHECK (created_by IN ('user','pi','background_agent','system','migration')),
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, request_id)
      );
      INSERT INTO knowledge_update_receipts_v58 (
        id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json,
        affected_topics_json, affected_entities_json, affected_methods_json, affected_syntheses_json,
        wiki_page_versions_json, impact_json, auto_resolutions_json, retained_disputes_json,
        failures_json, created_by, created_at
      )
      SELECT id, workspace_id, change_set_id, trigger_type, request_id, summary, counts_json,
        affected_topics_json, affected_entities_json, affected_methods_json, affected_syntheses_json,
        wiki_page_versions_json, impact_json, auto_resolutions_json, retained_disputes_json,
        failures_json, created_by, created_at
      FROM knowledge_update_receipts;
      DROP TABLE knowledge_update_receipts;
      ALTER TABLE knowledge_update_receipts_v58 RENAME TO knowledge_update_receipts;
      CREATE INDEX knowledge_update_receipts_created ON knowledge_update_receipts(created_at DESC);
      CREATE TRIGGER knowledge_update_receipts_immutable_update
        BEFORE UPDATE ON knowledge_update_receipts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_RECEIPT_IMMUTABLE'); END;
      CREATE TRIGGER knowledge_update_receipts_immutable_delete
        BEFORE DELETE ON knowledge_update_receipts
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_RECEIPT_IMMUTABLE'); END;
    `
  },
  {
    // WMB-5237：网页/本地图片可追溯视觉理解记录。
    // 输入身份 = sourceId + sourceRevisionId（字符串契约，由 revision slice 提供）+ assetId + schemaVersion；
    // 幂等 = 同一三元组 + schemaVersion + attempt（attempt=1 首次；失败重试创建新 attempt 行，旧行保留审计）；
    // 成功输出（model/provider/prompt_version/observation_json/completed_at）写入一次后不可变
    // （completed 行禁止任何 UPDATE，由触发器强制）。
    version: 59,
    sql: `
      CREATE TABLE knowledge_visual_runs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES source_items(id),
        source_revision_id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
        attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        model TEXT,
        provider TEXT,
        prompt_version INTEGER NOT NULL DEFAULT 1 CHECK (prompt_version >= 1),
        observation_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (source_id, source_revision_id, asset_id, schema_version, attempt)
      );
      CREATE INDEX knowledge_visual_runs_status_created ON knowledge_visual_runs(status, created_at DESC);
      CREATE INDEX knowledge_visual_runs_source_created ON knowledge_visual_runs(source_id, source_revision_id, created_at DESC);
      CREATE TRIGGER knowledge_visual_runs_completed_immutable
        BEFORE UPDATE ON knowledge_visual_runs
        WHEN OLD.completed_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'VISUAL_RUN_COMPLETED_IMMUTABLE'); END;
    `
  },
  {
    version: 60,
    sql: `
      -- ===== WMB-5237 M9：knowledge_health_issues issue_type 扩展 data_gap =====
      -- 知识完整性七类检测新增 data_gap（业务意义缺口：captured FreeNote 超期未处理等）。
      -- 重建表只为追加 CHECK 取值（同 v58 模式）；存量行原样保留（含终态与证据），
      -- 索引与 delete 不可变触发器原样重建；不重写任何历史 migration。
      CREATE TABLE knowledge_health_issues_v60 (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope = 'global' OR scope LIKE 'lane:%'),
        issue_type TEXT NOT NULL CHECK (issue_type IN ('stale_claim','unresolved_contradiction','unsupported_claim','duplicate_entity','duplicate_knowledge','orphan_knowledge','missing_wiki_page','stale_wiki_page','broken_reference','unreturned_review','underperforming_method','overgeneralized_global','unanswered_high_value_question','data_gap')),
        affected_object_type TEXT,
        affected_object_id TEXT,
        severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        suggested_action TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('open','repairing','resolved','accepted_risk','false_positive')),
        resolution_note TEXT,
        resolved_change_set_id TEXT REFERENCES knowledge_change_sets(id),
        detected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        revision INTEGER NOT NULL
      );
      INSERT INTO knowledge_health_issues_v60 (
        id, scope, issue_type, affected_object_type, affected_object_id, severity, evidence_json, suggested_action,
        status, resolution_note, resolved_change_set_id, detected_at, updated_at, resolved_at, revision
      )
      SELECT id, scope, issue_type, affected_object_type, affected_object_id, severity, evidence_json, suggested_action,
        status, resolution_note, resolved_change_set_id, detected_at, updated_at, resolved_at, revision
      FROM knowledge_health_issues;
      DROP TABLE knowledge_health_issues;
      ALTER TABLE knowledge_health_issues_v60 RENAME TO knowledge_health_issues;
      CREATE INDEX knowledge_health_issues_status ON knowledge_health_issues(status, detected_at DESC);
      CREATE INDEX knowledge_health_issues_scope_type ON knowledge_health_issues(scope, issue_type, status);
      CREATE TRIGGER knowledge_health_issues_delete_immutable
        BEFORE DELETE ON knowledge_health_issues
        BEGIN SELECT RAISE(ABORT, 'KNOWLEDGE_HEALTH_DELETE_FORBIDDEN'); END;
    `
  }
] as const;
