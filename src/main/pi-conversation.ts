import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installPiOperatorSkill, installPiWorkspaceLaneSkill } from './pi-operator-skill.ts';
import type { PiMessageSegment } from '../shared/pi-message.ts';
import { messagesFromPiEntries } from './pi-transcript-projection.ts';

export type PiChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  segments?: PiMessageSegment[];
  entryId?: string;
  status?: 'streaming' | 'stopped' | 'failed';
  createdAt?: string;
};

export type PiConversationSnapshot = {
  id: string;
  title: string;
  sessionFile: string;
  sessionId: string | null;
  messages: PiChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type PiConversationSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

type PiConversationIndex = {
  activeId: string | null;
  conversations: Array<{
    id: string;
    title: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
  }>;
};

function agentDir(dataRootPath: string): string {
  return path.join(dataRootPath, 'pi-agent');
}

function conversationsDir(dataRootPath: string): string {
  return path.join(agentDir(dataRootPath), 'conversations');
}

function sessionsDir(dataRootPath: string): string {
  return path.join(agentDir(dataRootPath), 'sessions');
}

function indexPath(dataRootPath: string): string {
  return path.join(conversationsDir(dataRootPath), 'index.json');
}

function conversationFilePath(dataRootPath: string, id: string): string {
  return path.join(conversationsDir(dataRootPath), `${id}.json`);
}

function legacyConversationPath(dataRootPath: string): string {
  return path.join(agentDir(dataRootPath), 'conversation.json');
}

export function sessionFilePath(dataRootPath: string, id?: string): string {
  if (id) return path.join(sessionsDir(dataRootPath), `${id}.jsonl`);
  return path.join(sessionsDir(dataRootPath), 'dock.jsonl');
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeMessage(message: PiChatMessage, fallbackCreatedAt?: string): PiChatMessage {
  return {
    role: message.role,
    text: message.text,
    ...(message.thinking && message.thinking.trim() ? { thinking: message.thinking } : {}),
    ...(Array.isArray(message.segments) && message.segments.length ? { segments: message.segments } : {}),
    ...(message.entryId ? { entryId: message.entryId } : {}),
    ...(message.status ? { status: message.status } : {}),
    ...(message.createdAt || fallbackCreatedAt ? { createdAt: message.createdAt ?? fallbackCreatedAt } : {})
  };
}

function titleFromMessages(messages: PiChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && message.text.trim());
  if (!firstUser) return '新会话';
  const compact = firstUser.text.replace(/\s+/g, ' ').trim();
  return compact.length > 28 ? `${compact.slice(0, 28)}…` : compact;
}

function previewFromMessages(messages: PiChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i]?.text?.replace(/\s+/g, ' ').trim();
    if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  }
  return '暂无消息';
}

