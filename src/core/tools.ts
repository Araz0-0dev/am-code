import { ToolDefinition } from './types';

/**
 * Tool registry. The descriptions are written for the model (they are the "API docs" it reads),
 * and `kind` drives the permission system (read = auto, write = diff + approval, exec = approval).
 */

interface Options {
  enableWebTools: boolean;
  subagents: boolean;
}

export const TOOL_NAMES = {
  readFile: 'read_file',
  writeFile: 'write_file',
  editFile: 'edit_file',
  deleteFile: 'delete_file',
  listDir: 'list_dir',
  glob: 'glob',
  grep: 'grep',
  diagnostics: 'get_diagnostics',
  runCommand: 'run_command',
  fetchUrl: 'fetch_url',
  updateTodos: 'update_todos',
  plan: 'plan',
  attemptCompletion: 'attempt_completion',
  askUser: 'ask_user',
  spawnAgent: 'spawn_agent'
} as const;

export function buildToolDefinitions(opts: Options): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: TOOL_NAMES.readFile,
      kind: 'read',
      description:
        'Read a text file from the workspace. Always read before editing. Output is line-numbered so you can reference specific lines. Use start_line/end_line for large files (default reads up to 2000 lines).',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path, e.g. src/index.ts' },
          start_line: { type: 'number', description: '1-based first line (optional)' },
          end_line: { type: 'number', description: '1-based last line, inclusive (optional)' }
        },
        required: ['path']
      }
    },
    {
      name: TOOL_NAMES.writeFile,
      kind: 'write',
      description:
        'Create a new file or completely overwrite an existing one. Only use for new files or full rewrites — for existing files prefer edit_file, which is safer and cheaper.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path' },
          content: { type: 'string', description: 'Full file content' },
          explanation: { type: 'string', description: 'One sentence: what this file does and why' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: TOOL_NAMES.editFile,
      kind: 'write',
      description:
        'Replace an exact snippet of text in an existing file. old_text must match the file including indentation (2-4 lines of context are usually enough to be unique). This is your main editing tool.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path' },
          old_text: { type: 'string', description: 'Exact text to find (copy it from the file)' },
          new_text: { type: 'string', description: 'Replacement text (empty string deletes the snippet)' },
          explanation: { type: 'string', description: 'Short explanation of the change' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    },
    {
      name: TOOL_NAMES.deleteFile,
      kind: 'write',
      description: 'Delete a file from the workspace (recoverable with /undo). Use sparingly.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path' },
          explanation: { type: 'string', description: 'Why this file should be deleted' }
        },
        required: ['path']
      }
    },
    {
      name: TOOL_NAMES.listDir,
      kind: 'read',
      description:
        'List a directory. Respects .gitignore-style noise (.git, node_modules, dist are skipped unless requested). Use recursive=true for a project tree (depth-limited).',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory (default: workspace root)' },
          recursive: { type: 'boolean', description: 'Walk sub-directories (default false, max depth 3)' }
        }
      }
    },
    {
      name: TOOL_NAMES.glob,
      kind: 'read',
      description: 'Find files by glob pattern, e.g. "src/**/*.ts", "**/*.test.ts", "**/package.json".',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Directory to search in (default: workspace root)' }
        },
        required: ['pattern']
      }
    },
    {
      name: TOOL_NAMES.grep,
      kind: 'read',
      description:
        'Search file contents with a regular expression (ripgrep-like). Returns path:line: text. Use it to find symbols, usages, TODOs. Prefer a narrow `glob` to keep results small.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Regular expression to search for' },
          path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
          glob: { type: 'string', description: 'File filter, e.g. "**/*.ts"' },
          case_sensitive: { type: 'boolean', description: 'Default false' },
          max_results: { type: 'number', description: 'Max matches returned (default 60)' }
        },
        required: ['query']
      }
    },
    {
      name: TOOL_NAMES.diagnostics,
      kind: 'read',
      description:
        'Read real compiler/linter errors and warnings from the VS Code language servers (LSP). Call this after edits — it is the fastest way to verify you did not break the code.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Limit to one file (optional; default: whole workspace)' },
          max_results: { type: 'number', description: 'Default 40' }
        }
      }
    },
    {
      name: TOOL_NAMES.runCommand,
      kind: 'exec',
      description:
        'Run a shell command in the workspace and get stdout+stderr+exit code. Use for tests, linters, builds, package managers, git inspection. Non-interactive commands only; no servers/watchers (append " &" would be ignored). Output is truncated to the last ~14k characters.',
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact command, e.g. "npm test -- --runInBand"' },
          cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
          timeout_ms: { type: 'number', description: 'Timeout, default 120000' },
          explanation: { type: 'string', description: 'Why you are running this' }
        },
        required: ['command']
      }
    },
    {
      name: TOOL_NAMES.updateTodos,
      kind: 'meta',
      description:
        'Create or update your task checklist. Send the COMPLETE list every time (the host replaces the previous list). Statuses: pending | in_progress | completed | cancelled. Exactly one item should be in_progress at a time. Mark an item completed only when the work is done and verified, and add a short note describing the outcome.',
      schema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full checklist, in execution order',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Short stable id, e.g. "1" or "scaffold"' },
                content: { type: 'string', description: 'Imperative one-line task, e.g. "Add POST /users handler"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                note: { type: 'string', description: 'Short result note, mainly for completed items' }
              },
              required: ['content', 'status']
            }
          },
          explanation: { type: 'string', description: 'Optional one-line note about why the list changed' }
        },
        required: ['todos']
      }
    },
    {
      name: TOOL_NAMES.plan,
      kind: 'plan',
      description:
        'PLAN MODE ONLY. Present a complete implementation plan for the user to approve. Call this once, after you have finished exploring, and then stop and wait.',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '2-4 sentence description of the approach' },
          steps: {
            type: 'array',
            description: 'Ordered implementation steps',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative step title' },
                details: { type: 'string', description: 'What exactly changes, and how' },
                files: { type: 'array', items: { type: 'string' }, description: 'Files created/modified' }
              },
              required: ['title']
            }
          },
          open_questions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Decisions you need the user to make, if any'
          }
        },
        required: ['summary', 'steps']
      }
    },
    {
      name: TOOL_NAMES.attemptCompletion,
      kind: 'meta',
      description:
        'Signal that the task is finished. Allowed only when every checklist item is completed or cancelled. Use the result field for a concise report, not for questions.',
      schema: {
        type: 'object',
        properties: {
          result: {
            type: 'string',
            description: 'Short markdown report: what changed (files, behaviour), what you verified, and any follow-ups or caveats.'
          },
          files_changed: { type: 'array', items: { type: 'string' }, description: 'Paths you created/modified/deleted' },
          verified: { type: 'string', description: 'The commands/checks you ran and their outcome' }
        },
        required: ['result']
      }
    },
    {
      name: TOOL_NAMES.askUser,
      kind: 'meta',
      description:
        'Ask the user one blocking question with concrete options, when the request is genuinely ambiguous or a choice has real consequences. Do not use it for things you can find out yourself.',
      schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question' },
          options: { type: 'array', items: { type: 'string' }, description: '2-5 concrete options' },
          allow_free_text: { type: 'boolean', description: 'Default true' }
        },
        required: ['question']
      }
    }
  ];

  if (opts.subagents) {
    tools.push({
      name: TOOL_NAMES.spawnAgent,
      kind: 'read',
      description:
        'Launch a read-only research sub-agent that works in its own fresh context and returns only a short report. Great for "find every place that touches X" style questions in a big codebase.',
      schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A precise, self-contained research question' },
          agent: {
            type: 'string',
            enum: ['explore', 'general'],
            description: 'explore = fast code search; general = deeper analysis and reasoning'
          }
        },
        required: ['task']
      }
    });
  }

  if (opts.enableWebTools) {
    tools.push({
      name: TOOL_NAMES.fetchUrl,
      kind: 'read',
      description: 'Fetch a public URL and return its text content (for documentation lookups).',
      schema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'https URL' } },
        required: ['url']
      }
    });
  }

  return tools;
}

export function toolDefinitionMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((t) => [t.name, t]));
}
