import * as vscode from 'vscode';
import {
  AskUserAnswer,
  AskUserRequest,
  PermissionDecision,
  PermissionRequest,
  Plan,
  PlanDecision
} from '../core/types';
import { UiItem } from '../ui/protocol';
import { ConfigManager, cfg } from './config';
import { PreviewDocumentProvider } from './preview';
import { log } from '../util/logger';

export interface ApprovalPresenter {
  postItem(item: UiItem): void;
  patchItem(id: string, patch: Partial<UiItem>): void;
  reveal(): Promise<void> | void;
  toast(message: string, level?: 'info' | 'warn' | 'ok'): void;
  isVisible(): boolean;
}

interface Pending<T> {
  id: string;
  kind: 'permission' | 'plan' | 'ask';
  resolve: (value: T) => void;
  post?: UiItem;
}

type AnyPending = Pending<PermissionDecision | PlanDecision | AskUserAnswer>;

/**
 * Central approval gate: everything that writes to disk or runs a command passes through here,
 * so the user always sees the checklists/plans/diffs before the agent acts.
 */
export class ApprovalManager implements vscode.Disposable {
  private readonly pending = new Map<string, AnyPending>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly config: ConfigManager,
    private readonly presenter: ApprovalPresenter,
    private readonly preview: PreviewDocumentProvider
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  // ------------------------------------------------------------------ permissions

  async requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const decision = this.policy(request);
    if (decision) {
      return decision;
    }

    if (request.preview && cfg().get<boolean>('showDiffOnWrite', true)) {
      // Remember the proposed content so the "Show diff" button can render it.
      this.preview.set(request.id, request.preview.after);
    }