function emptyIndex(): PiConversationIndex {
  return { activeId: null, conversations: [] };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readIndex(dataRootPath: string): Promise<PiConversationIndex> {
  try {
    const raw = JSON.parse(await readFile(indexPath(dataRootPath), 'utf8')) as Partial<PiConversationIndex>;
    const conversations = Array.isArray(raw.conversations)
      ? raw.conversations
        .filter((item): item is PiConversationIndex['conversations'][number] => Boolean(item)
          && typeof item.id === 'string'
          && typeof item.title === 'string'
          && typeof item.updatedAt === 'string')
        .map((item) => ({
          id: item.id,
          title: item.title || '新会话',
          preview: typeof item.preview === 'string' ? item.preview : '暂无消息',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : item.updatedAt,
          updatedAt: item.updatedAt
        }))
      : [];
    const activeId = typeof raw.activeId === 'string' ? raw.activeId : null;
    return {
      activeId: activeId && conversations.some((item) => item.id === activeId) ? activeId : (conversations[0]?.id ?? null),
      conversations
    };
  } catch {
    return emptyIndex();
  }
}

async function writeIndex(dataRootPath: string, index: PiConversationIndex): Promise<void> {
  await mkdir(conversationsDir(dataRootPath), { recursive: true });
  await writeFile(indexPath(dataRootPath), JSON.stringify(index, null, 2), 'utf8');
}

async function readConversationFile(dataRootPath: string, id: string): Promise<PiConversationSnapshot | null> {
  try {
    const raw = JSON.parse(await readFile(conversationFilePath(dataRootPath, id), 'utf8')) as Partial<PiConversationSnapshot>;
    if (typeof raw.id !== 'string') return null;
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso();
    let messages = Array.isArray(raw.messages)
      ? raw.messages
        .filter((message): message is PiChatMessage => Boolean(message)
          && (message.role === 'user' || message.role === 'assistant')
          && typeof message.text === 'string')
        .map((message) => normalizeMessage(message, updatedAt))
      : [];
    if (messages.some((message) => message.role === 'assistant') && !messages.some((message) => message.segments?.length) && typeof raw.sessionFile === 'string') {
      try {
        const entries = (await readFile(raw.sessionFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
        const projected = messagesFromPiEntries(entries);
        if (projected.length) messages = projected;
      } catch { /* keep the stored snapshot when the Pi session is unavailable */ }
    }
    return {
      id: raw.id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : titleFromMessages(messages),
      sessionFile: typeof raw.sessionFile === 'string' ? raw.sessionFile : sessionFilePath(dataRootPath, raw.id),
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      messages,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : updatedAt,
      updatedAt
    };
  } catch {
    return null;
  }
}

async function writeConversationFile(dataRootPath: string, snapshot: PiConversationSnapshot): Promise<PiConversationSnapshot> {
  await mkdir(conversationsDir(dataRootPath), { recursive: true });
  await mkdir(path.dirname(snapshot.sessionFile), { recursive: true });
  const normalized: PiConversationSnapshot = {
    ...snapshot,
    title: snapshot.title.trim() || titleFromMessages(snapshot.messages),
    messages: snapshot.messages.map((message) => normalizeMessage(message, snapshot.updatedAt))
  };
  await writeFile(conversationFilePath(dataRootPath, normalized.id), JSON.stringify(normalized, null, 2), 'utf8');
  // Keep legacy active pointer for older readers / diagnostics.
  await writeFile(legacyConversationPath(dataRootPath), JSON.stringify({
    id: normalized.id,
    title: normalized.title,
    sessionFile: normalized.sessionFile,
    sessionId: normalized.sessionId,
    messages: normalized.messages,
    updatedAt: normalized.updatedAt
  }, null, 2), 'utf8');
  return normalized;
}

async function upsertIndexEntry(dataRootPath: string, snapshot: PiConversationSnapshot, makeActive = true): Promise<void> {
  const index = await readIndex(dataRootPath);
  const entry = {
    id: snapshot.id,
    title: snapshot.title,
    preview: previewFromMessages(snapshot.messages),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt
  };
  const others = index.conversations.filter((item) => item.id !== snapshot.id);
  const conversations = [entry, ...others].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await writeIndex(dataRootPath, {
    activeId: makeActive ? snapshot.id : (index.activeId === snapshot.id ? snapshot.id : index.activeId),
    conversations
  });
}

async function migrateLegacyConversation(dataRootPath: string): Promise<PiConversationSnapshot | null> {
  try {
    const raw = JSON.parse(await readFile(legacyConversationPath(dataRootPath), 'utf8')) as Partial<PiConversationSnapshot> & {
      messages?: PiChatMessage[];
    };
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso();
    const messages = Array.isArray(raw.messages)
      ? raw.messages
        .filter((message): message is PiChatMessage => Boolean(message)
          && (message.role === 'user' || message.role === 'assistant')
          && typeof message.text === 'string')
        .map((message) => normalizeMessage(message, updatedAt))
      : [];
    if (!messages.length && !(typeof raw.sessionId === 'string' && raw.sessionId)) {
      // Empty legacy file: still create a clean active conversation if none exists.
    }
    const id = typeof raw.id === 'string' && raw.id ? raw.id : randomUUID();
    const legacySession = typeof raw.sessionFile === 'string' ? raw.sessionFile : sessionFilePath(dataRootPath);
    const targetSession = sessionFilePath(dataRootPath, id);
    if (legacySession !== targetSession && await pathExists(legacySession)) {
      try { await rename(legacySession, targetSession); } catch { /* keep target if rename fails */ }
    }
    if (!(await pathExists(targetSession))) await writeFile(targetSession, '', 'utf8');
    const snapshot: PiConversationSnapshot = {
      id,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : titleFromMessages(messages),
      sessionFile: targetSession,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      messages,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : updatedAt,
      updatedAt
    };
    await writeConversationFile(dataRootPath, snapshot);
    await upsertIndexEntry(dataRootPath, snapshot, true);
    return snapshot;
  } catch {
    return null;
  }
}

async function ensureActiveConversation(dataRootPath: string): Promise<PiConversationSnapshot> {
  await ensurePiConversationLayout(dataRootPath);
  const index = await readIndex(dataRootPath);
  if (index.activeId) {
    const existing = await readConversationFile(dataRootPath, index.activeId);
    if (existing) return existing;
  }
  if (index.conversations[0]) {
    const existing = await readConversationFile(dataRootPath, index.conversations[0].id);
    if (existing) {
      await writeIndex(dataRootPath, { ...index, activeId: existing.id });
      return existing;
    }
  }
  const migrated = await migrateLegacyConversation(dataRootPath);
  if (migrated) return migrated;
  return startNewPiConversation(dataRootPath);
}

export async function ensurePiConversationLayout(dataRootPath: string): Promise<{ agentDir: string; sessionFile: string; workspace: string }> {
  const root = agentDir(dataRootPath);
  const sessionDir = sessionsDir(dataRootPath);
  const workspace = path.join(root, 'workspace');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(conversationsDir(dataRootPath), { recursive: true });
  await installPiOperatorSkill(root);
  await installPiWorkspaceLaneSkill(dataRootPath, root);

  // Prefer active conversation session file when available.
  try {
    const index = await readIndex(dataRootPath);
    if (index.activeId) {
      const active = await readConversationFile(dataRootPath, index.activeId);
      if (active?.sessionFile) {
        return { agentDir: root, sessionFile: active.sessionFile, workspace };
      }
    }
  } catch { /* fall through */ }

  return { agentDir: root, sessionFile: sessionFilePath(dataRootPath), workspace };
}

export async function readPiConversation(dataRootPath: string): Promise<PiConversationSnapshot> {
  return ensureActiveConversation(dataRootPath);
}

export async function listPiConversations(dataRootPath: string): Promise<PiConversationSummary[]> {
  await ensureActiveConversation(dataRootPath);
  const index = await readIndex(dataRootPath);
  return index.conversations.map((item) => ({
    ...item,
    active: item.id === index.activeId
  }));
}

export async function writePiConversation(
  dataRootPath: string,
  input: {
    id?: string;
    title?: string;
    sessionFile: string;
    sessionId?: string | null;
    messages: PiChatMessage[];
    createdAt?: string;
    makeActive?: boolean;
  }
): Promise<PiConversationSnapshot> {
  const current = input.id
    ? await readConversationFile(dataRootPath, input.id)
    : await ensureActiveConversation(dataRootPath);
  const id = input.id ?? current?.id ?? randomUUID();
  const createdAt = input.createdAt ?? current?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const messages = input.messages.map((message) => normalizeMessage(message, updatedAt));
  const snapshot: PiConversationSnapshot = {
    id,
    title: input.title?.trim() || current?.title || titleFromMessages(messages),
    sessionFile: input.sessionFile || current?.sessionFile || sessionFilePath(dataRootPath, id),
    sessionId: input.sessionId ?? current?.sessionId ?? null,
    messages,
    createdAt,
    updatedAt
  };
  if (!snapshot.title || snapshot.title === '新会话') snapshot.title = titleFromMessages(messages);
  const saved = await writeConversationFile(dataRootPath, snapshot);
  await upsertIndexEntry(dataRootPath, saved, input.makeActive ?? true);
  return saved;
}

export async function createForkedPiConversation(
  dataRootPath: string,
  input: {
    sessionFile: string;
    sessionId?: string | null;
    messages: PiChatMessage[];
  }
): Promise<PiConversationSnapshot> {
  const createdAt = nowIso();
  const snapshot: PiConversationSnapshot = {
    id: randomUUID(),
    title: titleFromMessages(input.messages),
    sessionFile: input.sessionFile,
    sessionId: input.sessionId ?? null,
    messages: input.messages,
    createdAt,
    updatedAt: createdAt
  };
  const saved = await writeConversationFile(dataRootPath, snapshot);
  await upsertIndexEntry(dataRootPath, saved, true);
  return saved;
}

export async function startNewPiConversation(dataRootPath: string): Promise<PiConversationSnapshot> {
  await ensurePiConversationLayout(dataRootPath);

  const id = randomUUID();
  const createdAt = nowIso();
  const sessionFile = sessionFilePath(dataRootPath, id);
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, '', 'utf8');
  const snapshot: PiConversationSnapshot = {
    id,
    title: '新会话',
    sessionFile,
    sessionId: null,
    messages: [],
    createdAt,
    updatedAt: createdAt
  };
  const saved = await writeConversationFile(dataRootPath, snapshot);
  await upsertIndexEntry(dataRootPath, saved, true);
  return saved;
}

export async function switchPiConversation(dataRootPath: string, conversationId: string): Promise<PiConversationSnapshot> {
  await ensurePiConversationLayout(dataRootPath);
  const target = await readConversationFile(dataRootPath, conversationId);
  if (!target) throw new Error('会话不存在。');
  const index = await readIndex(dataRootPath);
  await writeIndex(dataRootPath, { ...index, activeId: target.id });
  // Refresh legacy active pointer.
  await writeConversationFile(dataRootPath, target);
  await upsertIndexEntry(dataRootPath, target, true);
  return target;
}
