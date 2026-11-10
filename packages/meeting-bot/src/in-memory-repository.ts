import { isTerminalBotStatus } from "./lifecycle.js";
import type { BotSessionPatch, BotSessionRecord, BotSessionRepository } from "./types.js";

/** For unit tests and local experiments only — state is lost on restart. */
export class InMemoryBotSessionRepository implements BotSessionRepository {
  private readonly sessions = new Map<string, BotSessionRecord>();

  insert(record: BotSessionRecord): BotSessionRecord {
    this.sessions.set(record.id, { ...record });
    return { ...record };
  }

  async get(id: string): Promise<BotSessionRecord | null> {
    const record = this.sessions.get(id);
    return record ? { ...record } : null;
  }

  async update(id: string, patch: BotSessionPatch): Promise<BotSessionRecord> {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error(`Bot session ${id} not found`);
    const updated = { ...existing, ...patch };
    this.sessions.set(id, updated);
    return { ...updated };
  }

  async listNonTerminal(): Promise<BotSessionRecord[]> {
    return [...this.sessions.values()].filter((s) => !isTerminalBotStatus(s.status)).map((s) => ({ ...s }));
  }
}
