import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { TOOL_NAMES } from '../core/tools';
import { AgentMode, EditRecord, ToolCall, ToolOutcome } from '../core/types';
import { log, logError } from '../util/logger';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.venv', 'venv',
  '__pycache__', 'target', '.turbo', '.cache', '.idea', '.vscode-test', 'vendor', '.tox', '.pytest_cache'
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.jar',
  '.exe', '.dll', '.so', '.dylib', '.class', '.pyc', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.lock'
]);

const MAX_READ_LINES = 2000;
const MAX_RESULT_CHARS = 16000;
const MAX_GREP_FILES = 1500;

export interface RunnerOptions {
  workspaceRoot: string;
  folder?: vscode.WorkspaceFolder;
  commandTimeoutMs: () => number;
  useIntegratedTerminal: () => boolean;
  enableWebTools: () => boolean;
  diagnosticsEnabled: () => boolean;
}

export class ToolRunner {
  private terminal?: vscode.Terminal;

  constructor(private readonly opts: RunnerOptions) {}

  async run(call: ToolCall, _mode: AgentMode): Promise<ToolOutcome> {
    try {
      switch (call.name) {
        case TOOL_NAMES.readFile:
          return await this.readFile(call.args);
        case TOOL_NAMES.writeFile:
          return await this.writeFile(call.args);
        case TOOL_NAMES.editFile:
          return await this.editFile(call.args);
        case TOOL_NAMES.deleteFile:
          return await this.deleteFile(call.args);
        case TOOL_NAMES.listDir:
          return await this.listDir(call.args);
        case TOOL_NAMES.glob:
          return await this.glob(call.args);
        case TOOL_NAMES.grep:
          return await this.grep(call.args);
        case TOOL_NAMES.diagnostics:
          return await this.diagnostics(call.args);
        case TOOL_NAMES.runCommand:
          return await this.runCommand(call.args);
        case TOOL_NAMES.fetchUrl:
          return await this.fetchUrl(call.args);
        default:
          return { ok: false, content: `Tool ${call.name} is not handled by the workspace runner.`, summary: 'unsupported tool' };
      }
    } catch (err) {
      logError(err);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Tool ${call.name} failed: ${message}`, summary: `${call.name} failed: ${message.slice(0, 80)}` };
    }
  }

  // ------------------------------------------------------------------ paths

  resolvePath(rel: unknown): { abs: string; rel: string } {
    const input = String(rel ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!input) {
      throw new Error('A path is required (workspace-relative, e.g. src/index.ts).');
    }
    const normalized = input.replace(/\\/g, '/');
    const abs = path.resolve(this.opts.workspaceRoot, normalized);
    const root = path.resolve(this.opts.workspaceRoot);
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      throw new Error(`Path "${input}" is outside the workspace. Only workspace-relative paths are allowed.`);
    }
    return { abs, rel: relToRoot === '' ? '.' : relToRoot.split(path.sep).join('/') };
  }

  // ------------------------------------------------------------------ read tools

  private async readFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const { abs, rel } = this.resolvePath(args.path);
    const stat = await safeStat(abs);
    if (!stat) {
      const suggestions = await this.suggestSimilar(rel);
      return {
        ok: false,
        content: `File not found: ${rel}.${suggestions.length ? `\nDid you mean one of these?\n${suggestions.map((s) => `- ${s}`).join('\n')}` : '\nUse glob or list_dir to find the right path.'}`,
        summary: `read_file failed: ${rel} not found`
      };
    }
    if (stat.isDirectory()) {
      return {
        ok: false,
        content: `${rel} is a directory. Use list_dir (or glob) instead.`,
        summary: `read_file: ${rel} is a directory`
      };
    }
    if (stat.size > 2_000_000) {
      return {
        ok: false,
        content: `File ${rel} is ${(stat.size / 1_000_000).toFixed(1)} MB — too large to read. Use grep to find the part you need.`,
        summary: `read_file skipped: ${rel} too large`
      };
    }
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) {
      return { ok: false, content: `${rel} looks like a binary file and cannot be read as text.`, summary: `read_file: binary ${rel}` };
    }

    const raw = await fs.readFile(abs, 'utf8');
    if (raw.includes('\u0000')) {
      return { ok: false, content: `${rel} appears to be binary (contains NUL bytes).`, summary: `read_file: binary ${rel}` };
    }
    const lines = raw.split(/\r?\n/);
    const total = lines.length;
    const start = Math.max(1, Number(args.start_line ?? 1) || 1);
    const requestedEnd = Number(args.end_line ?? 0) || start + MAX_READ_LINES - 1;
    const end = Math.min(total, Math.max(start, Math.min(requestedEnd, start + MAX_READ_LINES - 1)));
    const slice = lines.slice(start - 1, end);
    const width = String(end).length;
    const body = slice.map((line, i) => `${String(start + i).padStart(width)}| ${line}`).join('\n');
    const truncated = end < total;
    const header = `File: ${rel} — ${total} lines${start > 1 || end < total ? `, showing ${start}-${end}` : ''}`;
    const footer = truncated ? `\n\n[${total - end} more lines — call read_file again with start_line=${end + 1}]` : '';
    return {
      ok: true,
      content: `${header}\n\n${body}${footer}`,
      summary: `read ${rel} (${end - start + 1} lines)`
    };
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const { abs, rel } = this.resolvePath(args.path);
    const content = typeof args.content === 'string' ? args.content : '';
    const existing = await readIfExists(abs);
    if (existing !== undefined && existing === content) {
      return { ok: true, content: `No change needed: ${rel} already has exactly this content.`, summary: `no-op write ${rel}` };
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const record: EditRecord = {
      path: rel,
      before: existing ?? '',
      after: content,
      existedBefore: existing !== undefined,
      tool: TOOL_NAMES.writeFile,
      kind: existing === undefined ? 'create' : 'edit',
      ts: Date.now()
    };
    const lines = content.split(/\r?\n/).length;
    return {
      ok: true,
      content: `${existing === undefined ? 'Created' : 'Overwrote'} ${rel} (${lines} lines).${typeof args.explanation === 'string' ? `\nNote: ${args.explanation}` : ''}`,
      summary: `${existing === undefined ? 'created' : 'wrote'} ${rel} (${lines} lines)`,
      edits: [record]
    };
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const { abs, rel } = this.resolvePath(args.path);
    const oldText = typeof args.old_text === 'string' ? args.old_text : '';
    const newText = typeof args.new_text === 'string' ? args.new_text : '';
    const replaceAll = args.replace_all === true;
    if (!oldText) {
      return { ok: false, content: 'old_text is empty. Provide the exact snippet to replace (or use write_file for a full rewrite).', summary: 'edit_file: empty old_text' };
    }
    const original = await readIfExists(abs);
    if (original === undefined) {
      return { ok: false, content: `File not found: ${rel}. Use write_file to create it.`, summary: `edit_file: ${rel} not found` };
    }
    const { content: updated, matches, method } = applyEdit(original, oldText, newText, replaceAll);
    if (matches === 0) {
      const hint = buildNoMatchHint(original, oldText, newText);
      return {
        ok: false,
        content: `Could not find old_text in ${rel}.${hint}`,
        summary: `edit_file: no match in ${rel}`
      };
    }
    if (matches > 1 && !replaceAll) {
      return {
        ok: false,
        content: `old_text matches ${matches} places in ${rel}. Add more surrounding context to make it unique, or pass replace_all: true.`,
        summary: `edit_file: ${matches} matches in ${rel}`
      };
    }
    await fs.writeFile(abs, updated, 'utf8');
    const record: EditRecord = {
      path: rel,
      before: original,
      after: updated,
      existedBefore: true,
      tool: TOOL_NAMES.editFile,
      kind: 'edit',
      ts: Date.now()
    };
    const info = summarizeDiff(original, updated);
    return {
      ok: true,
      content: `Edited ${rel} (${matches > 1 && replaceAll ? `${matches} replacements` : '1 replacement'}, ${method}). ${info}\n${typeof args.explanation === 'string' ? `Note: ${args.explanation}` : ''}`,
      summary: `edited ${rel} (${info})`,
      edits: [record]
    };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<ToolOutcome> {
    const { abs, rel } = this.resolvePath(args.path);
    const before = await readIfExists(abs);
    if (before === undefined) {
      return { ok: false, content: `File not found: ${rel}`, summary: `delete_file: ${rel} not found` };
    }
    await fs.unlink(abs);
    const record: EditRecord = { path: rel, before, after: '', existedBefore: true, tool: TOOL_NAMES.deleteFile, kind: 'delete', ts: Date.now() };
    return {
      ok: true,
      content: `Deleted ${rel} (${before.split(/\r?\n/).length} lines). The user can restore it with "AM Code: Undo Last Agent Change".`,
      summary: `deleted ${rel}`,
      edits: [record]
    };
  }

  private async listDir(args: Record<string, unknown>): Promise<ToolOutcome> {
    const { abs, rel } = this.resolvePath(args.path ?? '.');
    const recursive = args.recursive === true;
    const lines: string[] = [];
    await walk(abs, rel === '.' ? '' : rel, recursive ? 3 : 0, 0, lines, 500);
    if (lines.length === 0) {
      return { ok: true, content: `Directory ${rel} is empty (or contains only ignored entries).`, summary: `list_dir ${rel}: empty` };
    }
    return {
      ok: true,
      content: `${rel === '.' ? 'Workspace root' : rel}:\n${lines.join('\n')}`,
      summary: `listed ${rel} (${lines.length} entries)`
    };
  }

  private async glob(args: Record<string, unknown>): Promise<ToolOutcome> {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) {
      return { ok: false, content: 'pattern is required, e.g. "src/**/*.ts".', summary: 'glob: missing pattern' };
    }
    const searchRoot = args.path ? this.resolvePath(args.path).abs : this.opts.workspaceRoot;
    const include = new vscode.RelativePattern(vscode.Uri.file(searchRoot), pattern);
    const files = await vscode.workspace.findFiles(include, undefined, 400);
    if (files.length === 0) {
      return { ok: true, content: `No files matched "${pattern}".`, summary: `glob "${pattern}": 0 files` };
    }
    const list = files.map((f) => vscode.workspace.asRelativePath(f, false)).sort();
    return {
      ok: true,
      content: `${list.length} file(s) matching "${pattern}":\n${list.join('\n')}`,
      summary: `glob "${pattern}": ${list.length} files`
    };
  }

  private async grep(args: Record<string, unknown>): Promise<ToolOutcome> {
    const query = String(args.query ?? '');
    if (!query) {
      return { ok: false, content: 'query is required.', summary: 'grep: missing query' };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(query, args.case_sensitive === true ? 'g' : 'gi');
    } catch (err) {
      return { ok: false, content: `Invalid regular expression: ${(err as Error).message}`, summary: 'grep: bad regex' };
    }
    const max = Math.max(1, Math.min(300, Number(args.max_results ?? 60)));
    const searchRoot = args.path ? this.resolvePath(args.path).abs : this.opts.workspaceRoot;
    const globPattern = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '**/*';
    const include = new vscode.RelativePattern(vscode.Uri.file(searchRoot), globPattern);
    const files = await vscode.workspace.findFiles(include, '**/{node_modules,.git,dist,out,build,coverage,.next,target}/**', MAX_GREP_FILES);

    const results: string[] = [];
    let scanned = 0;
    let hits = 0;
    for (const file of files) {
      if (hits >= max) {
        break;
      }
      const ext = path.extname(file.fsPath).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        continue;
      }
      const stat = await safeStat(file.fsPath);
      if (!stat || stat.size > 1_500_000) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(file.fsPath, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      const relPath = vscode.workspace.asRelativePath(file, false);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits < max; i += 1) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          hits += 1;
          results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        }
      }
    }
    if (results.length === 0) {
      return {
        ok: true,
        content: `No matches for /${query}/ in ${scanned} searched file(s). Try a shorter pattern or a different glob.`,
        summary: `grep "${query}": 0 matches`
      };
    }
    const note = hits >= max ? `\n\n[stopped at max_results=${max} — narrow the query if you need more]` : '';
    return {
      ok: true,
      content: `${hits} match(es) for /${query}/ (${scanned} files scanned):\n${results.join('\n')}${note}`,
      summary: `grep "${query}": ${hits} matches`
    };
  }

  private async diagnostics(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.opts.diagnosticsEnabled()) {
      return { ok: false, content: 'Diagnostics are disabled in settings (agentcode.includeDiagnostics).', summary: 'diagnostics disabled' };
    }
    const max = Math.max(1, Math.min(200, Number(args.max_results ?? 40)));
    let filter: string | undefined;
    if (args.path) {
      filter = this.resolvePath(args.path).rel;
    }
    const all = vscode.languages.getDiagnostics();
    const entries: string[] = [];
    let total = 0;
    for (const [uri, diags] of all) {
      if (uri.scheme !== 'file' || diags.length === 0) {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(uri, false);
      if (filter && rel !== filter && !rel.startsWith(`${filter}/`)) {
        continue;
      }
      for (const d of diags) {
        total += 1;
        if (entries.length >= max) {
          continue;
        }
        const severity = vscode.DiagnosticSeverity[d.severity] ?? 'Info';
        const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
        entries.push(`${rel}:${pos} [${severity}] ${d.message.split('\n')[0].slice(0, 260)}${d.source ? ` (${d.source})` : ''}`);
      }
    }
    if (total === 0) {
      return {
        ok: true,
        content: filter ? `No problems reported for ${filter}.` : 'No problems reported in the workspace (language servers report clean).',
        summary: 'diagnostics: clean'
      };
    }
    return {
      ok: true,
      content: `${total} problem(s)${filter ? ` in ${filter}` : ''}${entries.length < total ? ` (showing ${entries.length})` : ''}:\n${entries.join('\n')}`,
      summary: `diagnostics: ${total} problem(s)`
    };
  }

  private async runCommand(args: Record<string, unknown>): Promise<ToolOutcome> {
    const command = String(args.command ?? '').trim();
    if (!command) {
      return { ok: false, content: 'command is required.', summary: 'run_command: missing command' };
    }
    const cwd = args.cwd ? this.resolvePath(args.cwd).abs : this.opts.workspaceRoot;
    const timeout = Math.max(1000, Math.min(600_000, Number(args.timeout_ms ?? this.opts.commandTimeoutMs())));
    const started = Date.now();
    log(`run_command: ${command} (cwd=${cwd})`);

    if (this.opts.useIntegratedTerminal()) {
      this.mirrorToTerminal(command, cwd);
    }

    const result = await execAsync(command, { cwd, timeout, maxBuffer: 12 * 1024 * 1024 });
    const duration = ((Date.now() - started) / 1000).toFixed(1);
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const combined = [stdout, stderr]
      .filter((s) => s.trim().length > 0)
      .join(stderr && stdout ? '\n--- stderr ---\n' : '')
      .trim();
    const tail = truncateMiddle(combined || '(no output)', MAX_RESULT_CHARS);
    const status = result.code === 0 ? 'succeeded' : `failed with exit code ${result.code}${result.timedOut ? ' (timeout)' : ''}`;
    const content = `$ ${command}\n(exit ${result.code ?? 'killed'}${result.timedOut ? ', timed out' : ''}, ${duration}s) — ${status}\n\n${tail}`;
    return {
      ok: result.code === 0,
      content,
      summary: `$ ${command.slice(0, 60)} → exit ${result.code ?? '?'} (${duration}s)`
    };
  }

  private async fetchUrl(args: Record<string, unknown>): Promise<ToolOutcome> {
    if (!this.opts.enableWebTools()) {
      return { ok: false, content: 'Web tools are disabled (agentcode.enableWebTools).', summary: 'fetch_url disabled' };
    }
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, content: 'Only http(s) URLs are supported.', summary: 'fetch_url: bad url' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'amcode-vscode' } });
      const raw = await res.text();
      const text = stripHtml(raw);
      return {
        ok: res.ok,
        content: `GET ${url} → ${res.status}\n\n${truncateMiddle(text, MAX_RESULT_CHARS)}`,
        summary: `fetch ${url.slice(0, 60)} → ${res.status}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private mirrorToTerminal(command: string, cwd: string): void {
    try {
      if (!this.terminal || this.terminal.exitStatus !== undefined) {
        this.terminal = vscode.window.createTerminal({ name: 'AM Code', cwd });
      }
      this.terminal.show(true);
      this.terminal.sendText(command, true);
    } catch (err) {
      logError(err);
    }
  }

  private async suggestSimilar(rel: string): Promise<string[]> {
    const base = path.basename(rel);
    if (!base) {
      return [];
    }
    const found = await vscode.workspace.findFiles(`**/${base}`, '**/{node_modules,.git}/**', 6);
    return found.map((f) => vscode.workspace.asRelativePath(f, false));
  }
}

// -------------------------------------------------------------------- helpers

function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean
): { content: string; matches: number; method: string } {
  const exact = countOccurrences(content, oldText);
  if (exact > 0) {
    return { content: replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText), matches: exact, method: 'exact' };
  }

