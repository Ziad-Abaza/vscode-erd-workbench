import * as vscode from 'vscode';
import { ConnectionManager } from './connection/ConnectionManager';
import { SchemaCatalogService } from './schema/SchemaCatalogService';
import { SchemaDiffService } from './schema/SchemaDiffService';
import { SchemaSyncService } from './schema/SchemaSyncService';
import { SqlParserService } from './sql/parser/SqlParserService';
import { SqlPolicyGate } from './sql/policy/SqlPolicyGate';
import { SqlExecutionService } from './sql/execution/SqlExecutionService';
import { ApprovalStore } from './mutation/ApprovalStore';
import { MutationPipeline } from './mutation/MutationPipeline';
import { ReverseEngineerService } from './engineering/ReverseEngineerService';
import { exportDbml, exportJsonPackage, exportSqlDdl } from './engineering/ImportExport';
import { SchemaExplorerProvider, type ExplorerNode } from './explorer/SchemaExplorerProvider';
import { ErdTextEditorProvider, openDiagramDocument, parseDocument } from './editor/ErdTextEditorProvider';
import { McpToolHost } from './mcp/McpToolHost';
import { DiagramRealtimeService } from './diagram/DiagramRealtimeService';
import { DiagramStorageService } from './diagram/DiagramStorageService';
import { AgentBridgeServer } from './agent/AgentBridgeServer';
import { createEmptyDiagram } from '../shared/types';

