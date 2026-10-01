import * as vscode from 'vscode';
import { AgentSession, SessionSnapshot } from '../core/session';

const KEY = 'agentcode.sessions.v1';
const ACTIVE_KEY = 'agentcode.activeSessionId';
const MAX_SESSIONS = 40;

export class SessionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): SessionSnapshot[] {
    const all = this.context.globalState.get<SessionSnapshot[]>(KEY, []);
    return Array.isArray(all) ? all : [];
  }

  save(session: AgentSession): void {
    const snapshot = session.toSnapshot();
    const all = this.list().filter((s) => s.id !== snapshot.id);
    all.unshift(snapshot);
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    void this.context.globalState.update(KEY, all.slice(0, MAX_SESSIONS));
    void this.context.workspaceState.update(ACTIVE_KEY, snapshot.id);
  }

  loadActive(): AgentSession | undefined {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY);
    if (!id) {
      return undefined;
    }
    const snapshot = this.list().find((s) => s.id === id);
    return snapshot ? AgentSession.fromSnapshot(snapshot) : undefined;
  }

  delete(id: string): void {
    void this.context.globalState.update(KEY, this.list().filter((s) => s.id !== id));
  }

  clearAll(): void {
    void this.context.globalState.update(KEY, []);
    void this.context.workspaceState.update(ACTIVE_KEY, undefined);
  }
}
