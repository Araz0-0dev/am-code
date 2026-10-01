import { Todo, TodoStatus } from './types';

const STATUS_ORDER: Record<TodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3
};

/**
 * The agent's task checklist ("task bandi"). Mirrors Claude Code's TodoWrite behaviour:
 * the full list is re-sent on every update, statuses are normalised, and the rendered
 * markdown is injected into the model context on every step so it can never "forget".
 */
export class TodoList {
  private items: Todo[] = [];

  get all(): Todo[] {
    return this.items;
  }

  get length(): number {
    return this.items.length;
  }

  set(raw: unknown): Todo[] {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    this.items = list.map((entry, index) => {
      const t = (entry ?? {}) as Partial<Todo> & { status?: string };
      let id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `t${index + 1}`;
      while (seen.has(id)) {
        id = `${id}_`;
      }
      seen.add(id);
      return {
        id,
        content: String(t.content ?? '').trim() || `Task ${index + 1}`,
        status: normalizeStatus(t.status),
        note: t.note ? String(t.note) : undefined
      };
    });
    // keep a stable order: in-progress first is *not* what we want for rendering,
    // callers keep insertion order; we only sort for statistics.
    return this.items;
  }

  updateStatus(id: string, status: TodoStatus, note?: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) {
      return false;
    }
    item.status = status;
    if (note !== undefined) {
      item.note = note;
    }
    return true;
  }

  add(content: string): Todo {
    const id = `t${this.items.length + 1}`;
    const item: Todo = { id, content, status: 'pending' };
    this.items.push(item);
    return item;
  }

  clear(): void {
    this.items = [];
  }

  stats(): { total: number; completed: number; pending: number; inProgress: number; cancelled: number } {
    return {
      total: this.items.length,
      completed: this.items.filter((i) => i.status === 'completed').length,
      pending: this.items.filter((i) => i.status === 'pending').length,
      inProgress: this.items.filter((i) => i.status === 'in_progress').length,
      cancelled: this.items.filter((i) => i.status === 'cancelled').length
    };
  }

  /** Items that still block task completion. */
  unfinished(): Todo[] {
    return this.items.filter((i) => i.status === 'pending' || i.status === 'in_progress');
  }

  isComplete(): boolean {
    return this.items.length > 0 && this.unfinished().length === 0;
  }

  nextPending(): Todo | undefined {
    const sorted = [...this.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    return sorted.find((i) => i.status === 'pending' || i.status === 'in_progress');
  }

  /** Markdown checklist rendered for the model + the chat UI. */
  toMarkdown(): string {
    if (this.items.length === 0) {
      return '(no checklist yet)';
    }
    return this.items
      .map((t) => {
        const box = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' ';
        const suffix = t.status === 'cancelled' ? ' (cancelled)' : '';
        const note = t.note ? ` — ${t.note}` : '';
        return `- [${box}] ${t.id}. ${t.content}${suffix}${note}`;
      })
      .join('\n');
  }

  /** Plain progress bar text, e.g. "3/7". */
  progressLabel(): string {
    const s = this.stats();
    return `${s.completed}/${s.total}`;
  }

  toJSON(): Todo[] {
    return this.items.map((i) => ({ ...i }));
  }

  static fromJSON(json: unknown): TodoList {
    const list = new TodoList();
    if (Array.isArray(json)) {
      list.set(json);
    }
    return list;
  }
}

function normalizeStatus(status: unknown): TodoStatus {
  switch (String(status ?? '').toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'in-progress':
    case 'inprogress':
    case 'working':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
    case 'skipped':
      return 'cancelled';
    case 'pending':
    case 'todo':
    case 'not_started':
    default:
      return 'pending';
  }
}