  // whitespace-tolerant match (differs in indentation / trailing spaces / line endings)
  const flexible = buildFlexibleRegex(oldText);
  if (flexible) {
    const matches = [...content.matchAll(new RegExp(flexible.source, flexible.flags.includes('g') ? flexible.flags : `${flexible.flags}g`))];
    if (matches.length > 0) {
      const target = replaceAll ? matches : [matches[0]];
      let updated = content;
      for (const m of target.reverse()) {
        updated = updated.slice(0, m.index ?? 0) + newText + updated.slice((m.index ?? 0) + m[0].length);
      }
      return { content: updated, matches: matches.length, method: 'whitespace-tolerant' };
    }
  }
  return { content, matches: 0, method: 'none' };
}

function buildFlexibleRegex(oldText: string): RegExp | undefined {
  const lines = oldText.replace(/\r\n/g, '\n').split('\n');
  const escaped = lines.map((line) => escapeRegExp(line.trim()).replace(/\\\s+/g, '\\s+'));
  const pattern = escaped.join('\\s*\\n\\s*');
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return undefined;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index < 0) {
      break;
    }
    count += 1;
    index += needle.length;
  }
  return count;
}

function buildNoMatchHint(content: string, oldText: string, newText: string): string {
  const firstLine = oldText.split('\n')[0].trim();
  if (firstLine) {
    const lines = content.split(/\r?\n/);
    const guesses = lines
      .map((line, i) => ({ line: line.trim(), i }))
      .filter(({ line }) => firstLine && (line.includes(firstLine.slice(0, 24)) || firstLine.includes(line.slice(0, 24))))
      .slice(0, 3);
    if (guesses.length) {
      return `\nA similar line exists at ${guesses.map((g) => `line ${g.i + 1}`).join(', ')}:\n${guesses
        .map((g) => `  ${g.i + 1}| ${g.line}`)
        .join('\n')}\nRe-read that region and copy the text exactly (the file may use different indentation or line endings).`;
    }
  }
  if (newText && content.includes(newText.trim().slice(0, 40)) && newText.trim().length > 20) {
    return '\nIt looks like this change is already applied — verify with read_file before editing again.';
  }
  return '\nRe-read the file (read_file) and copy the exact snippet, including indentation.';
}

