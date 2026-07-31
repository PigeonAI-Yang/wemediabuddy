export type RankingItem = {
  rank: number;
  name: string;
  url: string;
  description: string;
  language: string;
  stars: string;
  gained: string;
};

export type RankingBoard = {
  id: string;
  label: string;
  kind: 'rankings';
  sourceId: string;
  sourceLabel: string;
  sourceUrl: string;
  status: 'ready' | 'unavailable';
  error?: string;
  items: RankingItem[];
};

export type GitHubRankings = { fetchedAt: string; boards: RankingBoard[] };

const strip = (value: string) => value
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

function githubItems(html: string): RankingItem[] {
  return (html.match(/<article class="Box-row">[\s\S]*?<\/article>/g) ?? []).map((card, index) => {
    const path = card.match(/<h2[\s\S]*?href="\/([^"?]+\/[^"?]+)"/)?.[1] ?? '';
    const description = strip(card.match(/<p class="col-9[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? '');
    const language = strip(card.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/)?.[1] ?? '');
    const stars = strip(card.match(new RegExp(`href="/${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/stargazers"[^>]*>([\\s\\S]*?)<\\/a>`))?.[1] ?? '');
    const gained = strip(card.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/)?.[0] ?? '');
    return { rank: index + 1, name: path, url: `https://github.com/${path}`, description, language, stars, gained };
  }).filter((item) => item.name);
}

function whatsTrendingApiItems(value: string): RankingItem[] {
  const items = (JSON.parse(value) as {
    data?: Array<{ name?: string; url?: string; description?: string; language?: string; stars?: number; gained?: number }>;
  }).data ?? [];
  return items.map((item, index) => ({
    rank: index + 1,
    name: item.name ?? '',
    url: item.url ?? '',
    description: item.description ?? '',
    language: item.language ?? '',
    stars: typeof item.stars === 'number' ? `${item.stars.toLocaleString('en-US')} stars` : '',
    gained: typeof item.gained === 'number' ? `+${item.gained.toLocaleString('en-US')} stars` : ''
  })).filter((item) => item.name && item.url);
}

function itemListItems(html: string): RankingItem[] {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(match[1]) as {
        '@type'?: string;
        itemListElement?: Array<{ position?: number; url?: string; name?: string; description?: string; item?: { url?: string; name?: string; description?: string } }>;
      };
      if (data['@type'] !== 'ItemList' || !data.itemListElement?.length) continue;
      const items = data.itemListElement.map((entry, index) => {
        const item = entry.item ?? entry;
        const name = item.name ?? '';
        const repoPath = name.replace(/\s*\/\s*/g, '/');
        return {
          rank: entry.position ?? index + 1,
          name: repoPath,
          url: repoPath.includes('/') ? `https://github.com/${repoPath}` : (item.url ?? ''),
          description: item.description ?? '',
          language: '',
          stars: '',
          gained: ''
        };
      }).filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item.name));
      if (items.length) return items;
    } catch { /* another JSON-LD block */ }
  }
  return [];
}

function ossInsightItems(value: string): RankingItem[] {
  const rows = (JSON.parse(value) as {
    data?: { rows?: Array<{ repo_name?: string; primary_language?: string; description?: string; stars?: string; collection_names?: string }> };
  }).data?.rows ?? [];
  const ai = /\b(ai|llm|agent|agents|claude|codex|gpt|gemini|rag|mcp|model|inference|ocr|skill|skills|vision|voice)\b/i;
  return rows.filter((row) => ai.test(`${row.repo_name} ${row.description} ${row.collection_names}`)).map((row, index) => ({
    rank: index + 1,
    name: row.repo_name ?? '',
    url: `https://github.com/${row.repo_name}`,
    description: row.description ?? '',
    language: row.primary_language ?? '',
    stars: '',
    gained: row.stars ? `+${row.stars} stars / 24h` : ''
  })).filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item.name));
}

