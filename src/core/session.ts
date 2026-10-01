import { AgentMode, ChatMessage, EditRecord, Plan, Usage } from './types';
import { TodoList } from './todos';

export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  messages: ChatMessage[];
  todos: ReturnType<TodoList['toJSON']>;
  approvedPlan?: Plan;
  usage: Usage;
  edits: EditRecord[];
}

export class AgentSession {
  readonly id: string;
  title = 'New session';
  createdAt = Date.now();
  updatedAt = Date.now();
  mode: AgentMode;
  messages: ChatMessage[] = [];
  todos = new TodoList();
  approvedPlan?: Plan;
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  /** Undo stack (newest last); capped. */
  edits: EditRecord[] = [];
  /** Steps consumed by the last turn (for the status bar). */
  lastSteps = 0;

  constructor(mode: AgentMode = 'build', id?: string) {
    this.mode = mode;
    this.id = id ?? `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  addEdit(edit: EditRecord): void {
    this.edits.push(edit);
    if (this.edits.length > 200) {
      this.edits.splice(0, this.edits.length - 200);
    }
    this.touch();
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  setTitleFromPrompt(prompt: string): void {
    const clean = prompt.replace(/\s+/g, ' ').trim();
    this.title = clean.length > 60 ? `${clean.slice(0, 57)}…` : clean || 'New session';
  }

  /** Auto-title after the first exchange, when the model produced a summary. */
  clear(): void {
    this.messages = [];
    this.todos.clear();
    this.approvedPlan = undefined;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.edits = [];
    this.touch();
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      mode: this.mode,
      messages: this.messages,
      todos: this.todos.toJSON(),
      approvedPlan: this.approvedPlan,
      usage: this.usage,
      edits: this.edits.slice(-50)
    };
  }

  static fromSnapshot(snap: SessionSnapshot): AgentSession {
    const session = new AgentSession(snap.mode ?? 'build', snap.id);
    session.title = snap.title ?? 'Session';
    session.createdAt = snap.createdAt ?? Date.now();
    session.updatedAt = snap.updatedAt ?? Date.now();
    session.messages = Array.isArray(snap.messages) ? snap.messages : [];
    session.todos = TodoList.fromJSON(snap.todos);
    session.approvedPlan = snap.approvedPlan;
    session.usage = snap.usage ?? { inputTokens: 0, outputTokens: 0 };
    session.edits = Array.isArray(snap.edits) ? snap.edits : [];
    return session;
  }
}
