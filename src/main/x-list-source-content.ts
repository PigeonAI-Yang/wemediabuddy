import type { DatabaseSync } from 'node:sqlite';
import { getSourceBodyCache, writeSourceBodyCache } from './source-body-cache.ts';
import type { XListTimelineCachePayload, XListTimelineCachePost } from './x-list-timeline-cache.ts';
import { articleText } from './x-post-enrichment.ts';
export function composeXListSourceBody(post: XListTimelineCachePost): string {
  const sections: string[] = [];
  const ownText = cleanText(post.text);
  if (ownText) sections.push(ownText);

  const quoted = post.quotedPost;
  const quotedText = cleanText(quoted?.text);
  if (quoted && quotedText) {
    const quotedAuthor = cleanText(quoted.authorHandle) || cleanText(quoted.displayName) || '原作者';
    const quoteSection = [`引用内容 · ${quotedAuthor}`, quotedText];
    const quotedUrl = cleanText(quoted.url);
    if (quotedUrl) quoteSection.push(`引用原帖：${quotedUrl}`);
    sections.push(quoteSection.join('\n'));
  }

  const threadText = (post.authorThread ?? [])
    .map((item) => cleanText(item.text))
    .filter(Boolean);
  if (threadText.length) {
    const author = cleanText(post.authorHandle) || cleanText(post.displayName) || '原作者';
    sections.push([`作者 Thread · ${author}`, ...threadText].join('\n\n'));
  }

  const quotedThreadText = (quoted?.authorThread ?? [])
    .map((item) => cleanText(item.text))
    .filter(Boolean);
  if (quotedThreadText.length) {
    const author = cleanText(quoted?.authorHandle) || cleanText(quoted?.displayName) || '原作者';
    sections.push([`引用作者 Thread · ${author}`, ...quotedThreadText].join('\n\n'));
  }

  const articles = [...(post.articles ?? []), ...(quoted?.articles ?? [])];
  const seenArticles = new Set<string>();
  for (const article of articles) {
    if (seenArticles.has(article.canonicalUrl)) continue;
    seenArticles.add(article.canonicalUrl);
    const title = cleanText(article.title) || '原文';
    const section = [`X Article · ${title}`];
    const author = cleanText(article.authorHandle) || cleanText(article.displayName);
    if (author) section.push(`作者：${author}`);
    const body = articleText(article);
    if (body) section.push(body);
    else section.push(`原文：${article.canonicalUrl}`);
    sections.push(section.join('\n'));
  }

  return sections.filter(Boolean).join('\n\n');
}

function cleanText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}


/** 迁移存量 X List 缓存：仅修复“正文仍等于主帖短文”的引用帖，绝不覆盖已有富正文。 */
export function backfillXListQuotedSourceBodies(database: DatabaseSync, now = new Date().toISOString()): number {
  const rows = database.prepare('SELECT payload_json AS payloadJson, fetched_at AS fetchedAt FROM x_list_timeline_cache')
    .all() as Array<{ payloadJson: string; fetchedAt: string }>;
  const findSource = database.prepare(`SELECT id, COALESCE(canonical_url, original_url) AS url
    FROM source_items WHERE canonical_url = ? OR original_url = ? LIMIT 1`);
  let repaired = 0;

  for (const row of rows) {
    let payload: XListTimelineCachePayload;
    try { payload = JSON.parse(row.payloadJson) as XListTimelineCachePayload; } catch { continue; }
    for (const post of payload.posts ?? []) {
      const body = composeXListSourceBody(post);
      const ownText = cleanText(post.text);
      if (!post.quotedPost || !cleanText(post.quotedPost.text) || body === ownText) continue;
      const source = findSource.get(post.url, post.url) as { id: string; url: string } | undefined;
      if (!source) continue;
      const current = getSourceBodyCache(database, source.id);
      if (current?.status === 'ready' && cleanText(current.extractedText) !== ownText) continue;
      writeSourceBodyCache(database, {
        sourceId: source.id,
        url: source.url || post.url,
        status: 'ready',
        contentType: 'text/plain',
        extractedText: body,
        extractedChars: body.length,
        errorMessage: null,
        fetchedAt: row.fetchedAt || now,
        updatedAt: now
      });
      repaired += 1;
    }
  }
  return repaired;
}
