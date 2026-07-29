import { readPiConversation, writePiConversation, type PiChatMessage } from './pi-conversation';
import type { PiRpcSupervisor } from './pi-runtime';

export async function persistPiTurn(
  dataRootPath: string,
  userText: string,
  assistant: PiChatMessage,
  sessionFile: string | null,
  supervisor: PiRpcSupervisor | null
): Promise<void> {
  const current = await readPiConversation(dataRootPath);
  const stamped = new Date().toISOString();
  const messages = [
    ...current.messages,
    { role: 'user', text: userText, createdAt: stamped } satisfies PiChatMessage,
    { ...assistant, createdAt: assistant.createdAt ?? stamped }
  ];
  let sessionId = current.sessionId;
  if (supervisor) {
    try {
      const data = (await supervisor.getState()).data;
      if (data && typeof data === 'object' && 'sessionId' in data && typeof (data as { sessionId?: unknown }).sessionId === 'string') {
        sessionId = (data as { sessionId: string }).sessionId;
      }
    } catch { /* keep previous session id */ }
  }
  await writePiConversation(dataRootPath, {
    id: current.id,
    title: current.title,
    sessionFile: sessionFile ?? current.sessionFile,
    sessionId,
    messages,
    createdAt: current.createdAt
  });
}
