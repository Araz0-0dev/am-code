import * as vscode from 'vscode';
import { AgentRunOptions } from '../core/agent';
import { McpServerConfig, ModelConfig, ProviderKind, ToolCallMode } from '../core/types';

const SECRET_PREFIX = 'agentcode.apiKey.';
const MCP_SECRET_PREFIX = 'agentcode.mcpSecret.';

export interface McpServerPayload {
  id?: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  /** Space separated arguments as typed in the form. */
  argsText?: string;
  /** KEY=VALUE lines. */
  envText?: string;
  url?: string;
  /** "Header: value" lines. */
  headersText?: string;
  /** Comma separated tool name patterns. */
  toolFilterText?: string;
  autoApproveTools?: boolean;
  enabled?: boolean;
  /** Token/API key stored in Secret Storage and injected at connect time. */
  secret?: string;
  secretEnv?: string;
  secretHeader?: string;
  timeoutMs?: number;
}

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('agentcode');
}

export class ConfigManager {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getModels(): ModelConfig[] {
    const raw = cfg().get<unknown[]>('models', []);
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => normalizeModel(entry))
      .filter((m): m is ModelConfig => Boolean(m));
  }

  getActiveModel(): ModelConfig | undefined {
    const models = this.getModels();
    if (models.length === 0) {
      return undefined;
    }
    const wanted = cfg().get<string>('activeModel', '');
    return models.find((m) => m.id === wanted || m.name === wanted) ?? models[0];
  }

  getSmallModel(): ModelConfig | undefined {
    const models = this.getModels();
    const wanted = cfg().get<string>('smallModel', '');
    if (!wanted) {
      return undefined;
    }
    return models.find((m) => m.id === wanted || m.name === wanted);
  }

  async setActiveModel(id: string): Promise<void> {
    await cfg().update('activeModel', id, vscode.ConfigurationTarget.Global);
  }

  async saveModels(models: ModelConfig[]): Promise<void> {
    await cfg().update('models', models, vscode.ConfigurationTarget.Global);
  }

  async getApiKey(model: ModelConfig): Promise<string | undefined> {
    const stored = await this.secrets.get(SECRET_PREFIX + model.id);
    if (stored) {
      return stored;
    }
    if (model.apiKeyEnv) {
      return process.env[model.apiKeyEnv];
    }
    return undefined;
  }

  async setApiKey(model: ModelConfig, key: string): Promise<void> {
    if (key) {
      await this.secrets.store(SECRET_PREFIX + model.id, key);
    } else {
      await this.secrets.delete(SECRET_PREFIX + model.id);
    }
  }

  async deleteApiKey(model: ModelConfig): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + model.id);
  }

  async hasApiKey(model: ModelConfig): Promise<boolean> {
    return Boolean(await this.getApiKey(model));
  }

  getRunOptions(): AgentRunOptions {
    const c = cfg();
    const model = this.getActiveModel();
    if (!model) {
      throw new Error('NO_MODEL');
    }
    return {
      model,
      smallModel: this.getSmallModel(),
      toolCallMode: c.get<ToolCallMode>('toolCallMode', 'auto'),
      maxSteps: clampNumber(c.get<number>('maxSteps', 40), 1, 200),
      softStepBudget: clampNumber(c.get<number>('softStepBudget', 15), 0, 200),
      strictChecklist: c.get<boolean>('strictChecklist', true),
      alwaysPlan: c.get<boolean>('alwaysPlan', true),
      enableWebTools: c.get<boolean>('enableWebTools', false),
      subagents: c.get<boolean>('subagents', true),
      customInstructions: c.get<string>('customInstructions', ''),
      thinkingBudgetHint: c.get<'off' | 'low' | 'medium' | 'high'>('thinkingBudgetHint', 'medium'),
      responseLanguage: c.get<string>('responseLanguage', 'auto'),
      includeOpenFileContext: c.get<boolean>('includeOpenFileContext', true),
      includeDiagnostics: c.get<boolean>('includeDiagnostics', true),
      tokenSaver: {
        mode: c.get<'off' | 'balanced' | 'aggressive'>('tokenSaver', 'balanced'),
        keepRecent: clampNumber(c.get<number>('tokenSaverKeepRecent', 6), 2, 40),
        maxToolResultChars: clampNumber(c.get<number>('tokenSaverMaxToolChars', 1400), 400, 8000),
        dedupeToolResults: c.get<boolean>('tokenSaverDedupe', true),
        dropOldImages: c.get<boolean>('tokenSaverDropImages', true)
      }
    };
  }

  /** Token-saver settings — readable without a configured model (the panel shows them on first run). */
  get tokenSaverSettings(): {
    mode: 'off' | 'balanced' | 'aggressive';
    keepRecent: number;
    maxToolResultChars: number;
    dedupeToolResults: boolean;
    dropOldImages: boolean;
  } {
    const c = cfg();
    return {
      mode: c.get<'off' | 'balanced' | 'aggressive'>('tokenSaver', 'balanced'),
      keepRecent: clampNumber(c.get<number>('tokenSaverKeepRecent', 6), 2, 40),
      maxToolResultChars: clampNumber(c.get<number>('tokenSaverMaxToolChars', 1400), 400, 8000),
      dedupeToolResults: c.get<boolean>('tokenSaverDedupe', true),
      dropOldImages: c.get<boolean>('tokenSaverDropImages', true)
    };
  }

  get autoApproveRead(): boolean {
    return cfg().get<boolean>('autoApproveRead', true);
  }

  get autoApproveWrite(): boolean {
    return cfg().get<boolean>('autoApproveWrite', false);
  }

  get autoApproveCommands(): boolean {
    return cfg().get<boolean>('autoApproveCommands', false);
  }

  get commandAllowlist(): string[] {
    return cfg().get<string[]>('commandAllowlist', []);
  }

  get commandDenylist(): string[] {
    return cfg().get<string[]>('commandDenylist', []);
  }

  get contextFiles(): string[] {
    return cfg().get<string[]>('contextFiles', ['AGENTS.md', 'CLAUDE.md']);
  }

  get workMode(): 'review' | 'autonomy' {
    return cfg().get<'review' | 'autonomy'>('workMode', 'review');
  }

  get showReasoning(): boolean {
    return cfg().get<boolean>('showReasoning', this.workMode === 'review');
  }

  /** Switches between the two presets offered on the welcome screen. */
  async setWorkMode(mode: 'review' | 'autonomy'): Promise<void> {
    const target = vscode.ConfigurationTarget.Global;
    await cfg().update('workMode', mode, target);
    await cfg().update('autoApproveWrite', mode === 'autonomy', target);
    await cfg().update('autoApproveCommands', mode === 'autonomy', target);
    await cfg().update('showReasoning', mode === 'review', target);
  }

  /** Used by the in-panel form: creates the model, stores the key and makes it active. */
  async updateModelFromPayload(
    id: string,
    payload: Partial<{ name: string; provider: string; baseUrl: string; modelId: string; contextWindow: number; maxTokens: number; supportsTools: boolean; supportsVision: boolean }>
  ): Promise<{ ok: boolean; model?: ModelConfig; error?: string }> {
    const models = this.getModels();
    const index = models.findIndex((m) => m.id === id);
    if (index < 0) {
      return { ok: false, error: 'That model no longer exists.' };
    }
    const current = models[index];
    const next: ModelConfig = {
      ...current,
      name: (payload.name ?? current.name).trim() || current.name,
      provider: (String(payload.provider ?? current.provider).toLowerCase() === 'anthropic' ? 'anthropic' : 'openai'),
      baseUrl: (payload.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, ''),
      modelId: (payload.modelId ?? current.modelId).trim(),
      contextWindow: Number(payload.contextWindow) > 0 ? Number(payload.contextWindow) : current.contextWindow,
      maxTokens: Number(payload.maxTokens) > 0 ? Number(payload.maxTokens) : current.maxTokens,
      supportsTools: payload.supportsTools !== undefined ? payload.supportsTools : current.supportsTools,
      supportsVision: payload.supportsVision !== undefined ? payload.supportsVision : current.supportsVision
    };
    if (!/^https?:\/\//i.test(next.baseUrl)) {
      return { ok: false, error: 'The Base URL must start with http:// or https://' };
    }
    if (!next.modelId) {
      return { ok: false, error: 'The Model ID is required.' };
    }
    models[index] = next;
    await this.saveModels(models);
    return { ok: true, model: next };
  }

  async removeModelById(id: string): Promise<boolean> {
    const models = this.getModels();
    const model = models.find((m) => m.id === id);
    if (!model) {
      return false;
    }
    await this.deleteApiKey(model);
    const rest = models.filter((m) => m.id !== id);
    await this.saveModels(rest);
    const active = cfg().get<string>('activeModel', '');
    if (active === id) {
      await this.setActiveModel(rest[0]?.id ?? '');
    }
    if (cfg().get<string>('smallModel', '') === id) {
      await cfg().update('smallModel', '', vscode.ConfigurationTarget.Global);
    }
    return true;
  }

  async addModelFromPayload(payload: {
    name?: string;
    provider?: string;
    baseUrl?: string;
    modelId?: string;
    apiKey?: string;
    contextWindow?: number;
    maxTokens?: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
  }): Promise<{ ok: boolean; model?: ModelConfig; error?: string }> {
    const name = String(payload.name ?? '').trim();
    const baseUrl = String(payload.baseUrl ?? '').trim().replace(/\/+$/, '');
    const modelId = String(payload.modelId ?? '').trim();
    if (!name || !baseUrl || !modelId) {
      return { ok: false, error: 'Display name, Base URL and Model ID are all required.' };
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, error: 'The Base URL must start with http:// or https://' };
    }
    const provider: ProviderKind = String(payload.provider ?? 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
    const model: ModelConfig = {
      id: makeModelId(baseUrl, modelId),
      name,
      provider,
      baseUrl,
      modelId,
      maxTokens: Number(payload.maxTokens) > 0 ? Number(payload.maxTokens) : 8192,
      temperature: 0,
      contextWindow: Number(payload.contextWindow) > 0 ? Number(payload.contextWindow) : 128000,
      supportsTools: payload.supportsTools !== false,
      supportsVision: payload.supportsVision === true,
      headers: {}
    };
    const models = this.getModels().filter((m) => m.id !== model.id);
    models.push(model);
    await this.saveModels(models);
    if (payload.apiKey) {
      await this.setApiKey(model, payload.apiKey);
    }
    // a freshly added model becomes the active one — that is what the user expects
    await this.setActiveModel(model.id);
    return { ok: true, model };
  }

  /** Fetches the model list from the endpoint while the user is still in the form. */
  // ------------------------------------------------------------------ MCP servers

  getMcpServers(): McpServerConfig[] {
    const raw = cfg().get<unknown[]>('mcpServers', []);
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => normalizeMcpServer(entry))
      .filter((s): s is McpServerConfig => Boolean(s));
  }

  async saveMcpServers(servers: McpServerConfig[]): Promise<void> {
    await cfg().update('mcpServers', servers, vscode.ConfigurationTarget.Global);
  }

  /** Adds or updates one server from the graphical form. */
  async saveMcpServer(payload: McpServerPayload): Promise<McpServerConfig> {
    const servers = this.getMcpServers();
    const id = payload.id?.trim() || makeMcpId(payload.name, payload.url || payload.command || '');
    const env = parseKeyValueLines(payload.envText);
    const headers = parseKeyValueLines(payload.headersText, true);
    const args = splitArgs(payload.argsText);

    if (payload.secret?.trim()) {
      if (payload.secretEnv?.trim()) {
        await this.secrets.store(`${MCP_SECRET_PREFIX}${id}`, payload.secret.trim());
      } else if (payload.secretHeader?.trim()) {
        await this.secrets.store(`${MCP_SECRET_PREFIX}${id}`, payload.secret.trim());
      } else {
        await this.secrets.store(`${MCP_SECRET_PREFIX}${id}`, payload.secret.trim());
      }
    }

    const server: McpServerConfig = {
      id,
      name: payload.name.trim() || id,
      transport: payload.transport,
      enabled: payload.enabled !== false,
      autoApproveTools: Boolean(payload.autoApproveTools),
      timeoutMs: payload.timeoutMs,
      toolFilter: (payload.toolFilterText ?? '')
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean),
      ...(payload.transport === 'stdio'
        ? {
            command: (payload.command ?? '').trim(),
            args,
            env
          }
        : { url: (payload.url ?? '').trim(), headers })
    };

    if (payload.transport === 'stdio' && payload.secretEnv?.trim()) {
      // The value comes from Secret Storage at connect time.
      server.env = { ...(server.env ?? {}), [payload.secretEnv.trim()]: '' };
      server.envKeys = [...(server.envKeys ?? []), payload.secretEnv.trim()];
    }
    if (payload.transport !== 'stdio' && payload.secretHeader?.trim()) {
      server.headers = { ...(server.headers ?? {}), [payload.secretHeader.trim()]: '' };
      server.headerKeys = [...(server.headerKeys ?? []), payload.secretHeader.trim()];
    }

    const index = servers.findIndex((s) => s.id === id);
    if (index >= 0) {
      servers[index] = { ...servers[index], ...server };
    } else {
      servers.push(server);
    }
    await this.saveMcpServers(servers);
    return server;
  }

  async removeMcpServer(id: string): Promise<boolean> {
    const servers = this.getMcpServers();
    const next = servers.filter((s) => s.id !== id);
    if (next.length === servers.length) {
      return false;
    }
    await this.saveMcpServers(next);
    await this.secrets.delete(`${MCP_SECRET_PREFIX}${id}`);
    return true;
  }

  async setMcpEnabled(id: string, enabled: boolean): Promise<void> {
    const servers = this.getMcpServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index < 0) {
      return;
    }
    servers[index] = { ...servers[index], enabled };
    await this.saveMcpServers(servers);
  }

  async hasMcpSecret(server: McpServerConfig): Promise<boolean> {
    const value = await this.secrets.get(`${MCP_SECRET_PREFIX}${server.id}`);
    return Boolean(value && value.length);
  }

  /** Injects stored secrets into env/headers so the client can connect. */
  async hydrateMcpServer(server: McpServerConfig): Promise<McpServerConfig> {
    const secret = await this.secrets.get(`${MCP_SECRET_PREFIX}${server.id}`);
    if (!secret) {
      return server;
    }
    const env = { ...(server.env ?? {}) };
    for (const key of server.envKeys ?? []) {
      if (!env[key]) {
        env[key] = secret;
      }
    }
    const headers = { ...(server.headers ?? {}) };
    for (const key of server.headerKeys ?? []) {
      if (!headers[key]) {
        headers[key] = key.toLowerCase() === 'authorization' && !/^(bearer|basic|token)\s/i.test(secret) ? `Bearer ${secret}` : secret;
      }
    }
    return { ...server, env, headers };
  }

  async listModelsFor(payload: { provider?: string; baseUrl?: string; apiKey?: string }): Promise<string[]> {
    const baseUrl = String(payload.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error('Enter a valid Base URL first (http:// or https://).');
    }
    const provider: ProviderKind = String(payload.provider ?? 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
    const temp: ModelConfig = { id: 'inline', name: 'inline', provider, baseUrl, modelId: '' };
    const impl = provider === 'anthropic'
      ? new (await import('../core/providers/anthropic')).AnthropicProvider()
      : new (await import('../core/providers/openai')).OpenAiCompatibleProvider();
    const key = payload.apiKey || (await this.getApiKey(this.getActiveModel() ?? temp));
    return withTimeout(impl.listModels(temp, key ?? undefined), 10000);
  }

  // ---------------------------------------------------------------- interactive flows

  async addModelInteractive(presetBaseUrl?: string): Promise<ModelConfig | undefined> {
    const name = await vscode.window.showInputBox({
      title: 'AM Code — Add model (1/5)',
      prompt: 'Display name for this model (e.g. "GPT-4o mini", "Local Qwen Coder")',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Required')
    });
    if (name === undefined) {
      return undefined;
    }

    const providerPick = await vscode.window.showQuickPick(
      [
        { label: 'OpenAI-compatible', description: 'Most providers: OpenAI, OpenRouter, Groq, DeepSeek, Ollama, LM Studio, vLLM, Together, Mistral, xAI…', value: 'openai' as ProviderKind },
        { label: 'Anthropic', description: 'Native /v1/messages API (api.anthropic.com or a compatible proxy)', value: 'anthropic' as ProviderKind }
      ],
      { title: 'AM Code — Add model (2/5)', placeHolder: 'API type', ignoreFocusOut: true }
    );
    if (!providerPick) {
      return undefined;
    }

    const baseUrl = await vscode.window.showInputBox({
      title: 'AM Code — Add model (3/5)',
      prompt: 'Base URL (without /chat/completions)',
      value: presetBaseUrl ?? (providerPick.value === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/.+/i.test(v.trim()) ? undefined : 'Must start with http:// or https://')
    });
    if (baseUrl === undefined) {
      return undefined;
    }

    const modelId = await this.askForModelId(providerPick.value, baseUrl.trim());
    if (!modelId) {
      return undefined;
    }

    const apiKey = await vscode.window.showInputBox({
      title: 'AM Code — Add model (5/5)',
      prompt: 'API key (stored in VS Code Secret Storage — leave empty for local servers without auth, e.g. Ollama)',
      password: true,
      ignoreFocusOut: true
    });
    if (apiKey === undefined) {
      return undefined;
    }

    const supportsTools = await pickBoolean(
      'AM Code — Tool calling',
      'Does this model support native function/tool calling?',
      'Yes — native tool calling (recommended)',
      'No — use the text-based tool protocol'
    );
    const supportsVision = await pickBoolean(
      'AM Code — Images',
      'Can this model read images (screenshots)?',
      'Yes',
      'No'
    );

    const model: ModelConfig = {
      id: makeModelId(baseUrl.trim(), modelId),
      name: name.trim(),
      provider: providerPick.value,
      baseUrl: baseUrl.trim(),
      modelId,
      maxTokens: 8192,
      temperature: 0,
      contextWindow: 128000,
      supportsTools: supportsTools !== false,
      supportsVision: supportsVision === true,
      headers: {}
    };
    if (apiKey) {
      await this.setApiKey(model, apiKey);
    }

    const models = this.getModels().filter((m) => m.id !== model.id);
    models.push(model);
    await this.saveModels(models);
    const configuredActive = cfg().get<string>('activeModel', '');
    if (!configuredActive || !models.some((m) => m.id === configuredActive)) {
      await this.setActiveModel(model.id);
    }
    return model;
  }

  private async askForModelId(provider: ProviderKind, baseUrl: string): Promise<string | undefined> {
    const manual = 'Type a model id manually…';
    const canList = /https?:\/\//i.test(baseUrl);
    let items: vscode.QuickPickItem[] = [];
    if (canList) {
      try {
        const providerImpl = provider === 'anthropic' ? new (await import('../core/providers/anthropic')).AnthropicProvider() : new (await import('../core/providers/openai')).OpenAiCompatibleProvider();
        const temp: ModelConfig = { id: 'tmp', name: 'tmp', provider, baseUrl, modelId: '' };
        const key = await this.secrets.get(SECRET_PREFIX + temp.id);
        const list: string[] = await withTimeout(providerImpl.listModels(temp, key ?? undefined), 8000);
        items = list.slice(0, 400).map((id: string) => ({ label: id }));
      } catch {
        items = [];
      }
    }
    const picked = await vscode.window.showQuickPick([...items, { label: manual }], {
      title: 'AM Code — Add model (4/5)',
      placeHolder: items.length ? `Model id (${items.length} found on the server — or type your own)` : 'Model id, e.g. gpt-4o-mini / qwen2.5-coder:7b',
      ignoreFocusOut: true
    });
    if (!picked) {
      return undefined;
    }
    if (picked.label === manual || items.length === 0) {
      const typed = await vscode.window.showInputBox({
        title: 'AM Code — Model ID',
        prompt: 'Exact model id sent to the API',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'Required')
      });
      return typed?.trim() || undefined;
    }
    return picked.label;
  }

  async editModelInteractive(modelId?: string): Promise<void> {
    const models = this.getModels();
    const model = modelId ? models.find((m) => m.id === modelId) : await pickModel(models, 'Select the model to edit');
    if (!model) {
      return;
    }
    const field = await vscode.window.showQuickPick(
      [
        { label: 'name', description: model.name },
        { label: 'baseUrl', description: model.baseUrl },
        { label: 'modelId', description: model.modelId },
        { label: 'provider', description: model.provider },
        { label: 'contextWindow', description: String(model.contextWindow ?? 128000) },
        { label: 'maxTokens', description: String(model.maxTokens ?? 8192) },
        { label: 'supportsTools', description: String(model.supportsTools !== false) },
        { label: 'supportsVision', description: String(model.supportsVision === true) },
        { label: 'API key', description: 'Stored in Secret Storage' }
      ],
      { title: `Edit "${model.name}"`, ignoreFocusOut: true }
    );
    if (!field) {
      return;
    }
    if (field.label === 'API key') {
      const key = await vscode.window.showInputBox({
        title: `API key for ${model.name}`,
        prompt: 'Leave empty to remove the stored key',
        password: true,
        ignoreFocusOut: true
      });
      if (key === undefined) {
        return;
      }
      await this.setApiKey(model, key);
      vscode.window.showInformationMessage(key ? `API key saved for ${model.name}.` : `API key removed for ${model.name}.`);
      return;
    }
    if (field.label === 'supportsTools' || field.label === 'supportsVision') {
      const value = await pickBoolean(`AM Code — ${field.label}`, `Enable ${field.label} for ${model.name}?`, 'Yes', 'No');
      if (value === undefined) {
        return;
      }
      (model as unknown as Record<string, unknown>)[field.label] = value;
    } else if (field.label === 'provider') {
      const pick = await vscode.window.showQuickPick(['openai', 'anthropic'], { title: 'Provider', ignoreFocusOut: true });
      if (!pick) {
        return;
      }
      model.provider = pick as ProviderKind;
    } else if (field.label === 'contextWindow' || field.label === 'maxTokens') {
      const value = await vscode.window.showInputBox({
        title: field.label,
        value: String((model as unknown as Record<string, unknown>)[field.label] ?? ''),
        ignoreFocusOut: true,
        validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Number expected')
      });
      if (value === undefined) {
        return;
      }
      (model as unknown as Record<string, unknown>)[field.label] = Number(value);
    } else {
      const value = await vscode.window.showInputBox({
        title: field.label,
        value: String((model as unknown as Record<string, unknown>)[field.label] ?? ''),
        ignoreFocusOut: true
      });
      if (value === undefined) {
        return;
      }
      (model as unknown as Record<string, unknown>)[field.label] = value.trim();
    }
    await this.saveModels(models.map((m) => (m.id === model.id ? model : m)));
    vscode.window.showInformationMessage(`Model "${model.name}" updated.`);
  }

  async removeModelInteractive(modelId?: string): Promise<void> {
    const models = this.getModels();
    const model = modelId ? models.find((m) => m.id === modelId) : await pickModel(models, 'Select the model to remove');
    if (!model) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(`Remove model "${model.name}"?`, { modal: true }, 'Remove');
    if (answer !== 'Remove') {
      return;
    }
    await this.deleteApiKey(model);
    const rest = models.filter((m) => m.id !== model.id);
    await this.saveModels(rest);
    if (this.getActiveModel()?.id === model.id) {
      await this.setActiveModel(rest[0]?.id ?? '');
    }
  }

  async selectModelInteractive(): Promise<ModelConfig | undefined> {
    const models = this.getModels();
    const model = await pickModel(models, 'Select the active model');
    if (model) {
      await this.setActiveModel(model.id);
    }
    return model;
  }

  /** Quick-ish connectivity check used by the "Test model" command. */
  async testModel(model: ModelConfig): Promise<string> {
    const key = await this.getApiKey(model);
    const provider = model.provider === 'anthropic'
      ? new (await import('../core/providers/anthropic')).AnthropicProvider()
      : new (await import('../core/providers/openai')).OpenAiCompatibleProvider();
    let text = '';
    const started = Date.now();
    for await (const event of provider.streamChat({
      model: { ...model, maxTokens: 64 },
      system: 'You are a connectivity probe. Answer with exactly: OK',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      tools: [],
      apiKey: key,
      maxTokens: 64
    })) {
      if (event.type === 'text' && event.text) {
        text += event.text;
      }
    }
    return `OK in ${Date.now() - started} ms · model "${model.modelId}" answered: ${text.trim().slice(0, 80) || '(empty)'}`;
  }
}

