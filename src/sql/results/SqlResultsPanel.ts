import * as vscode from 'vscode';
import type {
  SqlResultsHostMessage,
  SqlResultsWebviewMessage,
  SqlRunSnapshot,
} from '../../../shared/types';
import { ConnectionManager } from '../../connection/ConnectionManager';
import { isQueryCancelledError } from '../execution/QueryCancelledError';
import { SqlExecutionService } from '../execution/SqlExecutionService';
import { SqlRunRegistry } from '../execution/SqlRunRegistry';

/**
 * Tabular SQL Results webview panel. UI-only — all execution stays on the host
 * behind SqlPolicyGate via SqlExecutionService.
 */
export class SqlResultsPanel {
  public static readonly viewType = 'erdWorkbench.sqlResults';

  private panel: vscode.WebviewPanel | undefined;
  private currentRun: SqlRunSnapshot | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly sql: SqlExecutionService,
    private readonly runs: SqlRunRegistry
  ) {}

  reveal(): void {
    this.ensurePanel();
    this.panel?.reveal(vscode.ViewColumn.Beside, true);
  }

  get hasActiveRun(): boolean {
    return this.runs.size > 0;
  }

  cancelActive(): boolean {
    const cancelled = this.runs.cancelLatest();
    if (cancelled && this.currentRun?.status === 'running') {
      void this.post({
        type: 'runProgress',
        runId: this.currentRun.runId,
        message: 'Cancelling…',
      });
    }
    return cancelled;
  }

  async execute(
    connectionId: string,
    sqlText: string,
    options?: { cancellationToken?: vscode.CancellationToken }
  ): Promise<void> {
    const profile = this.connections.getProfile(connectionId);
    if (!profile) {
      throw new Error(`Unknown connection: ${connectionId}`);
    }

    this.ensurePanel();
    this.panel?.reveal(vscode.ViewColumn.Beside, true);

    const active = this.runs.create(connectionId);
    const token = options?.cancellationToken;
    const tokenSub = token?.onCancellationRequested(() => {
      this.runs.cancel(active.runId);
    });
    if (token?.isCancellationRequested) {
      this.runs.cancel(active.runId);
    }

    const preview = sqlText.trim().replace(/\s+/g, ' ').slice(0, 160);
    const snapshot: SqlRunSnapshot = {
      runId: active.runId,
      connectionId,
      connectionName: profile.name,
      sqlPreview: preview,
      status: 'running',
      startedAt: new Date().toISOString(),
      results: [],
    };
    this.currentRun = snapshot;
    void vscode.commands.executeCommand('setContext', 'erdWorkbench.sqlRunning', true);
    this.post({ type: 'runStarted', run: snapshot });

    try {
      const outcome = await this.sql.executeAll(connectionId, sqlText, 'sql-runner', {
        signal: active.controller.signal,
        onStatementComplete: (index, total) => {
          this.post({
            type: 'runProgress',
            runId: active.runId,
            message: `Statement ${index + 1}/${total}…`,
          });
        },
      });

      if (active.controller.signal.aborted) {
        throw new Error('Query cancelled');
      }

      const completed: SqlRunSnapshot = {
        ...snapshot,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        results: outcome.results,
        totalDurationMs: outcome.totalDurationMs,
      };
      this.currentRun = completed;
      this.post({ type: 'runCompleted', run: completed });
    } catch (err) {
      const cancelled = isQueryCancelledError(err) || active.controller.signal.aborted;
      const failed: SqlRunSnapshot = {
        ...snapshot,
        status: cancelled ? 'cancelled' : 'error',
        finishedAt: new Date().toISOString(),
        results: this.currentRun?.results ?? [],
        error: cancelled
          ? 'Query cancelled'
          : err instanceof Error
            ? err.message
            : String(err),
        totalDurationMs: Date.now() - active.startedAt,
      };
      this.currentRun = failed;
      this.post({
        type: cancelled ? 'runCancelled' : 'runError',
        run: failed,
      });
      if (!cancelled) {
        throw err;
      }
    } finally {
      tokenSub?.dispose();
      this.runs.complete(active.runId);
      void vscode.commands.executeCommand(
        'setContext',
        'erdWorkbench.sqlRunning',
        this.runs.size > 0
      );
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.panel?.dispose();
    this.panel = undefined;
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      SqlResultsPanel.viewType,
      'SQL Results',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      }
    );
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: SqlResultsWebviewMessage) => {
        void this.handleMessage(raw);
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.post({ type: 'theme', theme: this.theme() });
      }),
      panel.onDidDispose(() => {
        this.panel = undefined;
      })
    );

    return panel;
  }

  private async handleMessage(msg: SqlResultsWebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.post({
          type: 'init',
          theme: this.theme(),
          run: this.currentRun,
        });
        break;
      }
      case 'cancelRun': {
        this.runs.cancel(msg.runId);
        break;
      }
      case 'copyTsv': {
        const result = this.currentRun?.results[msg.resultIndex];
        if (!result) {
          return;
        }
        const lines = [
          result.columns.join('\t'),
          ...result.rows.map((r) => result.columns.map((c) => formatCell(r[c])).join('\t')),
        ];
        await vscode.env.clipboard.writeText(lines.join('\n'));
        void vscode.window.showInformationMessage('Copied result set as TSV');
        break;
      }
      default:
        break;
    }
  }

  private post(msg: SqlResultsHostMessage): void {
    void this.panel?.webview.postMessage(msg);
  }

  private theme(): 'light' | 'dark' {
    return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'sqlResults.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'sqlResults.css')
    );
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>SQL Results</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
