import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type PiChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  status?: 'streaming' | 'stopped' | 'failed';
};

export type PiConversationSnapshot = {
  sessionFile: string;
  sessionId: string | null;
  messages: PiChatMessage[];
  updatedAt: string;
};

function conversationPath(dataRootPath: string): string {
  return path.join(dataRootPath, 'pi-agent', 'conversation.json');
}

export function sessionFilePath(dataRootPath: string): string {
  return path.join(dataRootPath, 'pi-agent', 'sessions', 'dock.jsonl');
}

export async function ensurePiConversationLayout(dataRootPath: string): Promise<{ agentDir: string; sessionFile: string; workspace: string }> {
  const agentDir = path.join(dataRootPath, 'pi-agent');
  const sessionDir = path.join(agentDir, 'sessions');
  const workspace = path.join(agentDir, 'workspace');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { agentDir, sessionFile: path.join(sessionDir, 'dock.jsonl'), workspace };
}

export async function readPiConversation(dataRootPath: string): Promise<PiConversationSnapshot> {
  const sessionFile = sessionFilePath(dataRootPath);
  try {
    const raw = JSON.parse(await readFile(conversationPath(dataRootPath), 'utf8')) as Partial<PiConversationSnapshot>;
    const messages = Array.isArray(raw.messages)
      ? raw.messages
        .filter((message): message is PiChatMessage => Boolean(message)
          && (message.role === 'user' || message.role === 'assistant')
          && typeof message.text === 'string')
        .map((message) => ({
          role: message.role,
          text: message.text,
          ...(message.status ? { status: message.status } : {})
        }))
      : [];
    return {
      sessionFile: typeof raw.sessionFile === 'string' ? raw.sessionFile : sessionFile,
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
      messages,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString()
    };
  } catch {
    return { sessionFile, sessionId: null, messages: [], updatedAt: new Date(0).toISOString() };
  }
}

export async function writePiConversation(
  dataRootPath: string,
  input: { sessionFile: string; sessionId?: string | null; messages: PiChatMessage[] }
): Promise<PiConversationSnapshot> {
  const snapshot: PiConversationSnapshot = {
    sessionFile: input.sessionFile,
    sessionId: input.sessionId ?? null,
    messages: input.messages.map((message) => ({
      role: message.role,
      text: message.text,
      ...(message.status ? { status: message.status } : {})
    })),
    updatedAt: new Date().toISOString()
  };
  await mkdir(path.dirname(conversationPath(dataRootPath)), { recursive: true });
  await writeFile(conversationPath(dataRootPath), JSON.stringify(snapshot), 'utf8');
  return snapshot;
}