export function normalizeModel(entry: unknown): ModelConfig | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const raw = entry as Record<string, unknown>;
  const baseUrl = String(raw.baseUrl ?? '').trim();
  const modelId = String(raw.modelId ?? '').trim();
  if (!baseUrl || !modelId) {
    return undefined;
  }
  const provider = String(raw.provider ?? 'openai').toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
  return {
    id: String(raw.id ?? makeModelId(baseUrl, modelId)),
    name: String(raw.name ?? modelId),
    provider,
    baseUrl,
    modelId,
    apiKeyEnv: raw.apiKeyEnv ? String(raw.apiKeyEnv) : undefined,
    headers: (raw.headers && typeof raw.headers === 'object' ? raw.headers : {}) as Record<string, string>,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : 8192,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0,
    contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : 128000,
    supportsTools: raw.supportsTools !== false,
    supportsVision: raw.supportsVision === true
  };
}

export function makeMcpId(name: string, target: string): string {
  const base = `${name}-${target}`
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (base.slice(0, 40) || `mcp-${Date.now().toString(36)}`);
}

function normalizeMcpServer(entry: unknown): McpServerConfig | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const raw = entry as Record<string, unknown>;
  const transport = String(raw.transport ?? 'stdio').toLowerCase();
  const kind = transport === 'http' || transport === 'sse' ? transport : 'stdio';
  const command = raw.command === undefined ? undefined : String(raw.command);
  const url = raw.url === undefined ? undefined : String(raw.url);
  if (kind === 'stdio' && !command) {
    return undefined;
  }
  if (kind !== 'stdio' && !url) {
    return undefined;
  }
  return {
    id: String(raw.id ?? makeMcpId(String(raw.name ?? 'server'), url ?? command ?? '')),
    name: String(raw.name ?? 'MCP server'),
    transport: kind,
    command,
    args: Array.isArray(raw.args) ? (raw.args as unknown[]).map(String) : undefined,
    env: (raw.env && typeof raw.env === 'object' ? raw.env : undefined) as Record<string, string> | undefined,
    cwd: raw.cwd ? String(raw.cwd) : undefined,
    url,
    headers: (raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined) as
      | Record<string, string>
      | undefined,
    enabled: raw.enabled !== false,
    autoApproveTools: raw.autoApproveTools === true,
    toolFilter: Array.isArray(raw.toolFilter) ? (raw.toolFilter as unknown[]).map(String) : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    envKeys: Array.isArray(raw.envKeys) ? (raw.envKeys as unknown[]).map(String) : undefined,
    headerKeys: Array.isArray(raw.headerKeys) ? (raw.headerKeys as unknown[]).map(String) : undefined
  };
}

function parseKeyValueLines(text: string | undefined, colonSyntax = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const at = colonSyntax ? trimmed.indexOf(':') : trimmed.indexOf('=');
    if (at <= 0) {
      continue;
    }
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function splitArgs(text: string | undefined): string[] {
  const raw = (text ?? '').trim();
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(raw);
  while (match) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = pattern.exec(raw);
  }
  return out;
}

export function makeModelId(baseUrl: string, modelId: string): string {
  const slug = `${baseUrl}::${modelId}`
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 60) || `model-${Date.now().toString(36)}`;
}

async function pickModel(models: ModelConfig[], title: string): Promise<ModelConfig | undefined> {
  if (models.length === 0) {
    vscode.window.showInformationMessage('No models configured yet — run "AM Code: Add Model (Base URL + Model ID)".');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    models.map((m) => ({
      label: m.name,
      description: m.modelId,
      detail: `${m.provider} · ${m.baseUrl}`,
      model: m
    })),
    { title, ignoreFocusOut: true }
  );
  return picked?.model;
}

async function pickBoolean(title: string, question: string, yes: string, no: string): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: yes, value: true },
      { label: no, value: false }
    ],
    { title, placeHolder: question, ignoreFocusOut: true }
  );
  return picked?.value;
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}