let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  const connections = new ConnectionManager(context);
  const catalog = new SchemaCatalogService(connections);
  const diff = new SchemaDiffService();
  const sync = new SchemaSyncService(catalog, diff);
  const parser = new SqlParserService();
  const gate = new SqlPolicyGate(parser);
  const sql = new SqlExecutionService(connections, gate);
  const approvals = new ApprovalStore();
  const mutations = new MutationPipeline(sql, parser, catalog, diff, approvals);
  const reverse = new ReverseEngineerService(catalog);
  const diagramStorage = new DiagramStorageService(context);
  const diagrams = new DiagramRealtimeService(diagramStorage);
  const mcp = new McpToolHost(connections, catalog, diff, mutations, approvals, diagrams);
  const explorer = new SchemaExplorerProvider(connections, catalog, diagramStorage);
  const bridge = new AgentBridgeServer(mcp);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'erdWorkbench.addConnection';
  updateStatusBar(connections);
  statusBar.show();
  connections.onDidChange(() => updateStatusBar(connections));

  const enableBridge = vscode.workspace
    .getConfiguration('erdWorkbench')
    .get<boolean>('enableAgentBridge', true);
  if (enableBridge) {
    void bridge.start().then((port) => {
      statusBar.tooltip = `ERD Workbench · Agent bridge :${port}`;
    }).catch((err) => {
      void vscode.window.showWarningMessage(
        `ERD Agent Bridge failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  context.subscriptions.push(
    statusBar,
    connections,
    { dispose: () => bridge.dispose() },
    vscode.window.registerTreeDataProvider('erdWorkbench.explorer', explorer),
    vscode.window.registerCustomEditorProvider(
      ErdTextEditorProvider.viewType,
      new ErdTextEditorProvider(context, catalog, mutations),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    )
  );

  const register = (command: string, fn: (...args: any[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, fn));
  };

  register('erdWorkbench.addConnection', async () => {
    const profile = await connections.promptNewProfile();
    if (profile) {
      explorer.refresh();
      const connect = await vscode.window.showInformationMessage(
        `Saved ${profile.name}. Connect now?`,
        'Connect'
      );
      if (connect === 'Connect') {
        await connections.connect(profile.id);
        explorer.refresh();
      }
    }
  });

  register('erdWorkbench.connect', async (node?: ExplorerNode) => {
    const id = node?.connectionId ?? (await pickConnection(connections));
    if (!id) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Connecting…' },
      async () => connections.connect(id)
    );
    await catalog.refresh(id, { full: false });
    explorer.refresh();
    vscode.window.showInformationMessage('Connected');
  });

  register('erdWorkbench.disconnect', async (node?: ExplorerNode) => {
    const id = node?.connectionId ?? (await pickConnection(connections));
    if (!id) {
      return;
    }
    await connections.disconnect(id);
    explorer.refresh();
  });

  register('erdWorkbench.reconnect', async () => {
    const id = await pickConnection(connections);
    if (!id) {
      return;
    }
    await connections.connect(id);
    explorer.refresh();
  });

  register('erdWorkbench.deleteConnection', async (node?: ExplorerNode) => {
    const id = node?.connectionId ?? (await pickConnection(connections));
    if (!id) {
      return;
    }
    const profile = connections.getProfile(id);
    const ok = await vscode.window.showWarningMessage(
      `Delete connection ${profile?.name ?? id}?`,
      { modal: true },
      'Delete'
    );
    if (ok === 'Delete') {
      await connections.deleteProfile(id);
      explorer.refresh();
    }
  });

  register('erdWorkbench.editConnection', async () => {
    vscode.window.showInformationMessage('Delete and re-add the connection to change settings in this MVP build.');
  });

  register('erdWorkbench.refreshCatalog', async (node?: ExplorerNode) => {
    const id = node?.connectionId ?? (await pickConnected(connections));
    if (!id) {
      return;
    }
    await catalog.refresh(id, { full: false });
    explorer.refresh();
  });

  register('erdWorkbench.fullRefreshCatalog', async () => {
    const id = await pickConnected(connections);
    if (!id) {
      return;
    }
    await catalog.refresh(id, { full: true });
    explorer.refresh();
    vscode.window.showInformationMessage('Full catalog refresh complete');
  });

  register('erdWorkbench.reverseEngineer', async (node?: ExplorerNode) => {
    const id = node?.connectionId ?? (await pickConnected(connections));
    if (!id) {
      return;
    }
    let schemas = node?.schemaName ? [node.schemaName] : catalog.getCatalog(id)?.schemas;
    if (!schemas?.length) {
      schemas = await catalog.listSchemas(id);
    }
    if (!node?.schemaName && schemas.length > 1) {
      const picked = await vscode.window.showQuickPick(schemas, {
        canPickMany: true,
        title: 'Select schemas to reverse engineer',
      });
      if (!picked?.length) {
        return;
      }
      schemas = picked;
    }
    const doc = await reverse.reverseEngineer(id, schemas);
    await openDiagramDocument(doc, (d) => diagramStorage.save(d));
    explorer.refresh();
  });

  register('erdWorkbench.newDiagram', async () => {
    const id = await pickConnected(connections);
    if (!id) {
      return;
    }
    const schemas = catalog.getCatalog(id)?.schemas ?? (await catalog.listSchemas(id));
    const doc = createEmptyDiagram(id, schemas, 'New Diagram');
    await openDiagramDocument(doc, (d) => diagramStorage.save(d));
    explorer.refresh();
  });

  register('erdWorkbench.openStoredDiagram', async (uri?: vscode.Uri) => {
    const target =
      uri ??
      (await (async () => {
        const list = await diagramStorage.list();
        if (!list.length) {
          vscode.window.showInformationMessage('No saved diagrams in private extension storage.');
          return undefined;
        }
        const picked = await vscode.window.showQuickPick(
          list.map((d) => ({ label: d.name, description: d.updatedAt, uri: d.uri })),
          { title: 'Open saved diagram' }
        );
        return picked?.uri;
      })());
    if (!target) {
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', target, ErdTextEditorProvider.viewType);
  });

  register('erdWorkbench.deleteStoredDiagram', async (node?: ExplorerNode) => {
    const ref = node?.meta as { uri?: vscode.Uri; name?: string } | undefined;
    const uri = ref?.uri;
    if (!uri) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete saved diagram "${ref?.name ?? uri.fsPath}" from private storage?`,
      { modal: true },
      'Delete'
    );
    if (ok !== 'Delete') {
      return;
    }
    await diagramStorage.delete(uri);
    explorer.refresh();
  });

  register('erdWorkbench.exportDiagramToWorkspace', async () => {
    const open = vscode.workspace.textDocuments.find((d) => d.fileName.endsWith('.erd.json'));
    if (!open) {
      vscode.window.showErrorMessage('Open a diagram first.');
      return;
    }
    const erd = parseDocument(open.getText());
    const target = await diagramStorage.exportToWorkspace(erd);
    if (target) {
      vscode.window.showInformationMessage(`Exported to ${target.fsPath}`);
    }
  });

  register('erdWorkbench.executeSql', async () => {
    await executeActiveSql(connections, sql, false);
  });

  register('erdWorkbench.executeSqlSelection', async () => {
    await executeActiveSql(connections, sql, true);
  });

  register('erdWorkbench.schemaDiff', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.erd.json')) {
      // Diff live catalog against itself after refresh probe messaging
      const id = await pickConnected(connections);
      if (!id) {
        return;
      }
      const before = catalog.getCatalog(id)?.tables ?? [];
      await catalog.refresh(id, { full: true });
      const after = catalog.getCatalog(id)?.tables ?? [];
      const result = diff.diffCatalogs(id, before, after);
      const content = JSON.stringify(result, null, 2);
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content });
      await vscode.window.showTextDocument(doc);
      return;
    }
    const erd = parseDocument(editor.document.getText());
    const cat = catalog.getCatalog(erd.connectionId);
    if (!cat) {
      vscode.window.showErrorMessage('Catalog not loaded for this diagram connection');
      return;
    }
    const result = diff.diffAgainstSnapshot(erd, cat);
    const doc = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(result, null, 2),
    });
    await vscode.window.showTextDocument(doc);
  });

  register('erdWorkbench.exportSchema', async () => {
    const id = await pickConnected(connections);
    if (!id) {
      return;
    }
    const format = await vscode.window.showQuickPick(['json', 'sql', 'dbml'] as const, {
      title: 'Export format',
    });
    if (!format) {
      return;
    }
    const cat = catalog.getCatalog(id);
    if (!cat) {
      vscode.window.showErrorMessage('Refresh catalog first');
      return;
    }
    let content = '';
    if (format === 'json') {
      content = exportJsonPackage(cat);
    } else if (format === 'sql') {
      content = exportSqlDdl(cat.tables);
    } else {
      content = exportDbml(cat.tables);
    }
    const doc = await vscode.workspace.openTextDocument({
      language: format === 'sql' ? 'sql' : format === 'dbml' ? 'plaintext' : 'json',
      content,
    });
    await vscode.window.showTextDocument(doc);
  });

  register('erdWorkbench.importSchema', async () => {
    vscode.window.showInformationMessage(
      'Import: open a SQL/DBML/JSON file and use Reverse Engineer or Mutation proposals to apply. Auto-apply is disabled by design.'
    );
  });

  register('erdWorkbench.autoLayoutSelection', async () => {
    vscode.window.showInformationMessage('Use the Auto-layout selection button inside the ERD editor.');
  });

  register('erdWorkbench.focusNeighborhood', async () => {
    vscode.window.showInformationMessage('Use search/filter and selection inside the ERD editor to focus neighborhoods.');
  });

  register('erdWorkbench.mcp.listTools', async () => mcp.showToolsQuickPick());

  // Programmatic MCP invoke for agents / tests
  register('erdWorkbench.mcp.invoke', async (name: string, args: Record<string, unknown>) => {
    return mcp.invoke(name, args ?? {});
  });

  register('erdWorkbench.diagram.setPage', async () => {
    const pageIndex = Number(
      await vscode.window.showInputBox({ prompt: 'Page index (0-based)', value: '0' })
    );
    const pageSize = Number(
      await vscode.window.showInputBox({ prompt: 'Page size', value: '50' })
    );
    if (Number.isNaN(pageIndex) || Number.isNaN(pageSize)) {
      return;
    }
    const result = await diagrams.setPage(pageIndex, pageSize);
    vscode.window.showInformationMessage(
      `Page ${result.page.pageIndex + 1}/${result.page.pageCount} · ${result.page.visibleTableIds.length} tables`
    );
  });

  register('erdWorkbench.agentBridge.status', async () => {
    const port = vscode.workspace.getConfiguration('erdWorkbench').get<number>('agentBridgePort', 3847);
    vscode.window.showInformationMessage(
      enableBridge
        ? `Agent bridge listening on http://127.0.0.1:${port} — CLI: node dist/cli.js tools`
        : 'Agent bridge disabled (erdWorkbench.enableAgentBridge)'
    );
  });

  // Sync active diagram with catalog (layout-preserving)
  register('erdWorkbench.syncActiveDiagram', async () => {
    const editor = vscode.window.activeTextEditor;
    // Custom text editor may not expose as activeTextEditor the same way — also try visible
    const doc =
      editor?.document.fileName.endsWith('.erd.json')
        ? editor.document
        : vscode.workspace.textDocuments.find((d) => d.fileName.endsWith('.erd.json'));
    if (!doc) {
      vscode.window.showErrorMessage('Open an .erd.json diagram first');
      return;
    }
    const erd = parseDocument(doc.getText());
    const full = await vscode.window.showQuickPick(
      [
        { label: 'Incremental sync', full: false },
        { label: 'Full refresh + merge', full: true },
      ],
      { title: 'Schema sync' }
    );
    if (!full) {
      return;
    }
    const { document: next, message } = await sync.syncDiagram(erd, { full: full.full });
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(next, null, 2));
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(message);
  });
}

