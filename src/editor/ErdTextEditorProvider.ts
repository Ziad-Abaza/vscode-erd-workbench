import * as vscode from 'vscode';
import {
  ERD_FORMAT_VERSION,
  createEmptyDiagram,
  type ErdDocument,
  type HostToWebviewMessage,
  type WebviewToHostMessage,
} from '../../shared/types';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { MutationPipeline } from '../mutation/MutationPipeline';
import { layoutSubgraph } from '../diagram/layout';

export class ErdTextEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'erdWorkbench.diagram';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly catalog: SchemaCatalogService,
    private readonly mutations: MutationPipeline
  ) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const post = (msg: HostToWebviewMessage) => {
      void webviewPanel.webview.postMessage(msg);
    };

    const sendInit = () => {
      const doc = parseDocument(document.getText());
      const summaries = this.catalog.getSummaries(doc.connectionId);
      const theme =
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
      post({ type: 'init', document: doc, catalogSummary: summaries, theme });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      try {
        const doc = parseDocument(e.document.getText());
        post({ type: 'documentChanged', document: doc, version: e.document.version });
      } catch {
        // Invalid intermediate JSON while typing in text editor — ignore
      }
    });

    webviewPanel.onDidDispose(() => changeSub.dispose());

    webviewPanel.webview.onDidReceiveMessage(async (raw: WebviewToHostMessage) => {
      try {
        await this.handleMessage(document, raw, post);
      } catch (err) {
        post({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    sendInit();
  }

  private async handleMessage(
    document: vscode.TextDocument,
    msg: WebviewToHostMessage,
    post: (m: HostToWebviewMessage) => void
  ): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const doc = parseDocument(document.getText());
        post({
          type: 'init',
          document: doc,
          catalogSummary: this.catalog.getSummaries(doc.connectionId),
          theme:
            vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? 'light' : 'dark',
        });
        break;
      }
      case 'updateDocument': {
        await this.writeDocument(document, msg.document);
        break;
      }
      case 'requestHydrate': {
        const doc = parseDocument(document.getText());
        const table = this.catalog.getTable(doc.connectionId, msg.tableId);
        if (table) {
          post({
            type: 'hydrateColumns',
            tableId: table.id,
            columns: table.columns ?? [],
            indexes: table.indexes ?? [],
            foreignKeys: table.foreignKeys ?? [],
          });
        }
        break;
      }
      case 'requestAutoLayout': {
        const doc = parseDocument(document.getText());
        const cap = vscode.workspace
          .getConfiguration('erdWorkbench')
          .get<number>('autoLayoutNodeCap', 300);
        const selected = new Set(msg.tableIds);
        let nodes = doc.nodes.filter((n) => selected.has(n.tableId));
        if (nodes.length > cap) {
          throw new Error(`Auto-layout capped at ${cap} nodes (selected ${nodes.length})`);
        }
        if (!nodes.length) {
          nodes = doc.nodes.filter((n) => !n.pinned).slice(0, cap);
        }
        const idSet = new Set(nodes.map((n) => n.tableId));
        const edges = doc.edges.filter(
          (e) => idSet.has(e.sourceTableId) && idSet.has(e.targetTableId) && !e.hidden
        );
        const laidOut = await layoutSubgraph(nodes, edges);
        const map = new Map(laidOut.map((n) => [n.tableId, n]));
        const nextNodes = doc.nodes.map((n) => map.get(n.tableId) ?? n);
        const next = { ...doc, nodes: nextNodes, updatedAt: new Date().toISOString() };
        await this.writeDocument(document, next);
        post({ type: 'layoutResult', nodes: laidOut });
        break;
      }
      case 'createRelationship': {
        const doc = parseDocument(document.getText());
        if (msg.mode === 'visual') {
          const edge = {
            ...msg.edge,
            id: `visual:${Date.now().toString(36)}`,
            relationshipKind: 'visual' as const,
          };
          const next = {
            ...doc,
            edges: [...doc.edges, edge],
            updatedAt: new Date().toISOString(),
          };
          await this.writeDocument(document, next);
          break;
        }
        // Physical — never automatic; MutationPipeline preview + confirm
        const [srcSchema, srcTable] = msg.edge.sourceTableId.split('.');
        const [refSchema, refTable] = msg.edge.targetTableId.split('.');
        if (msg.edge.cardinality === 'N:M') {
          const sql = this.mutations.buildNmJunctionSql({
            schema: srcSchema,
            leftTable: srcTable,
            rightTable: refTable,
            leftCols: msg.edge.sourceColumns.map((c) => c.replace(/_id$/, '') + '_id'),
            rightCols: msg.edge.targetColumns.map((c) => c.replace(/_id$/, '') + '_id'),
            leftRefCols: msg.edge.sourceColumns,
            rightRefCols: msg.edge.targetColumns,
          });
          await this.mutations.proposePreviewConfirmExecute({
            connectionId: doc.connectionId,
            title: 'Create N:M junction table',
            intent: 'physical-nm',
            sql,
          });
        } else {
          const sql = this.mutations.buildPhysicalFkSql({
            schema: srcSchema,
            table: srcTable,
            constraintName: `fk_${srcTable}_${refTable}_${Date.now().toString(36)}`,
            columns: msg.edge.sourceColumns,
            refSchema,
            refTable,
            refColumns: msg.edge.targetColumns,
          });
          await this.mutations.proposePreviewConfirmExecute({
            connectionId: doc.connectionId,
            title: 'Create foreign key',
            intent: 'physical-fk',
            sql,
          });
        }
        break;
      }
      case 'proposeInferredAction': {
        const doc = parseDocument(document.getText());
        const edge = doc.edges.find((e) => e.id === msg.edgeId);
        if (!edge || edge.relationshipKind !== 'inferred') {
          throw new Error('Not an inferred edge');
        }
        if (msg.action === 'reject') {
          const next = {
            ...doc,
            edges: doc.edges.map((e) => (e.id === msg.edgeId ? { ...e, hidden: true } : e)),
            updatedAt: new Date().toISOString(),
          };
          await this.writeDocument(document, next);
        } else if (msg.action === 'accept-visual') {
          const next = {
            ...doc,
            edges: doc.edges.map((e) =>
              e.id === msg.edgeId ? { ...e, relationshipKind: 'visual' as const } : e
            ),
            updatedAt: new Date().toISOString(),
          };
          await this.writeDocument(document, next);
        } else if (msg.action === 'promote-physical') {
          const [srcSchema, srcTable] = edge.sourceTableId.split('.');
          const [refSchema, refTable] = edge.targetTableId.split('.');
          const sql = this.mutations.buildPhysicalFkSql({
            schema: srcSchema,
            table: srcTable,
            constraintName: `fk_${srcTable}_${refTable}_inferred`,
            columns: edge.sourceColumns,
            refSchema,
            refTable,
            refColumns: edge.targetColumns,
          });
          await this.mutations.proposePreviewConfirmExecute({
            connectionId: doc.connectionId,
            title: 'Promote inferred relationship to FK',
            intent: 'promote-inferred',
            sql,
          });
        }
        break;
      }
      case 'editTable':
      case 'exportRequest':
        // Handled via commands for now
        break;
      default:
        break;
    }
  }

  /**
   * Apply diagram update as a TextDocument edit so dirty state + undo/redo work.
   */
  private async writeDocument(document: vscode.TextDocument, doc: ErdDocument): Promise<void> {
    if (doc.erdFormatVersion !== ERD_FORMAT_VERSION) {
      throw new Error(`Unsupported erdFormatVersion: ${doc.erdFormatVersion}`);
    }
    const text = JSON.stringify(doc, null, 2);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
      text
    );
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error('Failed to apply diagram document edit');
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'erdEditor.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'erdEditor.css')
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
  <title>ERD Workbench</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function parseDocument(text: string): ErdDocument {
  if (!text.trim()) {
    return createEmptyDiagram('', []);
  }
  const doc = JSON.parse(text) as ErdDocument;
  if (doc.erdFormatVersion !== ERD_FORMAT_VERSION) {
    throw new Error(`Unsupported erdFormatVersion: ${String(doc.erdFormatVersion)}`);
  }
  return doc;
}

export async function openDiagramDocument(doc: ErdDocument, folder?: vscode.Uri): Promise<void> {
  const workspace =
    folder ?? vscode.workspace.workspaceFolders?.[0]?.uri ?? undefined;
  const name = `${doc.name.replace(/[^\w.-]+/g, '_')}.erd.json`;
  const uri = workspace
    ? vscode.Uri.joinPath(workspace, name)
    : vscode.Uri.parse(`untitled:${name}`);
  const content = JSON.stringify(doc, null, 2);
  if (workspace) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', uri, ErdTextEditorProvider.viewType);
  } else {
    const docText = await vscode.workspace.openTextDocument({
      language: 'json',
      content,
    });
    await vscode.window.showTextDocument(docText);
  }
}
