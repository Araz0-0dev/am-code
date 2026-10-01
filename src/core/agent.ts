import { describeToolsForText, newToolId, parseTextToolCalls } from './textTools';
import { estimateTokens, trimHistory } from './context';
import { CompressionStats, TokenSaverSettings, compressMessages } from './tokenSaver';
import { AgentSession } from './session';
import { RulesFile, buildSystemPrompt, truncate } from './prompts';
import { TOOL_NAMES, buildToolDefinitions, toolDefinitionMap } from './tools';
import { TodoStatus } from './types';
import type {
  AgentEvent,
  AgentMode,
  AskUserAnswer,
  AskUserRequest,
  ChatMessage,
  ModelConfig,
  PermissionDecision,
  PermissionRequest,
  Plan,
  PlanDecision,
  ProviderStreamEvent,
  ToolCall,
  ToolCallMode,
  ToolDefinition,
  ToolOutcome,
  Usage
} from './types';
import { createProvider } from './providers';

export interface AgentRunOptions {
  model: ModelConfig;
  smallModel?: ModelConfig;
  toolCallMode: ToolCallMode;
  maxSteps: number;
  /** After this many steps in one message the agent is told to wrap up. 0 disables the soft budget. */
  softStepBudget: number;
  strictChecklist: boolean;
  alwaysPlan: boolean;
  enableWebTools: boolean;
  subagents: boolean;
  customInstructions: string;
  thinkingBudgetHint: 'off' | 'low' | 'medium' | 'high';
  responseLanguage: string;
  includeOpenFileContext: boolean;
  includeDiagnostics: boolean;
  /** Squeezes every provider request (see core/tokenSaver.ts). */
  tokenSaver?: TokenSaverSettings;
}

export interface HostContext {
  rulesFiles: RulesFile[];
  activeFile?: string;
  activeSelection?: string;
  openFileList?: string[];
  diagnosticsSummary?: string;
  cwd: string;
  workspaceName: string;
  os: string;
  today: string;
}

export interface AgentHost {
  emit(event: AgentEvent): void;
  /** Executes an IO tool (files, shell, diagnostics, web). Control tools are handled by the agent. */
  executeTool(call: ToolCall, mode: AgentMode): Promise<ToolOutcome>;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  approvePlan(planId: string, plan: Plan): Promise<PlanDecision>;
  askUser(request: AskUserRequest): Promise<AskUserAnswer>;
  getApiKey(model: ModelConfig): Promise<string | undefined>;
  /** Tools contributed by MCP servers (mcp__<server>__<tool>). Resolved on every step. */
  getExtraTools?(): ToolDefinition[];
  collectContext(): Promise<HostContext>;
  getOptions(): AgentRunOptions;
  onModeChanged(mode: AgentMode): void;
  onTodosChanged(): void;
  save(): void;
}

const MAX_TOOL_RESULT_CHARS = 16000;
/** Loop guards: after this many consecutive read-only steps we warn, then we stop the turn. */
const READ_ONLY_WARN = 3;
const READ_ONLY_STOP = 8;
const SUBAGENT_MAX_STEPS = 14;

export class Agent {
  private abortController?: AbortController;
  private running = false;
  private forcedTextMode = false;
  private completionBlocks = 0;
  private planAttempts = 0;
  private nudges = 0;
  /** Consecutive read-only tool steps in the current turn (loop guard). */
  private readOnlyStreak = 0;
  private budgetNotes: string[] = [];

