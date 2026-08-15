import { stableStringify } from './eval-029-fixtures-shared.mjs';

export function loadRoot(database, rootFixture, fixture) {
  const t = fixture.fixedTime;
  const shared = fixture.sharedBusinessValues;
  const ids = rootFixture.ids;
  const profile = rootFixture.profile;
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES(?,?,?,?,1)').run('workspace_id', rootFixture.workspaceId, t, t);
    database.prepare('INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES(?,?,?,?,1)').run('eval029.root_id', rootFixture.rootLocalId, t, t);
    database.prepare('INSERT INTO app_meta(key,value,created_at,updated_at,revision) VALUES(?,?,?,?,1)').run(
      fixture.legacySentinels.browserConfigKey,
      stableStringify(fixture.legacySentinels.browserConfigValue),
      t,
      t
    );
    database.prepare(`INSERT INTO agent_tasks (
      id, intent, business_date, status, phase, pi_session_id, context_refs_json, result_refs_json,
      progress_json, checkpoint_json, events_json, control_action, heartbeat_at, error_code, error_message,
      created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, 'running', ?, ?, ?, '{}', '{}', '{}', '[]', NULL, ?, NULL, NULL, ?, ?, NULL)`).run(
      ids.agentTask,
      shared.agentTaskIntent,
      shared.planDate,
      shared.agentTaskPhase,
      ids.legacySession,
      stableStringify({ workspaceId: rootFixture.workspaceId, fixture: 'EVAL-029' }),
      t,
      t,
      t
    );
    database.prepare(`INSERT INTO workspace_profiles (
      id,profile_id,revision,official_template_id,official_template_version,display_name,audience,content_goal,editorial_brief,
      intelligence_pack_id,intelligence_pack_version,creation_pack_id,creation_pack_version,platforms_json,created_at,updated_at
    ) VALUES ('effective',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      profile.profileId,
      profile.revision,
      profile.officialTemplateId,
      profile.officialTemplateVersion,
      profile.displayName,
      profile.audience,
      profile.contentGoal,
      profile.editorialBrief,
      profile.intelligencePackId,
      profile.intelligencePackVersion,
      profile.creationPackId,
      profile.creationPackVersion,
      JSON.stringify(profile.platforms),
      t,
      t
    );
    database.prepare('INSERT INTO source_feeds(id,name,url,created_at,updated_at,revision,registry_id) VALUES(?,?,?,?,?,1,NULL)').run(ids.feed, shared.feedName, shared.feedUrl, t, t);
    database.prepare(`INSERT INTO source_items (
      id,feed_id,original_url,canonical_url,content_fingerprint,title,author,published_at,collected_at,summary,categories_json,keywords_json,
      value_judgment,ip_relevance,creation_angles,recommended_platforms_json,recommended_formats_json,timeliness,priority,evidence,client_label,
      created_at,updated_at,revision,verification_status,management_status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'verified','active')`).run(
      ids.source,
      ids.feed,
      shared.sourceUrl,
      shared.sourceUrl,
      shared.sourceFingerprint,
      shared.sourceTitle,
      shared.sourceAuthor,
      t,
      t,
      shared.sourceSummary,
      '["official"]',
      '["eval-029","isolation"]',
      '值得形成可执行内容',
      '与目标受众直接相关',
      '["证据链","行动建议"]',
      '["x"]',
      '["text"]',
      shared.timeliness,
      2,
      '固定 EVAL-029 证据',
      'eval-029-fixture',
      t,
      t
    );
    database.prepare(`INSERT INTO topics(id,title,created_at,updated_at,revision,canonical_key,kind,summary,status,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,1,?,'theme',?,'active',?,?)`).run(ids.topic, shared.topicTitle, t, t, shared.topicCanonicalKey, shared.topicSummary, t, t);
    database.prepare("INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,'primary',?,?)").run(ids.topic, ids.source, t, t);
    database.prepare('INSERT INTO plans(id,plan_date,timezone,summary,is_current,created_at,updated_at,revision) VALUES(?,?,?,?,1,?,?,1)').run(ids.plan, shared.planDate, shared.timezone, shared.planSummary, t, t);
    database.prepare(`INSERT INTO plan_items (
      id,plan_id,topic_id,title,priority,why_now,timeliness,target_audience,angle,point_of_view,platforms_json,formats_json,title_guidance,
      opening_guidance,structure_guidance,effort_estimate,source_ids_json,review_ids_json,method_finding_ids_json,sort_order,created_at,updated_at,
      revision,available_materials_json,missing_materials_json,score_reasons_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','[]',1,?,?,1,?,'[]',?)`).run(
      ids.planItem,
      ids.plan,
      ids.topic,
      shared.planItemTitle,
      2,
      shared.whyNow,
      shared.timeliness,
      shared.targetAudience,
      shared.angle,
      shared.pointOfView,
      '["x"]',
      '["text"]',
      shared.titleGuidance,
      shared.openingGuidance,
      shared.structureGuidance,
      shared.effortEstimate,
      JSON.stringify([ids.source]),
      t,
      t,
      JSON.stringify([{ type: 'source', id: ids.source }]),
      '{"evidence":3,"timeliness":2}'
    );
    database.prepare(`INSERT INTO content_projects(id,topic_id,plan_item_id,title,created_at,updated_at,revision,status,archived_at)
      VALUES(?,?,?,?,?,?,1,'completed',NULL)`).run(ids.project, ids.topic, ids.planItem, shared.projectTitle, t, t);
    database.prepare('INSERT INTO content_project_sources(project_id,source_id) VALUES(?,?)').run(ids.project, ids.source);
    database.prepare('INSERT INTO content_versions(id,project_id,body,version_number,created_at,author) VALUES(?,?,?,?,?,?)').run(ids.contentVersion, ids.project, shared.contentBody, 1, t, 'ai');
    database.prepare(`INSERT INTO platform_versions(id,project_id,content_version_id,platform,format,title,body,asset_ids_json,created_at,updated_at,revision)
      VALUES(?,?,?,?,?,?,?,'[]',?,?,1)`).run(ids.platformVersion, ids.project, ids.contentVersion, shared.platform, shared.format, shared.platformTitle, shared.platformBody, t, t);
    database.prepare(`INSERT INTO platform_accounts(id,platform,account_key,display_name,login_state,evidence_url,created_at,updated_at,revision)
      VALUES(?, 'x', ?, ?, 'authenticated', ?, ?, ?, 1)`).run(ids.account, shared.accountKey, shared.accountDisplayName, 'https://example.com/eval-029/account-evidence', t, t);
    database.prepare(`INSERT INTO publications(
      id,platform_version_id,platform_version_revision,platform,account_id,account_key,status,prepared_title,prepared_body,prepared_assets_json,
      prepared_evidence_url,external_url,external_id,published_at,last_error_code,last_error_message,created_at,updated_at,revision
    ) VALUES(?,?,1,'x',?,?,'published',?,?,'[]',?,?,?,?,NULL,NULL,?,?,1)`).run(
      ids.publication,
      ids.platformVersion,
      ids.account,
      shared.accountKey,
      shared.publicationPreparedTitle,
      shared.publicationPreparedBody,
      'https://example.com/eval-029/prepared-evidence',
      'https://example.com/eval-029/published',
      'eval029-shared-external-visible-value',
      t,
      t,
      t
    );
    database.prepare(`INSERT INTO publication_metric_snapshots(id,publication_id,scheduled_for,captured_at,source_url,normalized_json,raw_json,created_at)
      VALUES(?,?,?,?,?,'{"likes":29}','{"likes":"29"}',?)`).run(ids.metricSnapshot, ids.publication, t, t, shared.metricSourceUrl, t);
    database.prepare(`INSERT INTO reviews(
      id,publication_id,content_version_id,metric_snapshot_ids_json,status,keep_json,stop_json,change_json,summary,created_at,updated_at,finalized_at,revision
    ) VALUES(?,?,?,?,'final',?,?,?,?,?,?,?,1)`).run(
      ids.review,
      ids.publication,
      ids.contentVersion,
      JSON.stringify([ids.metricSnapshot]),
      JSON.stringify(shared.reviewKeep),
      JSON.stringify(shared.reviewStop),
      JSON.stringify(shared.reviewChange),
      shared.reviewSummary,
      t,
      t,
      t
    );
    database.prepare('INSERT INTO method_findings(id,review_id,title,body,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,1)').run(
      ids.methodFinding,
      ids.review,
      shared.methodTitle,
      shared.methodBody,
      t,
      t
    );
    database.prepare('INSERT INTO mcp_request_results(tool,request_id,result_json,created_at) VALUES(?,?,?,?)').run(
      shared.requestTool,
      shared.requestId,
      stableStringify({ objectId: ids.project, sharedBusinessValue: shared.requestSharedResult, workspaceId: rootFixture.workspaceId }),
      t
    );
    database.prepare(`INSERT INTO source_scan_receipts(
      id,task_id,workspace_id,module,source_id,source_feed_id,checked_at,status,candidate_count,saved_count,error_code,error_message,created_at,updated_at,revision
    ) VALUES(?,?,?,?,?,?,?,'succeeded',1,1,NULL,NULL,?,?,1)`).run(
      ids.scanReceipt,
      shared.scanTaskId,
      rootFixture.workspaceId,
      shared.scanModule,
      shared.scanSourceId,
      ids.feed,
      t,
      t,
      t
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