function summarizeDiff(before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length === b.length) {
    let changed = 0;
    let firstLine = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        changed += 1;
        if (!firstLine) {
          firstLine = i + 1;
        }
      }
    }
    return changed > 0 ? `+${changed}/-${changed} lines (first at line ${firstLine})` : 'no textual change';
  }
  const added = Math.max(0, b.length - a.length);
  const removed = Math.max(0, a.length - b.length);
  return `+${added}/-${removed} lines`;
}

async function walk(abs: string, rel: string, maxDepth: number, depth: number, out: string[], limit: number): Promise<void> {
  if (out.length >= limit) {
    return;
  }
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  for (const entry of entries) {
    if (out.length >= limit) {
      out.push('… (truncated)');
      return;
    }
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.DS_Store')) {
      continue;
    }
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${childRel}/`);
      if (depth < maxDepth) {
        await walk(path.join(abs, entry.name), childRel, maxDepth, depth + 1, out, limit);
      }
    } else {
      const stat = await safeStat(path.join(abs, entry.name));
      out.push(`${childRel}${stat ? ` (${formatSize(stat.size)})` : ''}`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function safeStat(abs: string): Promise<import('fs').Stats | undefined> {
  try {
    return await fs.stat(abs);
  } catch {
    return undefined;
  }
}

async function readIfExists(abs: string): Promise<string | undefined> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.floor(max * 0.35);
  const tail = max - head - 60;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} characters omitted]…\n${text.slice(-tail)}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function execAsync(command: string, options: { cwd: string; timeout: number; maxBuffer: number }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd: options.cwd, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: number | string }) | null)?.code;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof code === 'number' ? code : error ? 1 : 0,
          timedOut: Boolean((error as (Error & { killed?: boolean }) | null)?.killed)
        });
      }
    );
    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, code: 1, timedOut: false });
    });
  });
}