  constructor(
    private readonly host: AgentHost,
    public readonly session: AgentSession
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  abort(): void {
    this.abortController?.abort();
  }

  setMode(mode: AgentMode): void {
    this.session.mode = mode;
    this.host.emit({ type: 'mode', mode });
    this.host.onModeChanged(mode);
    this.host.save();
  }

  /** Main entry point: one user turn (may contain many model/tool iterations). */
  async send(userText: string, images?: string[]): Promise<void> {
    if (this.running) {
      this.host.emit({ type: 'notice', message: 'Agent is already running — stop it first.', level: 'warn' });
      return;
    }
    const text = userText.trim();
    if (!text && !images?.length) {
      return;
    }
    if (this.session.messages.filter((m) => m.role === 'user').length === 0) {
      this.session.setTitleFromPrompt(text || 'Image task');
    }
    this.session.messages.push({ role: 'user', content: text, images, ts: Date.now() });
    this.host.emit({ type: 'turn_start', userText: text });
    await this.runLoop();
  }

  private get options(): AgentRunOptions {
    return this.host.getOptions();
  }

  private activeTools(opts: AgentRunOptions): ToolDefinition[] {
    const builtin = buildToolDefinitions({ enableWebTools: opts.enableWebTools, subagents: opts.subagents });
    let extra: ToolDefinition[] = [];
    try {
      extra = this.host.getExtraTools?.() ?? [];
    } catch {
      extra = [];
    }
    return extra.length ? [...builtin, ...extra] : builtin;
  }

  private useTextProtocol(opts: AgentRunOptions, tools: ToolDefinition[]): boolean {
    if (this.forcedTextMode) {
      return true;
    }
    if (opts.toolCallMode === 'text') {
      return true;
    }
    if (opts.toolCallMode === 'auto' && opts.model.supportsTools === false) {
      return true;
    }
    if (tools.length === 0) {
      return true;
    }
    return false;
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    this.completionBlocks = 0;
    this.planAttempts = 0;
    this.nudges = 0;
    this.session.lastSteps = 0;

    const opts = this.options;
    const tools = this.activeTools(opts);
    const toolMap = toolDefinitionMap(tools);

    try {
      await this.maybeAutoCompact(opts);

      for (let step = 1; step <= Math.max(1, opts.maxSteps); step++) {
        if (this.aborted) {
          this.finish('aborted');
          return;
        }
        this.session.lastSteps = step;
        this.host.emit({
          type: 'status',
          text: `step ${step}/${opts.maxSteps} · thinking`,
          busy: true,
          steps: step,
          maxSteps: opts.maxSteps
        });

        const context = await this.host.collectContext();
        const system = this.buildSystem(opts, context);
        const prepared = this.prepareMessages(opts, system);
        const textProtocol = this.useTextProtocol(opts, tools);
        const requestTools = textProtocol ? [] : tools;

        this.host.emit({ type: 'assistant_start', id: `a_${step}` });

        const outcome = await this.callModel({
          model: opts.model,
          system: prepared.system,
          messages: prepared.messages,
          tools: requestTools,
          signal: this.abortController?.signal,
          onText: (t) => this.host.emit({ type: 'assistant_delta', id: `a_${step}`, text: t }),
          onReasoning: (t) => this.host.emit({ type: 'reasoning_delta', id: `a_${step}`, text: t }),
          toolProtocol: textProtocol ? 'text' : 'native',
          apiKey: await this.host.getApiKey(opts.model)
        });

        if (outcome.error) {
          if (this.isAbort(outcome.error)) {
            this.host.emit({ type: 'assistant_end', id: `a_${step}`, text: outcome.text });
            this.finish('aborted');
            return;
          }
          if (!textProtocol && this.looksLikeMissingToolSupport(outcome.error)) {
            // The endpoint rejected `tools` — switch to the text protocol and retry this step.
            this.forcedTextMode = true;
            this.host.emit({
              type: 'notice',
              message: 'This model rejected native tool calling — switching to the text tool protocol automatically.',
              level: 'warn'
            });
            step -= 1;
            continue;
          }
          this.host.emit({ type: 'assistant_end', id: `a_${step}`, text: outcome.text });
          this.host.emit({ type: 'error', message: outcome.error });
          this.host.emit({
            type: 'notice',
            message: 'Turn failed. Check the model Base URL / Model ID / API key (AM Code: Add Model) and the AM Code output channel.',
            level: 'warn'
          });
          this.finish('error');
          return;
        }

        if (outcome.usage) {
          this.session.usage.inputTokens += outcome.usage.inputTokens;
          this.session.usage.outputTokens += outcome.usage.outputTokens;
          this.host.emit({ type: 'usage', usage: this.session.usage, model: opts.model.modelId });
        }

        let text = outcome.text;
        let calls = outcome.calls;
        if (textProtocol) {
          const parsed = parseTextToolCalls(text, tools);
          text = parsed.text;
          calls = parsed.calls;
          if (calls.length === 0 && this.looksLikeUnparsedToolAttempt(text)) {
            calls = [];
          }
        }
        this.host.emit({ type: 'assistant_end', id: `a_${step}`, text });

        this.session.messages.push({
          role: 'assistant',
          content: text,
          toolCalls: calls.length ? calls : undefined,
          ts: Date.now()
        });
        this.host.save();

        if (calls.length === 0) {
          if (this.session.mode === 'plan' && !this.session.approvedPlan && this.nudges === 0 && text.length > 60) {
            this.nudges += 1;
            this.session.messages.push({
              role: 'user',
              content:
                'Reminder: you are in PLAN mode. If you now understand the change, call the plan tool with the full ordered plan (no file edits). If you still need information, read it first.',
              internal: true
            });
            continue;
          }
          this.host.emit({ type: 'status', text: 'idle', busy: false });
          this.finish('completed', text);
          return;
        }

        const allReadOnly = calls.every((c) => (toolMap.get(c.name)?.kind ?? 'read') === 'read');
        if (allReadOnly && calls.length > 1) {
          await this.runToolBatch(calls, opts, toolMap);
          if (this.pendingEnd) {
            return;
          }
        } else {
          for (const call of calls) {
            const stop = await this.runTool(call, opts, toolMap);
            if (stop) {
              return;
            }
          }
        }
        if (this.aborted) {
          this.finish('aborted');
          return;
        }

        // ---- loop guards: stop runaway exploration before it burns the user's tokens
        this.readOnlyStreak = allReadOnly ? this.readOnlyStreak + 1 : 0;
        if (allReadOnly && this.readOnlyStreak === READ_ONLY_WARN) {
          this.budgetNotes.push(
            `BUDGET WARNING: ${this.readOnlyStreak} consecutive steps were read-only. Stop exploring: ` +
              'use what you already know to answer or to make the change, then finish.'
          );
          this.host.emit({
            type: 'notice',
            message: `Only read-only steps for ${this.readOnlyStreak} steps — telling the agent to wrap up.`,
            level: 'info'
          });
        }
        if (allReadOnly && this.readOnlyStreak >= READ_ONLY_STOP) {
          this.host.emit({
            type: 'notice',
            message:
              `Stopped after ${this.readOnlyStreak} read-only steps without any progress (no edits, no commands). ` +
              'Send a follow-up if you want me to keep digging — the checklist and findings above are kept.',
            level: 'warn'
          });
          this.finish('stopped', 'Stopped: read-only step limit reached');
          return;
        }
      }

      this.host.emit({
        type: 'notice',
        message: `Reached the step limit (${opts.maxSteps}) for one message. Ask me to continue and I will pick up from the checklist.`,
        level: 'warn'
      });
      this.finish('max_steps');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isAbort(err)) {
        this.finish('aborted');
      } else {
        this.host.emit({ type: 'error', message });
        this.finish('error');
      }
    } finally {
      this.running = false;
      this.host.emit({ type: 'status', text: 'idle', busy: false });
      this.host.save();
    }
  }