function skillsItems(html: string): RankingItem[] {
  return [...html.matchAll(/href="\/([^"]+\/[^"]+\/[^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<span class="font-mono text-sm text-foreground">([\d.]+[KM]?)<\/span>/g)]
    .map((match, index) => ({
      rank: index + 1,
      name: strip(match[2]),
      url: `https://skills.sh/${match[1]}`,
      description: `来自 ${strip(match[3])}`,
      language: 'Skill',
      stars: '',
      gained: `${match[4]} installs`
    })).filter((item) => item.name);
}

function smitheryItems(value: string): RankingItem[] {
  const servers = (JSON.parse(value) as {
    servers?: Array<{ qualifiedName?: string; displayName?: string; description?: string; useCount?: number; homepage?: string }>;
  }).servers ?? [];
  return servers.map((server, index) => ({
    rank: index + 1,
    name: server.displayName || server.qualifiedName || '',
    url: server.homepage || `https://smithery.ai/servers/${server.qualifiedName}`,
    description: server.description ?? '',
    language: 'MCP',
    stars: '',
    gained: typeof server.useCount === 'number' ? `${server.useCount.toLocaleString('en-US')} uses` : ''
  })).filter((item) => item.name);
}

function huggingFaceItems(value: string): RankingItem[] {
  const rows = (JSON.parse(value) as {
    recentlyTrending?: Array<{ repoData?: { id?: string; pipeline_tag?: string; downloads?: number; likes?: number } }>;
  }).recentlyTrending ?? [];
  return rows.map(({ repoData = {} }, index) => ({
    rank: index + 1,
    name: repoData.id ?? '',
    url: `https://huggingface.co/${repoData.id}`,
    description: repoData.pipeline_tag ? `任务：${repoData.pipeline_tag}` : 'Hugging Face 热门模型',
    language: 'Model',
    stars: typeof repoData.likes === 'number' ? `${repoData.likes.toLocaleString('en-US')} likes` : '',
    gained: typeof repoData.downloads === 'number' ? `${repoData.downloads.toLocaleString('en-US')} downloads` : ''
  })).filter((item) => item.name);
}

function productHuntItems(xml: string): RankingItem[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match, index) => {
    const entry = match[1];
    const title = strip(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const url = entry.match(/<link rel="alternate"[^>]*href="([^"]+)"/)?.[1] ?? '';
    const description = strip(strip(entry.match(/<content[^>]*>[\s\S]*?&lt;p&gt;([\s\S]*?)&lt;\/p&gt;/)?.[1] ?? ''));
    return { rank: index + 1, name: title, url, description, language: 'AI Product', stars: '', gained: 'New launch' };
  }).filter((item) => item.name && item.url);
}

