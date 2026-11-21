import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { DiagramStorageService } from '../diagram/DiagramStorageService';

export type ExplorerNodeKind =
  | 'diagramsRoot'
  | 'diagram'
  | 'connectionsRoot'
  | 'connection'
  | 'connectionActive'
  | 'schema'
  | 'table'
  | 'view'
  | 'columns'
  | 'column'
  | 'indexes'
  | 'index'
  | 'fks'
  | 'fk';

export class ExplorerNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly kind: ExplorerNodeKind,
    public readonly connectionId?: string,
    public readonly schemaName?: string,
    public readonly tableId?: string,
    public readonly meta?: unknown
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

export class SchemaExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly emitter = new vscode.EventEmitter<ExplorerNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly catalog: SchemaCatalogService,
    private readonly diagrams: DiagramStorageService
  ) {
    connections.onDidChange(() => this.refresh());
    catalog.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return [
        new ExplorerNode('Saved Diagrams', vscode.TreeItemCollapsibleState.Expanded, 'diagramsRoot'),
        new ExplorerNode('Connections', vscode.TreeItemCollapsibleState.Expanded, 'connectionsRoot'),
      ];
    }

    if (element.kind === 'diagramsRoot') {
      const list = await this.diagrams.list();
      if (!list.length) {
        const empty = new ExplorerNode(
          'No diagrams yet — Reverse Engineer a schema',
          vscode.TreeItemCollapsibleState.None,
          'diagram'
        );
        empty.description = 'private storage';
        return [empty];
      }
      return list.map((d) => {
        const n = new ExplorerNode(d.name, vscode.TreeItemCollapsibleState.None, 'diagram', d.connectionId, undefined, undefined, d);
        n.description = d.updatedAt ? d.updatedAt.slice(0, 10) : undefined;
        n.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
        n.command = {
          command: 'erdWorkbench.openStoredDiagram',
          title: 'Open Diagram',
          arguments: [d.uri],
        };
        n.tooltip = `Stored privately in extension storage\n${d.uri.fsPath}`;
        return n;
      });
    }

    if (element.kind === 'connectionsRoot') {
      return this.connections.listProfiles().map((p) => {
        const active = this.connections.isConnected(p.id);
        const node = new ExplorerNode(
          p.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          active ? 'connectionActive' : 'connection',
          p.id
        );
        node.description = `${p.user}@${p.host}:${p.port}`;
        node.iconPath = new vscode.ThemeIcon(active ? 'plug' : 'database');
        return node;
      });
    }

    if (element.kind === 'connection' || element.kind === 'connectionActive') {
      if (!element.connectionId || !this.connections.isConnected(element.connectionId)) {
        return [];
      }
      let cat = this.catalog.getCatalog(element.connectionId);
      if (!cat) {
        cat = await this.catalog.refresh(element.connectionId, { full: false });
      }
      return cat.schemas.map((s) => {
        const n = new ExplorerNode(
          s,
          vscode.TreeItemCollapsibleState.Collapsed,
          'schema',
          element.connectionId,
          s
        );
        n.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return n;
      });
    }

    if (element.kind === 'schema' && element.connectionId && element.schemaName) {
      const tables =
        this.catalog.getCatalog(element.connectionId)?.tables.filter((t) => t.schema === element.schemaName) ??
        [];
      return tables.map((t) => {
        const n = new ExplorerNode(
          t.name,
          vscode.TreeItemCollapsibleState.Collapsed,
          t.kind === 'view' ? 'view' : 'table',
          element.connectionId,
          element.schemaName,
          t.id,
          t
        );
        n.iconPath = new vscode.ThemeIcon(t.kind === 'view' ? 'symbol-interface' : 'table');
        n.description = t.kind;
        return n;
      });
    }

    if ((element.kind === 'table' || element.kind === 'view') && element.connectionId && element.tableId) {
      const table = this.catalog.getTable(element.connectionId, element.tableId);
      if (!table) {
        return [];
      }
      return [
        new ExplorerNode('Columns', vscode.TreeItemCollapsibleState.Collapsed, 'columns', element.connectionId, element.schemaName, element.tableId, table.columns),
        new ExplorerNode('Indexes', vscode.TreeItemCollapsibleState.Collapsed, 'indexes', element.connectionId, element.schemaName, element.tableId, table.indexes),
        new ExplorerNode('Foreign Keys', vscode.TreeItemCollapsibleState.Collapsed, 'fks', element.connectionId, element.schemaName, element.tableId, table.foreignKeys),
      ];
    }

    if (element.kind === 'columns' && Array.isArray(element.meta)) {
      return (element.meta as { name: string; columnType: string; columnKey: string }[]).map((c) => {
        const n = new ExplorerNode(c.name, vscode.TreeItemCollapsibleState.None, 'column');
        n.description = `${c.columnType}${c.columnKey ? ` (${c.columnKey})` : ''}`;
        return n;
      });
    }
    if (element.kind === 'indexes' && Array.isArray(element.meta)) {
      return (element.meta as { name: string; columns: string[]; primary: boolean }[]).map((i) => {
        const n = new ExplorerNode(i.name, vscode.TreeItemCollapsibleState.None, 'index');
        n.description = `${i.primary ? 'PK ' : ''}${i.columns.join(',')}`;
        return n;
      });
    }
    if (element.kind === 'fks' && Array.isArray(element.meta)) {
      return (element.meta as { name: string; columns: string[]; referencedTable: string; referencedColumns: string[] }[]).map((f) => {
        const n = new ExplorerNode(f.name, vscode.TreeItemCollapsibleState.None, 'fk');
        n.description = `(${f.columns.join(',')}) → ${f.referencedTable}(${f.referencedColumns.join(',')})`;
        return n;
      });
    }
    return [];
  }
}