  private pendingEnd = false;

  private async runToolBatch(
    calls: ToolCall[],
    opts: AgentRunOptions,
    toolMap: Map<string, ToolDefinition>
  ): Promise<void> {
    for (const call of calls) {
      this.host.emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.args });
    }
    const results = await Promise.all(
      calls.map(async (call) => {
        try {
          return await this.executeToolChecked(call, opts, toolMap);
        } catch (err) {
          return errorOutcome(call.name, err);
        }
      })
    );
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const outcome = results[i];
      this.host.emit({ type: 'tool_end', callId: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary });
      this.session.messages.push(toolMessage(call, outcome));
      if (outcome.endsTurn) {
        this.pendingEnd = true;
        this.finishCompletion(outcome);
        return;
      }
      if (outcome.abort) {
        this.pendingEnd = true;
        this.finish('aborted');
        return;
      }
    }
    this.host.save();
  }

  /** Executes one tool call, handling the control tools internally. Returns true when the turn must end. */
  private async runTool(
    call: ToolCall,
    opts: AgentRunOptions,
    toolMap: Map<string, ToolDefinition>
  ): Promise<boolean> {
    this.host.emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.args });
    let outcome: ToolOutcome;
    try {
      outcome = await this.executeToolChecked(call, opts, toolMap);
    } catch (err) {
      outcome = errorOutcome(call.name, err);
    }
    this.host.emit({ type: 'tool_end', callId: call.id, name: call.name, ok: outcome.ok, summary: outcome.summary });
    this.session.messages.push(toolMessage(call, outcome));
    this.host.save();

    if (outcome.endsTurn) {
      this.finishCompletion(outcome);
      return true;
    }
    if (outcome.abort) {
      this.finish('aborted');
      return true;
    }
    return false;
  }

  private async executeToolChecked(
    call: ToolCall,
    opts: AgentRunOptions,
    toolMap: Map<string, ToolDefinition>
  ): Promise<ToolOutcome> {
    const def = toolMap.get(call.name);
    if (!def) {
      return {
        ok: false,
        content: `Unknown tool "${call.name}". Available tools: ${[...toolMap.keys()].join(', ')}.`,
        summary: `unknown tool: ${call.name}`
      };
    }

    const args = (call.args ?? {}) as Record<string, unknown>;
    if (args.__raw) {
      return {
        ok: false,
        content: `Your tool call arguments were not valid JSON. Re-send ${call.name} with a properly escaped JSON object. Received: ${truncate(String(args.__raw), 400)}`,
        summary: 'invalid JSON arguments'
      };
    }

    // Plan mode: hard block on anything that mutates state.
    if (this.session.mode === 'plan' && (def.kind === 'write' || def.kind === 'exec')) {
      return {
        ok: false,
        content:
          `Blocked: you are in PLAN mode, which is read-only. Do not call ${call.name}. ` +
          'Finish your investigation with read-only tools and then call the plan tool to present your implementation plan to the user.',
        summary: `blocked in plan mode: ${call.name}`
      };
    }

    switch (call.name) {
      case TOOL_NAMES.updateTodos:
        return this.handleUpdateTodos(args);
      case TOOL_NAMES.plan:
        return this.handlePlan(args, opts);
      case TOOL_NAMES.attemptCompletion:
        return this.handleCompletion(args, opts);
      case TOOL_NAMES.askUser:
        return this.handleAskUser(args);
      case TOOL_NAMES.spawnAgent:
        return this.handleSpawnAgent(args, opts);
      default:
        break;
    }

    // Permission gate for IO tools.
    const decision = await this.askPermission(def, args);
    if (!decision.allowed) {
      return {
        ok: false,
        content: `The user rejected this ${def.name} call${decision.reason ? `: ${decision.reason}` : ''}. Do not repeat the exact same call — adjust your approach, use a smaller change, or ask the user what they prefer.`,
        summary: `rejected by user: ${def.name}`
      };
    }

    const outcome = await this.host.executeTool(call, this.session.mode);
    if (outcome.content.length > MAX_TOOL_RESULT_CHARS) {
      outcome.content = truncate(outcome.content, MAX_TOOL_RESULT_CHARS);
    }
    for (const edit of outcome.edits ?? []) {
      this.session.addEdit(edit);
    }
    return outcome;
  }

  private async askPermission(
    def: ToolDefinition,
    args: Record<string, unknown>
  ): Promise<PermissionDecision> {
    const preview = buildPreview(def, args);
    const request: PermissionRequest = {
      id: newToolId(),
      toolName: def.name,
      kind: def.kind,
      title: permissionTitle(def, args),
      detail: preview?.after ?? String(args.command ?? ''),
      preview,
      command: typeof args.command === 'string' ? args.command : undefined
    };
    this.host.emit({ type: 'permission_ask', request });
    const decision = await this.host.requestPermission(request);
    this.host.emit({ type: 'permission_result', id: request.id, allowed: decision.allowed, remember: decision.remember });
    return decision;
  }

  private handleUpdateTodos(args: Record<string, unknown>): ToolOutcome {
    const raw = args.todos;
    if (!Array.isArray(raw)) {
      return {
        ok: false,
        content: 'update_todos requires a "todos" array. Send the complete checklist, each item with content + status.',
        summary: 'invalid update_todos payload'
      };
    }
    const previous = this.session.todos.toJSON();
    const previouslyCompleted = previous.filter((t) => t.status === 'completed').length;
    const todos = this.session.todos.set(raw);
    this.host.emit({ type: 'todos', todos });
    this.host.onTodosChanged();
    const stats = this.session.todos.stats();
    const inProgress = todos.filter((t) => t.status === 'in_progress');
    let content = `Checklist updated (${stats.completed}/${stats.total} completed).\n${this.session.todos.toMarkdown()}`;
    if (stats.total === 0) {
      content += '\n\nWARNING: the checklist is now empty. If the request has more than one step, put the full task list back.';
    }
    if (inProgress.length > 1) {
      content += `\n\nNOTE: ${inProgress.length} items are marked in_progress. Keep exactly one in_progress at a time.`;
    }
    if (stats.total > 3 && stats.completed === stats.total && previouslyCompleted === 0) {
      content +=
        '\n\nWARNING: you marked every item completed in a single update without ever marking one in_progress. Only mark an item completed when that step is really done and verified on disk.';
    }
    const next = this.session.todos.nextPending();
    if (next) {
      content += `\n\nNext unfinished item: ${next.id}. ${next.content}`;
    }
    return { ok: true, content, summary: `checklist ${stats.completed}/${stats.total} (${inProgress[0]?.content ?? 'no active item'})` };
  }

  private async handlePlan(args: Record<string, unknown>, opts: AgentRunOptions): Promise<ToolOutcome> {
    if (this.session.mode !== 'plan') {
      return {
        ok: false,
        content: 'The plan tool is only available in PLAN mode. In build mode, just do the work (checklist first, then implement).',
        summary: 'plan tool ignored (build mode)'
      };
    }
    if (this.planAttempts >= 4) {
      return {
        ok: false,
        content:
          'Too many plan revisions in one turn. Ask the user with ask_user what they actually want, or wait for their next message instead of calling plan again.',
        summary: 'plan loop stopped'
      };
    }
    const plan = normalizePlan(args);
    if (plan.steps.length === 0) {
      return { ok: false, content: 'plan requires at least one step. Provide summary + steps.', summary: 'invalid plan' };
    }
    this.planAttempts += 1;
    const planId = newToolId();
    this.host.emit({ type: 'plan', plan, id: planId });
    this.host.emit({ type: 'status', text: 'waiting for plan approval', busy: true });
    const decision = await this.host.approvePlan(planId, plan);
    this.host.emit({ type: 'plan_result', id: planId, approved: decision.approved, feedback: decision.feedback });

    if (decision.approved) {
      this.session.approvedPlan = plan;
      this.setMode('build');
      return {
        ok: true,
        content:
          'PLAN APPROVED by the user. You are now in BUILD mode.\n' +
          'Next: call update_todos with the full checklist derived from the approved plan (all items "pending"), then execute step by step.\n' +
          `Keep the implementation faithful to the approved plan and keep these steps:\n${plan.steps
            .map((s, i) => `${i + 1}. ${s.title}`)
            .join('\n')}`,
        summary: 'plan approved → build mode'
      };
    }
    return {
      ok: true,
      content: `The user rejected the plan.${decision.feedback ? ` Feedback: "${decision.feedback}"` : ''}\nStay in PLAN mode, revise your approach accordingly (use read-only tools if you still need facts) and call plan again with an updated plan.`,
      summary: 'plan rejected'
    };
  }

  private handleCompletion(args: Record<string, unknown>, opts: AgentRunOptions): ToolOutcome {
    const result = String(args.result ?? '').trim() || 'Task finished.';
    if (this.session.mode === 'plan' && !this.session.approvedPlan) {
      return {
        ok: false,
        content:
          'You are still in PLAN mode: do not complete the task. Explore with read-only tools if needed and then call the plan tool so the user can approve your approach.',
        summary: 'completion ignored (plan mode)'
      };
    }
    const unfinished = this.session.todos.unfinished();
    if (opts.strictChecklist && unfinished.length > 0 && this.completionBlocks < 2) {
      this.completionBlocks += 1;
      return {
        ok: false,
        content:
          `attempt_completion rejected: ${unfinished.length} checklist item(s) are still open:\n${unfinished
            .map((t) => `- ${t.id}. [${t.status}] ${t.content}`)
            .join('\n')}\n` +
          'Finish each one and mark it completed with a note, or mark genuinely skipped items as "cancelled" with a short reason. Then call attempt_completion again.',
        summary: 'completion blocked — checklist incomplete'
      };
    }
    const files = Array.isArray(args.files_changed) ? (args.files_changed as unknown[]).map(String) : [];
    const verified = args.verified ? String(args.verified) : '';
    const detail = [result, files.length ? `**Changed:** ${files.map((f) => `\`${f}\``).join(', ')}` : '', verified ? `**Verified:** ${verified}` : '']
      .filter(Boolean)
      .join('\n\n');
    return { ok: true, content: 'Task marked complete.', summary: 'task completed', endsTurn: true, detail };
  }

  private async handleAskUser(args: Record<string, unknown>): Promise<ToolOutcome> {
    const question = String(args.question ?? '').trim();
    if (!question) {
      return { ok: false, content: 'ask_user requires a question.', summary: 'invalid ask_user' };
    }
    const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).slice(0, 5) : undefined;
    const request: AskUserRequest = {
      id: newToolId(),
      question,
      options,
      allowFreeText: args.allow_free_text !== false
    };
    this.host.emit({ type: 'ask_user', request });
    this.host.emit({ type: 'status', text: 'waiting for your answer', busy: true });
    const answer = await this.host.askUser(request);
    this.host.emit({ type: 'ask_user_answer', id: request.id, answer: answer.answer });
    if (answer.cancelled) {
      return {
        ok: false,
        content: 'The user dismissed the question. Stop asking and make a reasonable decision yourself, or wait for the user to write a new message.',
        summary: 'question dismissed'
      };
    }
    return { ok: true, content: `User answered: ${answer.answer}`, summary: `asked user: ${truncate(question, 60)}` };
  }

  private async handleSpawnAgent(args: Record<string, unknown>, opts: AgentRunOptions): Promise<ToolOutcome> {
    const task = String(args.task ?? '').trim();
    if (!task) {
      return { ok: false, content: 'spawn_agent requires a task description.', summary: 'invalid spawn_agent' };
    }
    const kind = String(args.agent ?? 'explore');
    this.host.emit({ type: 'notice', message: `sub-agent (${kind}) researching: ${truncate(task, 90)}` });
    try {
      const report = await this.runSubAgent(task, kind, opts);
      return { ok: true, content: report, summary: `sub-agent report (${report.length} chars)` };
    } catch (err) {
      return errorOutcome('spawn_agent', err);
    }
  }

  /** A read-only research agent with its own fresh context (Claude Code Task tool style). */
  private async runSubAgent(task: string, kind: string, opts: AgentRunOptions): Promise<string> {
    const tools = this.activeTools({ ...opts, subagents: false }).filter((t) => t.kind === 'read');
    const env = await this.host.collectContext();
    const system = [
      `You are a read-only research sub-agent of AM Code, working inside the workspace ${env.cwd}.`,
      'You can only read: read_file, list_dir, glob, grep, get_diagnostics. You cannot edit files or run shell commands.',
      'Answer the task precisely and completely. Quote the important code with path:line references.',
      'Be compact: no pleasantries, no restating the task. End with a "## Findings" section with the concrete facts the caller needs.',
      kind === 'general' ? 'Analyse carefully; you may reason at length before answering.' : 'Move fast: find the answer with as few tool calls as possible.'
    ].join('\n');

    const messages: ChatMessage[] = [{ role: 'user', content: task, ts: Date.now() }];
    const textProtocol = this.useTextProtocol(opts, tools);

    for (let step = 1; step <= SUBAGENT_MAX_STEPS; step++) {
      if (this.aborted) {
        break;
      }
      const outcome = await this.callModel({
        model: opts.model,
        system,
        messages,
        tools: textProtocol ? [] : tools,
        signal: this.abortController?.signal,
        toolProtocol: textProtocol ? 'text' : 'native',
        apiKey: await this.host.getApiKey(opts.model)
      });
      if (outcome.error) {
        return `Sub-agent failed: ${outcome.error}`;
      }
      let text = outcome.text;
      let calls = outcome.calls;
      if (textProtocol) {
        const parsed = parseTextToolCalls(text, tools);
        text = parsed.text;
        calls = parsed.calls;
      }
      messages.push({ role: 'assistant', content: text, toolCalls: calls.length ? calls : undefined });
      if (calls.length === 0 || calls.every((c) => c.name === TOOL_NAMES.attemptCompletion)) {
        const completion = calls.find((c) => c.name === TOOL_NAMES.attemptCompletion);
        const finalText = completion ? String(completion.args.result ?? text) : text;
        return truncate(finalText.trim() || '(no findings)', 8000);
      }
      for (const call of calls) {
        const def = tools.find((t) => t.name === call.name);
        if (!def) {
          messages.push(toolMessage(call, { ok: false, content: `Tool ${call.name} is not available to sub-agents.`, summary: 'unavailable' }));
          continue;
        }
        const outcomeTool = await this.host.executeTool(call, 'plan'); // read-only: mode is irrelevant here
        messages.push(toolMessage(call, { ...outcomeTool, content: truncate(outcomeTool.content, 6000) }));
      }
    }
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return truncate(lastAssistant?.content?.trim() || 'Sub-agent reached its step limit without a final report.', 8000);
  }

  private finishCompletion(outcome: ToolOutcome): void {
    this.host.emit({ type: 'status', text: 'idle', busy: false });
    this.finish('completed', outcome.detail);
  }

  private finish(reason: 'completed' | 'max_steps' | 'aborted' | 'error' | 'stopped', text?: string): void {
    this.host.emit({ type: 'turn_end', reason, text });
    this.host.save();
  }

  // ------------------------------------------------------------------ model plumbing

  private buildSystem(opts: AgentRunOptions, context: HostContext): string {
    const tools = this.activeTools(opts);
    let system = buildSystemPrompt({
      mode: this.session.mode,
      cwd: context.cwd,
      workspaceName: context.workspaceName,
      os: context.os,
      today: context.today,
      modelName: opts.model.name,
      modelId: opts.model.modelId,
      toolCallMode: this.useTextProtocol(opts, tools) ? 'text' : 'native',
      alwaysPlan: opts.alwaysPlan,
      strictChecklist: opts.strictChecklist,
      enableWebTools: opts.enableWebTools,
      subagents: opts.subagents,
      todosMarkdown: this.session.todos.toMarkdown(),
      todoStats: this.session.todos.stats(),
      rulesFiles: context.rulesFiles,
      activeFile: opts.includeOpenFileContext ? context.activeFile : undefined,
      activeSelection: opts.includeOpenFileContext ? context.activeSelection : undefined,
      openFileList: opts.includeOpenFileContext ? context.openFileList : undefined,
      diagnosticsSummary: opts.includeDiagnostics ? context.diagnosticsSummary : undefined,
      approvedPlan: this.session.approvedPlan,
      thinkingHint: opts.thinkingBudgetHint,
      customInstructions: opts.customInstructions,
      responseLanguage: opts.responseLanguage
    });
    const notes: string[] = [];
    if (opts.softStepBudget > 0 && this.session.lastSteps > opts.softStepBudget) {
      notes.push(
        `SOFT STEP BUDGET REACHED (${this.session.lastSteps}/${opts.softStepBudget} steps for this message). ` +
          'Wrap up now: finish the checklist item you are on, tick it, and either call attempt_completion with a short report ' +
          'or ask_user if you are genuinely blocked. Do not start new exploration.'
      );
    }
    notes.push(...this.budgetNotes);
    if (notes.length) {
      system += `\n\n---\n\n# Host notes for this step\n${notes.map((n) => `- ${n}`).join('\n')}`;
    }

    if (this.useTextProtocol(opts, tools)) {
      system += `\n\n---\n\n${describeToolsForText(tools)}`;
    }
    return system;
  }

  /** The last compression report (shown in the panel and the Tokens screen). */
  lastCompression?: CompressionStats;

  private prepareMessages(opts: AgentRunOptions, system: string): { system: string; messages: ChatMessage[] } {
    const contextWindow = opts.model.contextWindow ?? 128000;
    const reserve = Math.min(16000, Math.floor(contextWindow * 0.15));
    const budget = contextWindow - reserve - Math.ceil(system.length / 4);

    // 1) never let the request leave the context window
    const { messages, trimmed } = trimHistory(this.session.messages, budget);
    if (trimmed) {
      this.host.emit({
        type: 'notice',
        message: 'Context window is filling up — older tool outputs were compressed. Use /compact for a full summary.',
        level: 'info'
      });
    }

    // 2) squeeze the payload itself (this is what the user pays for)
    const { messages: squeezed, stats } = compressMessages(messages, opts.tokenSaver);
    this.lastCompression = stats;
    if (stats.savedTokens > 0) {
      this.host.emit({ type: 'token_saver', stats });
    }
    return { system, messages: squeezed };
  }

  private async maybeAutoCompact(opts: AgentRunOptions): Promise<void> {
    const estimate = estimateTokens('', this.session.messages);
    const limit = opts.model.contextWindow ?? 128000;
    if (estimate < limit * 0.8 || this.session.messages.length < 24) {
      return;
    }
    this.host.emit({ type: 'notice', message: 'Context is >80% full — compacting the session automatically…' });
    await this.compact();
  }

  /** Summarise the transcript and keep only the recent tail. */
  async compact(): Promise<void> {
    const opts = this.options;
    const model = opts.smallModel ?? opts.model;
    const keep = this.session.messages.slice(-6);
    const older = this.session.messages.slice(0, -6);
    if (older.length === 0) {
      return;
    }
    const digest = older
      .map((m) => `${m.role.toUpperCase()}: ${truncate(m.content ?? '', 900)}`)
      .join('\n\n');
    const prompt = [
      'Summarise this coding session so another engineer can continue the work with no other context.',
      'Use these sections, in markdown, max 400 words total:',
      '## Goal — what the user asked for',
      '## Done — changes already made (file paths + what changed)',
      '## Checklist — the current task list with statuses',
      '## Open — what is still missing, blockers, next step',
      '## Key facts — commands that work, conventions, gotchas discovered',
      '',
      'Transcript:',
      digest
    ].join('\n');

    const result = await this.callModel({
      model,
      system: 'You are a precise technical summariser. Output only the summary.',
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      signal: this.abortController?.signal,
      toolProtocol: 'native',
      apiKey: await this.host.getApiKey(model),
      maxTokens: 1200
    });
    const summary = (result.text || '').trim();
    if (!summary) {
      return;
    }
    this.session.messages = [
      {
        role: 'user',
        content: `[CONTEXT COMPACTED]\nSummary of the work so far:\n\n${summary}\n\nContinue from here. The checklist below is authoritative.`,
        internal: true
      },
      ...keep
    ];
    this.host.emit({ type: 'notice', message: `Session compacted (${older.length} messages → summary).` });
    this.host.save();
  }

  private async callModel(params: {
    model: ModelConfig;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
    onText?: (t: string) => void;
    onReasoning?: (t: string) => void;
    toolProtocol: 'native' | 'text';
    apiKey?: string;
    maxTokens?: number;
  }): Promise<{ text: string; calls: ToolCall[]; stopReason?: string | null; usage?: Usage; error?: string }> {
    const provider = createProvider(params.model);
    let text = '';
    const calls: ToolCall[] = [];
    let usage: Usage | undefined;
    let stopReason: string | null | undefined;

    try {
      const stream = provider.streamChat({
        model: params.model,
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        signal: params.signal,
        apiKey: params.apiKey,
        maxTokens: params.maxTokens ?? params.model.maxTokens
      });
      for await (const event of stream as AsyncGenerator<ProviderStreamEvent>) {
        if (event.type === 'text' && event.text) {
          text += event.text;
          params.onText?.(event.text);
        } else if (event.type === 'reasoning' && event.text) {
          params.onReasoning?.(event.text);
        } else if (event.type === 'tool_call' && event.call) {
          calls.push(event.call);
        } else if (event.type === 'done') {
          usage = event.usage;
          stopReason = event.stopReason;
        }
      }
    } catch (err) {
      if (this.isAbort(err)) {
        return { text, calls, stopReason, usage, error: 'ABORTED' };
      }
      return { text, calls, stopReason, usage, error: err instanceof Error ? err.message : String(err) };
    }
    return { text, calls, stopReason, usage };
  }

  private isAbort(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /abort/i.test(message) || this.aborted;
  }

  private get aborted(): boolean {
    return Boolean(this.abortController?.signal.aborted);
  }

  private looksLikeMissingToolSupport(error: string): boolean {
    return /tool|function.?call/i.test(error) && /not support|unsupported|invalid|unrecognized|unknown|does not support/i.test(error);
  }

  private looksLikeUnparsedToolAttempt(text: string): boolean {
    return /<tool_call>|"name"\s*:\s*"(read_file|write_file|edit_file|run_command)"/.test(text);
  }
}