function artificialAnalysisItems(html: string): RankingItem[] {
  const rows = [...html.matchAll(/\{\\"id\\":\\"[^"]+\\",\\"name\\":\\"([^"]+)\\",\\"shortName\\":\\"[^"]*\\",\\"slug\\":\\"([^"]+)\\"[\s\S]*?\\"deprecated\\":(true|false)[\s\S]*?\\"modelCreatorName\\":\\"([^"]+)\\"[\s\S]*?\\"intelligenceIndex\\":(null|[\d.]+)[\s\S]*?\\"price1mBlended0To3To1\\":(null|[\d.]+)[\s\S]*?\\"medianOutputTokensPerSecond\\":(null|[\d.]+)/g)]
    .map((match) => ({
      name: match[1],
      slug: match[2],
      deprecated: match[3] === 'true',
      creator: match[4],
      intelligence: match[5] === 'null' ? null : Number(match[5]),
      price: match[6] === 'null' ? null : Number(match[6]),
      speed: match[7] === 'null' ? null : Number(match[7])
    }))
    .filter((item) => !item.deprecated && item.intelligence !== null)
    .sort((a, b) => (b.intelligence ?? 0) - (a.intelligence ?? 0))
    .slice(0, 30);
  return rows.map((item, index) => ({
    rank: index + 1,
    name: item.name,
    url: `https://artificialanalysis.ai/models/${item.slug}`,
    description: `${item.creator} · Intelligence Index ${item.intelligence?.toFixed(1)}`,
    language: 'LLM',
    stars: item.price === null ? '' : `$${item.price.toFixed(2)} / 1M tokens`,
    gained: item.speed === null ? '' : `${item.speed.toFixed(1)} tokens/s`
  }));
}

async function loadBoard(id: string, label: string, source: { id: string; label: string }, sourceUrl: string, parse: (html: string) => RankingItem[], requestUrl = sourceUrl): Promise<RankingBoard> {
  try {
    const response = await net.fetch(requestUrl, {
      headers: { 'user-agent': 'WeMediaBuddy/0.1' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const items = parse(await response.text()).slice(0, 30);
    if (!items.length) throw new Error('榜单当前没有可读项目');
    return { id, label, kind: 'rankings', sourceId: source.id, sourceLabel: source.label, sourceUrl, status: 'ready', items };
  } catch (error) {
    return { id, label, kind: 'rankings', sourceId: source.id, sourceLabel: source.label, sourceUrl, status: 'unavailable', error: error instanceof Error ? error.message : String(error), items: [] };
  }
}

const SOURCES = {
  github: { id: 'github', label: 'GitHub' },
  whatstrending: { id: 'whatstrending', label: 'WhatsTrending' },
  ossinsight: { id: 'ossinsight', label: 'OSSInsight' },
  trendingrepo: { id: 'trendingrepo', label: 'TrendingRepo' },
  skills: { id: 'skills', label: 'skills.sh' },
  smithery: { id: 'smithery', label: 'Smithery' },
  huggingface: { id: 'huggingface', label: 'Hugging Face' },
  producthunt: { id: 'producthunt', label: 'Product Hunt' },
  artificialanalysis: { id: 'artificialanalysis', label: 'Artificial Analysis' }
} as const;

let cached: { expiresAt: number; value: GitHubRankings } | null = null;

export async function getGitHubRankings(refresh = false): Promise<GitHubRankings> {
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const boards = await Promise.all([
    // GitHub has no official Trending API; these three preserve the public page's ranking semantics.
    loadBoard('github-daily', '今日', SOURCES.github, 'https://github.com/trending?since=daily', githubItems),
    loadBoard('github-weekly', '本周', SOURCES.github, 'https://github.com/trending?since=weekly', githubItems),
    loadBoard('github-monthly', '本月', SOURCES.github, 'https://github.com/trending?since=monthly', githubItems),
    loadBoard('ai-growth', 'AI 增长榜', SOURCES.whatstrending, 'https://whatstrending.ai/repos', whatsTrendingApiItems, 'https://whatstrending.ai/api/repos'),
    loadBoard('ossinsight-ai', 'AI 趋势', SOURCES.ossinsight, 'https://ossinsight.io/trending/ai', ossInsightItems, 'https://api.ossinsight.io/v1/trends/repos/?period=past_24_hours&language=All'),
    // TrendingRepo advertises API access as Pro; its public JSON-LD is the available read-only source.
    loadBoard('trendingrepo-ai', 'AI/ML 榜', SOURCES.trendingrepo, 'https://trendingrepo.com/categories/ai-ml', itemListItems),
    // skills.sh's documented API requires Vercel OIDC; its public leaderboards remain readable.
    loadBoard('skills-all-time', '总榜', SOURCES.skills, 'https://www.skills.sh/', skillsItems),
    loadBoard('skills-trending', '24h 趋势', SOURCES.skills, 'https://www.skills.sh/trending', skillsItems),
    loadBoard('skills-hot', 'Hot 榜', SOURCES.skills, 'https://www.skills.sh/hot', skillsItems),
    loadBoard('smithery-mcp', 'MCP 使用榜', SOURCES.smithery, 'https://smithery.ai/', smitheryItems, 'https://registry.smithery.ai/servers?pageSize=30'),
    loadBoard('huggingface-models', '模型趋势', SOURCES.huggingface, 'https://huggingface.co/models?other=trending', huggingFaceItems, 'https://huggingface.co/api/trending?type=model'),
    // Product Hunt's GraphQL API requires OAuth; its official AI Atom feed is public and ordered by the source.
    loadBoard('producthunt-ai', 'AI 新产品', SOURCES.producthunt, 'https://www.producthunt.com/topics/artificial-intelligence', productHuntItems, 'https://www.producthunt.com/feed?category=artificial-intelligence'),
    // Artificial Analysis's API requires a key; its public leaderboard embeds the same current model data.
    loadBoard('model-benchmark', '模型能力榜', SOURCES.artificialanalysis, 'https://artificialanalysis.ai/leaderboards/models', artificialAnalysisItems)
  ]);
  const value = { fetchedAt: new Date().toISOString(), boards };
  // 全部可读才缓存 1 小时;有榜单暂不可读时只缓存 5 分钟,避免一次网络抖动被缓存放大成一小时不可用。
  const allReady = boards.every((board) => board.status === 'ready');
  cached = { expiresAt: Date.now() + (allReady ? 60 : 5) * 60_000, value };
  return value;
}

export const rankingParsers = {
  githubItems, whatsTrendingApiItems, itemListItems, ossInsightItems, skillsItems,
  smitheryItems, huggingFaceItems, productHuntItems, artificialAnalysisItems
};
import { net } from 'electron';
