import * as vscode from 'vscode';

const SCHEME = 'agentcode-preview';

/**
 * Serves *proposed* file contents for the diff view, so the user can inspect what the agent
 * wants to change before approving it (and afterwards, until the real file is written).
 */
export class PreviewDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  set(key: string, content: string): vscode.Uri {
    const uri = this.uriForKey(key);
    this.contents.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
    return uri;
  }

  clear(key: string): void {
    this.contents.delete(this.uriForKey(key).toString());
  }

  uriForKey(key: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}:${encodeURIComponent(key)}`);
  }

  /** Opens a real VS Code side-by-side diff: on-disk file ↔ proposed content. */
  async openDiff(relPath: string, proposed: string, title?: string): Promise<vscode.Uri | undefined> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      return undefined;
    }
    const target = vscode.Uri.joinPath(root.uri, relPath);
    const uri = this.set(`${relPath}::${Date.now()}`, proposed);
    const left = await fileExists(target) ? target : this.set(`${relPath}::empty::${Date.now()}`, '');
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      uri,
      title ?? `AM Code: ${relPath} (before ↔ after)`,
      { preview: true, viewColumn: vscode.ViewColumn.Beside }
    );
    return uri;
  }

  dispose(): void {
    this.contents.clear();
    this.onDidChangeEmitter.dispose();
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Very light inline decoration so agent edits are visible directly in the editor.
 * (The sidebar "Pending Changes" view + the diff command do the heavy lifting.)
 */
export class ChangeDecorator implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });

  private pending = new Map<string, vscode.Range>();

  focus(relPath: string, startLine: number, endLine: number): void {
    this.pending.set(relPath, new vscode.Range(startLine - 1, 0, Math.max(startLine - 1, endLine - 1), 0));
  }

  clear(relPath?: string): void {
    if (relPath) {
      this.pending.delete(relPath);
    } else {
      this.pending.clear();
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  refresh(editor: vscode.TextEditor): void {
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const range = this.pending.get(rel);
    editor.setDecorations(this.decoration, range ? [range] : []);
  }

  dispose(): void {
    this.pending.clear();
    this.decoration.dispose();
  }
}