function toolMessage(call: ToolCall, outcome: ToolOutcome): ChatMessage {
  const body = outcome.content?.trim() ? outcome.content : outcome.summary;
  return {
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: outcome.ok ? body : `ERROR: ${body}`,
    ts: Date.now()
  };
}

function errorOutcome(name: string, err: unknown): ToolOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, content: `Tool ${name} failed: ${message}`, summary: `${name} failed: ${truncate(message, 60)}` };
}

function permissionTitle(def: ToolDefinition, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (def.name) {
    case TOOL_NAMES.writeFile:
      return `${path ? 'Create/overwrite' : 'Write'} ${path}`;
    case TOOL_NAMES.editFile:
      return `Edit ${path}`;
    case TOOL_NAMES.deleteFile:
      return `Delete ${path}`;
    case TOOL_NAMES.runCommand:
      return `Run: ${truncate(String(args.command ?? ''), 120)}`;
    default:
      return def.name;
  }
}

function buildPreview(
  def: ToolDefinition,
  args: Record<string, unknown>
): { path: string; before: string; after: string; isNew: boolean } | undefined {
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) {
    return undefined;
  }
  if (def.name === TOOL_NAMES.writeFile) {
    return { path, before: '', after: String(args.content ?? ''), isNew: true };
  }
  if (def.name === TOOL_NAMES.editFile) {
    return {
      path,
      before: String(args.old_text ?? ''),
      after: String(args.new_text ?? ''),
      isNew: false
    };
  }
  return undefined;
}

function normalizePlan(args: Record<string, unknown>): Plan {
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  const steps = rawSteps.map((s) => {
    const step = (s ?? {}) as Record<string, unknown>;
    return {
      title: String(step.title ?? step.name ?? 'Step').trim(),
      details: step.details ? String(step.details) : undefined,
      files: Array.isArray(step.files) ? (step.files as unknown[]).map(String) : undefined
    };
  });
  return {
    summary: String(args.summary ?? '').trim() || 'Implementation plan',
    steps,
    openQuestions: Array.isArray(args.open_questions) ? (args.open_questions as unknown[]).map(String) : undefined
  };
}

export function todoStatusLabel(status: TodoStatus): string {
  return status === 'in_progress' ? 'in progress' : status;
}