    const style = cfg().get<'chat' | 'modal'>('approvalStyle', 'chat');
    return style === 'modal' ? this.modalPermission(request) : this.chatPermission(request);
  }

  private policy(request: PermissionRequest): PermissionDecision | undefined {
    if (request.kind === 'read') {
      return this.config.autoApproveRead ? { allowed: true } : undefined;
    }
    if (request.kind === 'write') {
      if (this.config.autoApproveWrite) {
        return { allowed: true };
      }
      return undefined;
    }
    if (request.kind === 'exec') {
      const command = request.command ?? '';
      const denied = this.config.commandDenylist.find((pattern) => pattern && command.toLowerCase().includes(pattern.toLowerCase()));
      if (denied) {
        return { allowed: false, reason: `blocked by agentcode.commandDenylist ("${denied}")` };
      }
      if (this.config.autoApproveCommands) {
        return { allowed: true };
      }
      const allowed = this.config.commandAllowlist.find((pattern) => pattern && command.trim().toLowerCase().startsWith(pattern.toLowerCase()));
      if (allowed) {
        return { allowed: true };
      }
      return undefined;
    }
    return { allowed: true };
  }

  private chatPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const item: UiItem = { kind: 'permission', id: request.id, request, ts: Date.now() };
    this.presenter.postItem(item);
    if (!this.presenter.isVisible()) {
      void this.presenter.reveal();
      const label = request.kind === 'exec' ? 'AM Code wants to run a command' : 'AM Code wants to change files';
      void vscode.window.showInformationMessage(`${label}: ${request.title}`, 'Review in chat').then((picked) => {
        if (picked === 'Review in chat') {
          void this.presenter.reveal();
        }
      });
    }
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.id, {
        id: request.id,
        kind: 'permission',
        resolve: resolve as (value: PermissionDecision | PlanDecision | AskUserAnswer) => void,
        post: item
      });
    });
  }

  private async modalPermission(request: PermissionRequest): Promise<PermissionDecision> {
    const detail =
      request.kind === 'exec'
        ? `Command:\n${request.command ?? ''}`
        : request.preview
          ? `File: ${request.preview.path}\n\n${request.detail.slice(0, 1500)}`
          : request.detail.slice(0, 1500);
    const buttons = request.kind === 'exec'
      ? ['Approve', 'Approve & always allow these', 'Reject']
      : ['Approve', 'Approve all writes this session', 'Reject'];
    const picked = await vscode.window.showWarningMessage(
      `AM Code — ${request.title}`,
      { modal: true, detail: detail || undefined },
      ...buttons
    );
    if (picked === buttons[0]) {
      return { allowed: true };
    }
    if (picked === buttons[1]) {
      return { allowed: true, remember: true };
    }
    return { allowed: false, reason: 'rejected in the permission dialog' };
  }

  // ------------------------------------------------------------------ plan approval

  async approvePlan(planId: string, plan: Plan): Promise<PlanDecision> {
    const item: UiItem = { kind: 'plan', id: planId, plan, ts: Date.now() };
    this.presenter.postItem(item);
    if (!this.presenter.isVisible()) {
      await this.presenter.reveal();
      void vscode.window
        .showInformationMessage('AM Code — the plan is ready for review.', 'Approve plan', 'Open chat')
        .then((picked) => {
          if (picked === 'Approve plan') {
            void this.respond(planId, { approved: true, feedback: undefined });
          } else if (picked === 'Open chat') {
            void this.presenter.reveal();
          }
        });
    }
    return new Promise<PlanDecision>((resolve) => {
      this.pending.set(planId, {
        id: planId,
        kind: 'plan',
        resolve: resolve as (value: PermissionDecision | PlanDecision | AskUserAnswer) => void,
        post: item
      });
    });
  }

  // ------------------------------------------------------------------ questions

  async askUser(request: AskUserRequest): Promise<AskUserAnswer> {
    const item: UiItem = { kind: 'ask', id: request.id, request, ts: Date.now() };
    this.presenter.postItem(item);
    await this.presenter.reveal();
    if (request.options?.length) {
      void vscode.window.showQuickPick(request.options, { title: 'AM Code asks', ignoreFocusOut: true }).then((picked) => {
        if (picked) {
          void this.respond(request.id, { answer: picked });
        }
      });
    }
    return new Promise<AskUserAnswer>((resolve) => {
      this.pending.set(request.id, {
        id: request.id,
        kind: 'ask',
        resolve: resolve as (value: PermissionDecision | PlanDecision | AskUserAnswer) => void,
        post: item
      });
    });
  }

  // ------------------------------------------------------------------ responses from the UI

  respond(id: string, payload: unknown): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    if (entry.kind === 'permission') {
      const decision = payload as PermissionDecision;
      if (decision.remember) {
        if (entry.post && entry.post.kind === 'permission' && entry.post.request.kind === 'write') {
          void cfg().update('autoApproveWrite', true, vscode.ConfigurationTarget.Workspace);
          this.presenter.toast('File writes are now auto-approved for this workspace.', 'warn');
        } else if (entry.post && entry.post.kind === 'permission' && entry.post.request.kind === 'exec') {
          const command = entry.post.request.command?.split(/\s+/)[0];
          if (command) {
            const list = this.config.commandAllowlist;
            if (!list.includes(command)) {
              void cfg().update('commandAllowlist', [...list, command], vscode.ConfigurationTarget.Workspace);
            }
          }
        }
      }
      this.presenter.patchItem(id, { decision: { allowed: decision.allowed, remember: decision.remember } } as Partial<UiItem>);
      (entry.resolve as (value: PermissionDecision) => void)({ allowed: Boolean(decision.allowed), remember: decision.remember });
      return true;
    }
    if (entry.kind === 'plan') {
      const decision = payload as PlanDecision;
      this.presenter.patchItem(id, { decision: { approved: decision.approved, feedback: decision.feedback } } as Partial<UiItem>);
      (entry.resolve as (value: PlanDecision) => void)(decision);
      return true;
    }
    const answer = payload as AskUserAnswer;
    this.presenter.patchItem(id, { answer: answer.cancelled ? '(dismissed)' : answer.answer } as Partial<UiItem>);
    (entry.resolve as (value: AskUserAnswer) => void)(answer);
    return true;
  }

  /** Called when the user hits Stop: every open question resolves as "not allowed". */
  cancelAll(reason = 'the user stopped the agent'): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.id);
      log(`cancelling pending ${entry.kind} ${entry.id}`);
      if (entry.kind === 'permission') {
        (entry.resolve as (value: PermissionDecision) => void)({ allowed: false, reason });
      } else if (entry.kind === 'plan') {
        (entry.resolve as (value: PlanDecision) => void)({ approved: false, feedback: reason });
      } else {
        (entry.resolve as (value: AskUserAnswer) => void)({ answer: '', cancelled: true });
      }
    }
  }

  dispose(): void {
    this.cancelAll('extension disposed');
    this.disposables.forEach((d) => d.dispose());
  }
}