export function deactivate(): void {
  // disposed via subscriptions
}

function updateStatusBar(connections: ConnectionManager): void {
  const active = connections.listProfiles().filter((p) => connections.isConnected(p.id));
  statusBar.text =
    active.length === 0
      ? '$(database) ERD Workbench'
      : `$(plug) ERD: ${active.map((a) => a.name).join(', ')}`;
}

async function pickConnection(connections: ConnectionManager): Promise<string | undefined> {
  const items = connections.listProfiles().map((p) => ({
    label: p.name,
    description: `${p.host}:${p.port}`,
    id: p.id,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'Select connection' });
  return picked?.id;
}

async function pickConnected(connections: ConnectionManager): Promise<string | undefined> {
  const items = connections
    .listProfiles()
    .filter((p) => connections.isConnected(p.id))
    .map((p) => ({ label: p.name, id: p.id }));
  if (!items.length) {
    vscode.window.showErrorMessage('No active connection. Connect first.');
    return undefined;
  }
  if (items.length === 1) {
    return items[0].id;
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Select connection' });
  return picked?.id;
}

async function executeActiveSql(
  connections: ConnectionManager,
  sql: SqlExecutionService,
  selectionOnly: boolean
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const text = selectionOnly
    ? editor.document.getText(editor.selection)
    : editor.document.getText();
  if (!text.trim()) {
    return;
  }
  const id = await pickConnected(connections);
  if (!id) {
    return;
  }
  try {
    const result = await sql.execute(id, text, 'sql-runner');
    const lines = [
      `Risk: ${result.risk}`,
      result.affectedRows !== undefined ? `Affected rows: ${result.affectedRows}` : undefined,
      result.truncated ? `Truncated to ${result.rows.length} rows` : undefined,
      result.columns.length ? result.columns.join('\t') : undefined,
      ...result.rows.map((r) => result.columns.map((c) => String(r[c] ?? '')).join('\t')),
    ].filter(Boolean);
    const out = vscode.window.createOutputChannel('ERD Workbench SQL');
    out.clear();
    out.appendLine(lines.join('\n'));
    out.show(true);
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
  }
}
