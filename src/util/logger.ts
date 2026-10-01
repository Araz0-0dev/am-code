import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('AM Code');
  }
  return channel;
}

export function log(...parts: unknown[]): void {
  const c = channel ?? initLogger();
  const text = parts
    .map((p) => (typeof p === 'string' ? p : safeJson(p)))
    .join(' ');
  c.appendLine(`[${new Date().toISOString()}] ${text}`);
}

export function logError(err: unknown): void {
  const c = channel ?? initLogger();
  if (err instanceof Error) {
    c.appendLine(`[${new Date().toISOString()}] ERROR ${err.message}\n${err.stack ?? ''}`);
  } else {
    c.appendLine(`[${new Date().toISOString()}] ERROR ${String(err)}`);
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
