export type LibrarySection = 'saved' | 'rediscovery';

export type LibrarySourceItem = {
  id: string;
  title: string;
  originalUrl?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: string | null;
  collectedAt?: string | null;
  verificationStatus?: string;
  managementStatus?: string;
  revision?: number;
  topics?: string;
  opportunityCount?: number;
  projectCount?: number;
  publicationCount?: number;
  reason?: string;
  priority?: number;
};

export type SourceKnowledgeContext = {
  topics: Array<{ id: string; title: string }>;
  opportunities: unknown[];
  projects: unknown[];
  publications: unknown[];
  reviews: Array<{ id: string; summary?: string | null }>;
  findings: Array<{ id: string; title?: string | null; body?: string | null }>;
};

export type KnowledgeSourcePage = {
  items: LibrarySourceItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type RediscoveryItem = {
  id: string;
  title: string;
  reason?: string;
  priority?: number;
  collectedAt?: string | null;
};

export function isLibrarySection(value: string | null): value is LibrarySection {
  return value === 'saved' || value === 'rediscovery';
}

export function asSourceKnowledgeContext(value: unknown): SourceKnowledgeContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const topics = Array.isArray(record.topics) ? record.topics.filter((item): item is { id: string; title: string } => {
    if (!item || typeof item !== 'object') return false;
    const topic = item as Record<string, unknown>;
    return typeof topic.id === 'string' && typeof topic.title === 'string';
  }) : [];
  const reviews = Array.isArray(record.reviews) ? record.reviews.filter((item): item is { id: string; summary?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  const findings = Array.isArray(record.findings) ? record.findings.filter((item): item is { id: string; title?: string | null; body?: string | null } => {
    if (!item || typeof item !== 'object') return false;
    return typeof (item as Record<string, unknown>).id === 'string';
  }) : [];
  return {
    topics,
    opportunities: Array.isArray(record.opportunities) ? record.opportunities : [],
    projects: Array.isArray(record.projects) ? record.projects : [],
    publications: Array.isArray(record.publications) ? record.publications : [],
    reviews,
    findings
  };
}


