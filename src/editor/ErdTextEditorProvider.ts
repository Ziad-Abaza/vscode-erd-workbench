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
import { runTableEditWizard } from '../mutation/TableEditWizard';
import { runPromoteInferredWizard, runRelationshipWizard } from '../mutation/RelationshipWizard';
import {
  applyInferredAcceptVisual,
  applyInferredReject,
  findInferredEdge,
  formatInferredMapping,
} from '../../shared/inferredActions';
import { layoutSubgraph } from '../diagram/layout';
import { pageNodes as currentPageNodes } from '../diagram/paging';

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
        // Prefer current page when page mode is on and nothing selected
        if (!nodes.length && doc.filters.pageMode) {
          nodes = currentPageNodes(doc);
        }
        if (!nodes.length) {
          // Never lay out hundreds at once — keep viewport usable
          nodes = doc.nodes.filter((n) => !n.pinned).slice(0, Math.min(cap, 48));
        }
        if (nodes.length > cap) {
          nodes = nodes.slice(0, cap);
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
        if (!doc.connectionId) {
          throw new Error('Diagram has no connectionId — reconnect / reverse-engineer first');
        }
        await this.ensureTablesHydrated(doc.connectionId, [
          msg.sourceTableId,
          msg.targetTableId,
        ]);
        const sourceTable = this.catalog.getTable(doc.connectionId, msg.sourceTableId);
        const targetTable = this.catalog.getTable(doc.connectionId, msg.targetTableId);
        if (!sourceTable || !targetTable) {
          throw new Error(
            `Tables not in catalog: ${[!sourceTable && msg.sourceTableId, !targetTable && msg.targetTableId]
              .filter(Boolean)
              .join(', ')}`
          );
        }

        const result = await runRelationshipWizard({
          connectionId: doc.connectionId,
          sourceTable,
          targetTable,
          mutations: this.mutations,
        });

        if (!result.applied || !result.edge) {
          break;
        }

        let next = parseDocument(document.getText());
        const edgeId =
          result.mode === 'physical' && result.edge.constraintName
            ? `fk:${result.edge.sourceTableId}:${result.edge.constraintName}`
            : result.edge.cardinality === 'N:M' && result.junctionTableId
              ? `nm:${result.junctionTableId}`
              : `visual:${Date.now().toString(36)}`;

        const edge = {
          ...result.edge,
          id: edgeId,
        };

        // For N:M physical: place junction table node if catalog has it
        let nodes = next.nodes;
        if (result.junctionTableId) {
          const junction = this.catalog.getTable(doc.connectionId, result.junctionTableId);
          if (junction && !nodes.some((n) => n.tableId === junction.id)) {
            const srcNode = nodes.find((n) => n.tableId === msg.sourceTableId);
            const tgtNode = nodes.find((n) => n.tableId === msg.targetTableId);
            const x =
              srcNode && tgtNode
                ? (srcNode.x + tgtNode.x) / 2
                : (srcNode?.x ?? 0) + 240;
            const y =
              srcNode && tgtNode
                ? (srcNode.y + tgtNode.y) / 2 + 40
                : (srcNode?.y ?? 0) + 80;
            nodes = [
              ...nodes,
              {
                tableId: junction.id,
                x,
                y,
                width: 200,
                height: 120,
              },
            ];
          }
        }

        const edges = next.edges.some((e) => e.id === edge.id)
          ? next.edges.map((e) => (e.id === edge.id ? edge : e))
          : [...next.edges, edge];

        next = {
          ...next,
          nodes,
          edges,
          updatedAt: new Date().toISOString(),
        };
        await this.writeDocument(document, next);

        // Push fresh column hydrate for child / junction after physical DDL
        if (result.mode === 'physical') {
          for (const id of [msg.sourceTableId, result.junctionTableId].filter(Boolean) as string[]) {
            const t = this.catalog.getTable(doc.connectionId, id);
            if (t) {
              post({
                type: 'hydrateColumns',
                tableId: t.id,
                columns: t.columns ?? [],
                indexes: t.indexes ?? [],
                foreignKeys: t.foreignKeys ?? [],
              });
            }
          }
          const summaries = this.catalog.getSummaries(doc.connectionId);
          const changed = summaries.filter(
            (s) =>
              s.id === msg.sourceTableId ||
              s.id === msg.targetTableId ||
              s.id === result.junctionTableId
          );
          if (changed.length) {
            post({
              type: 'catalogPatch',
              patch: {
                tablesAdded: result.junctionTableId
                  ? changed.filter((s) => s.id === result.junctionTableId)
                  : [],
                tablesRemoved: [],
                tablesChanged: changed.filter((s) => s.id !== result.junctionTableId),
                edgesAdded: [edge],
                edgesRemoved: [],
                edgesChanged: [],
              },
            });
          }
        }
        break;
      }
      case 'proposeInferredAction': {
        const doc = parseDocument(document.getText());
        const edge = findInferredEdge(doc, msg.edgeId);
        if (!edge) {
          throw new Error('Not an inferred edge');
        }
        if (msg.action === 'reject') {
          await this.writeDocument(document, applyInferredReject(doc, msg.edgeId));
        } else if (msg.action === 'accept-visual') {
          await this.writeDocument(document, applyInferredAcceptVisual(doc, msg.edgeId));
        } else if (msg.action === 'promote-physical') {
          if (!doc.connectionId) {
            throw new Error('Diagram has no connectionId — reconnect / reverse-engineer first');
          }
          await this.ensureTablesHydrated(doc.connectionId, [
            edge.sourceTableId,
            edge.targetTableId,
          ]);
          const sourceTable = this.catalog.getTable(doc.connectionId, edge.sourceTableId);
          const targetTable = this.catalog.getTable(doc.connectionId, edge.targetTableId);
          if (!sourceTable || !targetTable) {
            throw new Error('Source/target tables not in catalog');
          }
          // Tight promote path: prefill columns from the inferred edge
          const result = await runPromoteInferredWizard({
            connectionId: doc.connectionId,
            sourceTable,
            targetTable,
            mutations: this.mutations,
            prefill: {
              sourceColumns: edge.sourceColumns,
              targetColumns: edge.targetColumns,
              cardinality: edge.cardinality,
              mappingLabel: formatInferredMapping(edge),
            },
          });
          if (result.applied && result.mode === 'physical' && result.edge) {
            const next = {
              ...doc,
              edges: doc.edges.map((e) =>
                e.id === msg.edgeId
                  ? {
                      ...result.edge!,
                      id: result.edge!.constraintName
                        ? `fk:${result.edge!.sourceTableId}:${result.edge!.constraintName}`
                        : e.id,
                    }
                  : e
              ),
              updatedAt: new Date().toISOString(),
            };
            await this.writeDocument(document, next);
          }
        }
        break;
      }
      case 'editTable': {
        const doc = parseDocument(document.getText());
        if (!doc.connectionId) {
          throw new Error('Diagram has no connectionId — reconnect / reverse-engineer first');
        }
        let table = this.catalog.getTable(doc.connectionId, msg.tableId);
        if (!table?.columnsHydrated || !table.columns?.length) {
          // Ensure columns are available for alter/drop pickers
          await this.catalog.refresh(doc.connectionId, {
            full: false,
            schemas: table ? [table.schema] : msg.tableId.includes('.')
              ? [msg.tableId.split('.')[0]]
              : undefined,
          });
          table = this.catalog.getTable(doc.connectionId, msg.tableId);
        }
        if (!table) {
          throw new Error(`Table not in catalog: ${msg.tableId}`);
        }

        const result = await runTableEditWizard({
          connectionId: doc.connectionId,
          table,
          mutations: this.mutations,
          action: msg.action,
          columnName: msg.payload?.columnName,
        });

        if (result.applied) {
          const refreshed = this.catalog.getTable(doc.connectionId, msg.tableId);
          if (refreshed) {
            post({
              type: 'hydrateColumns',
              tableId: refreshed.id,
              columns: refreshed.columns ?? [],
              indexes: refreshed.indexes ?? [],
              foreignKeys: refreshed.foreignKeys ?? [],
            });
            const summary = this.catalog.toSummary(refreshed);
            post({
              type: 'catalogPatch',
              patch: {
                tablesAdded: [],
                tablesRemoved: [],
                tablesChanged: [summary],
                edgesAdded: [],
                edgesRemoved: [],
                edgesChanged: [],
              },
            });
          }
          void vscode.window.showInformationMessage(
            result.action === 'dropColumn'
              ? `Dropped column on ${msg.tableId}`
              : result.action === 'addColumn'
                ? `Added column on ${msg.tableId}`
                : `Altered column on ${msg.tableId}`
          );
        }
        break;
      }
      case 'exportRequest':
        // Handled via commands for now
        break;
      default:
        break;
    }
  }

  private async ensureTablesHydrated(connectionId: string, tableIds: string[]): Promise<void> {
    const schemas = new Set<string>();
    let needsRefresh = false;
    for (const id of tableIds) {
      const t = this.catalog.getTable(connectionId, id);
      if (!t || !t.columnsHydrated || !t.columns?.length) {
        needsRefresh = true;
        const schema = t?.schema ?? id.split('.')[0];
        if (schema) {
          schemas.add(schema);
        }
      }
    }
    if (needsRefresh) {
      await this.catalog.refresh(connectionId, {
        full: false,
        schemas: schemas.size ? [...schemas] : undefined,
      });
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

/**
 * Opens a diagram from private extension storage (workspaceStorage/globalStorage).
 * Does NOT write into the user's project folder.
 */
export async function openDiagramDocument(
  doc: ErdDocument,
  storageSave: (doc: ErdDocument) => Promise<vscode.Uri>
): Promise<vscode.Uri> {
  const uri = await storageSave(doc);
  await vscode.commands.executeCommand('vscode.openWith', uri, ErdTextEditorProvider.viewType);
  return uri;
}
