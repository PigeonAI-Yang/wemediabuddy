export const knowledgeMigrations = [
  {
    version: 17,
    sql: `
      ALTER TABLE source_items ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending', 'verified', 'disputed', 'rejected'));
      ALTER TABLE source_items ADD COLUMN management_status TEXT NOT NULL DEFAULT 'active'
        CHECK (management_status IN ('active', 'watching', 'expired', 'archived'));
      ALTER TABLE topics ADD COLUMN canonical_key TEXT;
      ALTER TABLE topics ADD COLUMN kind TEXT NOT NULL DEFAULT 'theme'
        CHECK (kind IN ('theme', 'event'));
      ALTER TABLE topics ADD COLUMN summary TEXT;
      ALTER TABLE topics ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'watching', 'dormant', 'archived'));
      ALTER TABLE topics ADD COLUMN first_seen_at TEXT;
      ALTER TABLE topics ADD COLUMN last_seen_at TEXT;
      UPDATE topics SET canonical_key = lower(trim(title)), first_seen_at = created_at, last_seen_at = updated_at;
      CREATE UNIQUE INDEX topics_canonical_key ON topics(canonical_key);
      CREATE TABLE topic_source_links (
        topic_id TEXT NOT NULL REFERENCES topics(id),
        source_id TEXT NOT NULL REFERENCES source_items(id),
        relation TEXT NOT NULL CHECK (relation IN ('primary', 'supporting', 'background', 'contradicting')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (topic_id, source_id, relation)
      );
      CREATE INDEX topic_source_links_source ON topic_source_links(source_id);
      CREATE INDEX source_items_knowledge_status ON source_items(management_status, verification_status, collected_at DESC);
      CREATE INDEX topics_knowledge_status ON topics(status, last_seen_at DESC);
    `
  },
  {
    version: 18,
    sql: `
      CREATE TABLE knowledge_canvases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        topic_id TEXT REFERENCES topics(id),
        viewport_x REAL NOT NULL DEFAULT 0,
        viewport_y REAL NOT NULL DEFAULT 0,
        zoom REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE knowledge_canvas_nodes (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id) ON DELETE CASCADE,
        object_type TEXT NOT NULL CHECK (object_type IN ('topic','source','plan_item','content_project','review','method_finding','note')),
        object_id TEXT,
        note_title TEXT,
        note_text TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL DEFAULT 240,
        height REAL NOT NULL DEFAULT 140,
        z_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        CHECK ((object_type='note' AND object_id IS NULL AND note_title IS NOT NULL) OR
               (object_type!='note' AND object_id IS NOT NULL AND note_title IS NULL)),
        UNIQUE(canvas_id, object_type, object_id)
      );
      CREATE INDEX knowledge_canvas_nodes_canvas ON knowledge_canvas_nodes(canvas_id,z_index,id);
      CREATE TABLE knowledge_relations (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL REFERENCES knowledge_canvas_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES knowledge_canvas_nodes(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('supports','contradicts','derived_from','responds_to','uses_method','becomes_content','custom')),
        label TEXT,
        state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('suggested','confirmed','rejected')),
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
        created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','pi')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        CHECK (from_node_id != to_node_id),
        UNIQUE(canvas_id,from_node_id,to_node_id,relation_type)
      );
      CREATE INDEX knowledge_relations_canvas ON knowledge_relations(canvas_id,archived_at,id);
      CREATE TABLE knowledge_context_packages (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id),
        name TEXT NOT NULL,
        objective TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'selected_only' CHECK (scope='selected_only'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE knowledge_context_package_items (
        package_id TEXT NOT NULL REFERENCES knowledge_context_packages(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT,
        sort_order INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(package_id,node_id)
      );
      CREATE INDEX knowledge_context_package_items_order ON knowledge_context_package_items(package_id,sort_order);
      CREATE TABLE knowledge_context_package_relations (
        package_id TEXT NOT NULL REFERENCES knowledge_context_packages(id) ON DELETE CASCADE,
        relation_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY(package_id,relation_id)
      );
      CREATE TABLE knowledge_context_uses (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL REFERENCES knowledge_context_packages(id),
        package_revision INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('discussion','creation')),
        pi_session_id TEXT,
        content_project_id TEXT REFERENCES content_projects(id),
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX knowledge_context_uses_package ON knowledge_context_uses(package_id,created_at);
    `
  },
  {
    version: 19,
    sql: `
      ALTER TABLE knowledge_context_uses ADD COLUMN request_id TEXT;
      CREATE UNIQUE INDEX knowledge_context_uses_request ON knowledge_context_uses(request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE content_project_context_packages (
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL REFERENCES knowledge_context_packages(id),
        package_revision INTEGER NOT NULL,
        use_id TEXT NOT NULL REFERENCES knowledge_context_uses(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id,package_id,package_revision)
      );
      CREATE INDEX content_project_context_packages_package ON content_project_context_packages(package_id,package_revision);
    `
  },
  {
    version: 20,
    sql: `
      CREATE TABLE knowledge_domains (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','watching','dormant')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX knowledge_domains_title ON knowledge_domains(title) WHERE archived_at IS NULL;
      CREATE INDEX knowledge_domains_status ON knowledge_domains(status,sort_order,updated_at DESC);
      CREATE TABLE knowledge_domain_topics (
        domain_id TEXT NOT NULL REFERENCES knowledge_domains(id) ON DELETE CASCADE,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        sort_order INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        PRIMARY KEY(domain_id,topic_id)
      );
      CREATE INDEX knowledge_domain_topics_topic ON knowledge_domain_topics(topic_id);
    `
  },
  {
    version: 21,
    sql: `
      CREATE TABLE knowledge_canvas_nodes_v21 (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id) ON DELETE CASCADE,
        object_type TEXT NOT NULL CHECK (object_type IN ('topic','source','plan_item','content_project','publication','metric_snapshot','review','method_finding','note')),
        object_id TEXT,
        note_title TEXT,
        note_text TEXT,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL DEFAULT 240,
        height REAL NOT NULL DEFAULT 140,
        z_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        CHECK ((object_type='note' AND object_id IS NULL AND note_title IS NOT NULL) OR
               (object_type!='note' AND object_id IS NOT NULL AND note_title IS NULL)),
        UNIQUE(canvas_id, object_type, object_id)
      );
      INSERT INTO knowledge_canvas_nodes_v21 SELECT * FROM knowledge_canvas_nodes;
      CREATE TABLE knowledge_relations_v21 (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id) ON DELETE CASCADE,
        from_node_id TEXT NOT NULL REFERENCES knowledge_canvas_nodes_v21(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES knowledge_canvas_nodes_v21(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('supports','contradicts','derived_from','responds_to','uses_method','becomes_content','custom')),
        label TEXT,
        state TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('suggested','confirmed','rejected')),
        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
        created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','pi')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        CHECK (from_node_id != to_node_id),
        UNIQUE(canvas_id,from_node_id,to_node_id,relation_type)
      );
      INSERT INTO knowledge_relations_v21 SELECT * FROM knowledge_relations;
      DROP TABLE knowledge_relations;
      DROP TABLE knowledge_canvas_nodes;
      ALTER TABLE knowledge_canvas_nodes_v21 RENAME TO knowledge_canvas_nodes;
      ALTER TABLE knowledge_relations_v21 RENAME TO knowledge_relations;
      CREATE INDEX knowledge_canvas_nodes_canvas ON knowledge_canvas_nodes(canvas_id,z_index,id);
      CREATE INDEX knowledge_relations_canvas ON knowledge_relations(canvas_id,archived_at,id);
    `
  },
  {
    version: 22,
    sql: `
      ALTER TABLE knowledge_context_packages ADD COLUMN family_id TEXT;
      ALTER TABLE knowledge_context_packages ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE knowledge_context_packages ADD COLUMN excluded_json TEXT NOT NULL DEFAULT '[]';
      UPDATE knowledge_context_packages SET family_id=id WHERE family_id IS NULL;
      CREATE UNIQUE INDEX knowledge_context_packages_family_version ON knowledge_context_packages(family_id,version_number);
      CREATE INDEX knowledge_context_packages_active_updated ON knowledge_context_packages(archived_at,updated_at DESC,id);
    `
  },
  {
    version: 23,
    sql: `
      CREATE TABLE knowledge_suggestions (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        canvas_id TEXT NOT NULL REFERENCES knowledge_canvases(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('node','relation')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','confirmed','rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX knowledge_suggestions_canvas_state ON knowledge_suggestions(canvas_id,state,created_at,id);
    `
  },
  {
    version: 24,
    sql: `
      CREATE TABLE creative_briefs (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL REFERENCES knowledge_context_packages(id),
        package_revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        core_judgment TEXT NOT NULL,
        why_now TEXT NOT NULL,
        structure_json TEXT NOT NULL DEFAULT '[]',
        evidence_node_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(package_id,package_revision)
      );
      CREATE INDEX creative_briefs_updated ON creative_briefs(updated_at DESC,id);
    `
  },
  {
    version: 25,
    sql: `
      CREATE TABLE creative_briefs_v25 (
        id TEXT PRIMARY KEY,
        package_id TEXT REFERENCES knowledge_context_packages(id),
        package_revision INTEGER,
        canvas_id TEXT REFERENCES knowledge_canvases(id),
        selection_mode TEXT NOT NULL DEFAULT 'selected' CHECK (selection_mode IN ('current_page','selected')),
        context_node_ids_json TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL,
        core_judgment TEXT NOT NULL,
        why_now TEXT NOT NULL,
        structure_json TEXT NOT NULL DEFAULT '[]',
        evidence_node_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO creative_briefs_v25(
        id,package_id,package_revision,canvas_id,selection_mode,context_node_ids_json,
        title,core_judgment,why_now,structure_json,evidence_node_ids_json,status,created_at,updated_at,revision
      )
      SELECT b.id,b.package_id,b.package_revision,p.canvas_id,'selected',
        (SELECT json_group_array(node_id) FROM knowledge_context_package_items WHERE package_id=b.package_id ORDER BY sort_order),
        b.title,b.core_judgment,b.why_now,b.structure_json,b.evidence_node_ids_json,b.status,b.created_at,b.updated_at,b.revision
      FROM creative_briefs b JOIN knowledge_context_packages p ON p.id=b.package_id;
      DROP TABLE creative_briefs;
      ALTER TABLE creative_briefs_v25 RENAME TO creative_briefs;
      CREATE INDEX creative_briefs_updated ON creative_briefs(updated_at DESC,id);
      CREATE INDEX creative_briefs_context ON creative_briefs(canvas_id,updated_at DESC,id);
    `
  },
  {
    version: 26,
    sql: `
      CREATE TABLE creative_brief_projects (
        brief_id TEXT PRIMARY KEY REFERENCES creative_briefs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL UNIQUE REFERENCES content_projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
    `
  }

] as const;
