import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAccount } from '../src/main/accounts.ts';
import { createContentProject, saveCoreVersion, savePlatformVersion } from '../src/main/content.ts';
import { migrateDatabase } from '../src/main/db/migrations.ts';
import { getKnowledgeTopicDossier, listKnowledgeTopics, upsertKnowledgeTopic } from '../src/main/knowledge.ts';
import { createPublication } from '../src/main/publishing.ts';
import { upsertSource } from '../src/main/sources.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'wmb-topics-list-'));
let db;
try {
  db = migrateDatabase(path.join(directory, 'wmb.db'));
  const now = new Date().toISOString();
  const topics = [];
  for (let index = 0; index < 55; index++) {
    topics.push(upsertKnowledgeTopic(db, {
      title: `主题列表 ${String(index).padStart(3, '0')}`,
      status: index === 1 ? 'watching' : 'active',
    }));
  }
  const archived = upsertKnowledgeTopic(db, { title: '已归档主题', status: 'archived' });
  const sourceA = upsertSource(db, {
    originalUrl: 'https://example.com/topics-list/a',
    title: '主资料 A',
    summary: '通过 topic_id 关联内容',
  });
  const sourceB = upsertSource(db, {
    originalUrl: 'https://example.com/topics-list/b',
    title: '链接资料 B',
    summary: '通过 topic_source_links 关联内容',
  });
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(topics[0].id, sourceA.id, 'primary', now, now);
  db.prepare('INSERT INTO topic_source_links(topic_id,source_id,relation,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(topics[0].id, sourceB.id, 'supporting', now, now);

  const directProject = createContentProject(db, {
    title: '直接主题项目',
    topicId: topics[0].id,
    sourceIds: [sourceA.id],
  });
  const linkedProject = createContentProject(db, {
    title: '链接资料项目',
    sourceIds: [sourceB.id],
  });
  const account = saveAccount(db, {
    platform: 'x',
    accountKey: '@topics-list',
    displayName: 'topics-list',
    loginState: 'authenticated',
  });

  for (const project of [directProject, linkedProject]) {
    const core = saveCoreVersion(db, { projectId: project.id, body: `正文 ${project.id}`, expectedRevision: 1 });
    if (!core.ok) throw new Error(core.error.message);
    const platform = savePlatformVersion(db, {
      projectId: project.id,
      contentVersionId: core.data.id,
      platform: 'x',
      format: 'text',
      body: `平台正文 ${project.id}`,
    });
    if (!platform.ok) throw new Error(platform.error.message);
    const publication = createPublication(db, {
      platformVersionId: platform.data.id,
      accountId: account.id,
    });
    if (!publication.ok) throw new Error(publication.error.message);
    const row = db.prepare('SELECT revision FROM publications WHERE id=?').get(publication.data.id);
    db.prepare(`UPDATE publications SET status='published',external_url=?,external_id=?,published_at=?,prepared_body=?,prepared_assets_json='[]',updated_at=?,revision=? WHERE id=?`)
      .run(
        `https://x.com/topics-list/status/${project.id}`,
        project.id.slice(0, 8),
        now,
        `平台正文 ${project.id}`,
        now,
        row.revision + 1,
        publication.data.id,
      );
  }

  const draftOnly = createContentProject(db, {
    title: '未发布项目',
    topicId: topics[0].id,
    sourceIds: [sourceA.id],
  });
  if (!draftOnly?.id) throw new Error('draft project missing');

  const page = listKnowledgeTopics(db, { limit: 20, offset: 0 });
  if (!page || !Array.isArray(page.items)) throw new Error('listKnowledgeTopics must return page.items');
  if (page.total !== 55) throw new Error(`expected total 55 non-archived topics, got ${page.total}`);
  if (page.limit !== 20 || page.offset !== 0 || page.items.length !== 20 || page.hasMore !== true) {
    throw new Error(`page envelope mismatch ${JSON.stringify({
      limit: page.limit,
      offset: page.offset,
      length: page.items.length,
      hasMore: page.hasMore,
    })}`);
  }
  if (page.items.some((item) => item.id === archived.id || item.status === 'archived')) {
    throw new Error('archived topics leaked into default list');
  }

  const second = listKnowledgeTopics(db, { limit: 20, offset: 20 });
  const third = listKnowledgeTopics(db, { limit: 20, offset: 40 });
  if (second.items.length !== 20 || second.hasMore !== true) throw new Error('second page hasMore/length mismatch');
  if (third.items.length !== 15 || third.hasMore !== false) throw new Error('third page hasMore/length mismatch');
  const seen = new Set([...page.items, ...second.items, ...third.items].map((item) => item.id));
  if (seen.size !== 55) throw new Error(`pagination omitted or duplicated topics: ${seen.size}`);

  const counted = listKnowledgeTopics(db, { query: '主题列表 000', limit: 10 });
  if (counted.total !== 1 || counted.items.length !== 1 || counted.hasMore !== false) {
    throw new Error(`query page mismatch ${JSON.stringify(counted)}`);
  }
  const row = counted.items[0];
  if (Number(row.sourceCount) !== 2) throw new Error(`sourceCount expected 2 got ${row.sourceCount}`);
  if (Number(row.contentCount) !== 3) throw new Error(`contentCount expected 3 got ${row.contentCount}`);
  if (Number(row.publicationCount) !== 2) throw new Error(`publicationCount expected 2 got ${row.publicationCount}`);

  const watching = listKnowledgeTopics(db, { status: 'watching', limit: 10 });
  if (watching.total !== 1 || watching.items[0]?.id !== topics[1].id) {
    throw new Error('status filter did not return watching topic');
  }
  const archivedPage = listKnowledgeTopics(db, { status: 'archived', limit: 10 });
  if (archivedPage.total !== 1 || archivedPage.items[0]?.id !== archived.id) {
    throw new Error('status=archived filter should include archived topics');
  }

  const dossier = getKnowledgeTopicDossier(db, { topicId: topics[0].id, category: 'sources', limit: 10 });
  const sourceMeta = dossier.items.find((item) => item.objectId === sourceA.id)?.metadata;
  if (!sourceMeta || sourceMeta.revision == null || sourceMeta.originalUrl !== 'https://example.com/topics-list/a') {
    throw new Error(`source metadata missing revision/originalUrl ${JSON.stringify(sourceMeta)}`);
  }

  console.log(JSON.stringify({
    total: page.total,
    firstPage: page.items.length,
    hasMore: page.hasMore,
    contentCount: Number(row.contentCount),
    publicationCount: Number(row.publicationCount),
    sourceRevision: sourceMeta.revision,
  }));
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
