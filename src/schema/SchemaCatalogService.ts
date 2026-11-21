import type { RowDataPacket } from 'mysql2';
import * as vscode from 'vscode';
import {
  tableId,
  type CatalogSnapshot,
  type CatalogTableSummary,
  type ColumnMeta,
  type ForeignKeyMeta,
  type IndexMeta,
  type TableMeta,
} from '../../shared/types';
import { ConnectionManager } from '../connection/ConnectionManager';
import { hashTableMeta } from './hash';

const SYSTEM_SCHEMAS = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

export class SchemaCatalogService {
  private readonly catalogs = new Map<string, CatalogSnapshot>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly connections: ConnectionManager) {}

  getCatalog(connectionId: string): CatalogSnapshot | undefined {
    return this.catalogs.get(connectionId);
  }

  getTable(connectionId: string, id: string): TableMeta | undefined {
    return this.catalogs.get(connectionId)?.tables.find((t) => t.id === id);
  }

  getSummaries(connectionId: string): CatalogTableSummary[] {
    const cat = this.catalogs.get(connectionId);
    if (!cat) {
      return [];
    }
    return cat.tables.map((t) => this.toSummary(t));
  }

  async listSchemas(connectionId: string): Promise<string[]> {
    const [rows] = await this.connections.query<RowDataPacket[]>(
      connectionId,
      `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`
    );
    return rows
      .map((r) => String(r.name))
      .filter((n) => !SYSTEM_SCHEMAS.has(n.toLowerCase()));
  }

  /**
   * Incremental or full refresh. Fingerprints are hints only —
   * Full Refresh always reloads. Incremental re-fetches listed schemas (or all).
   */
  async refresh(
    connectionId: string,
    options: { full: boolean; schemas?: string[] }
  ): Promise<CatalogSnapshot> {
    const pageSize = vscode.workspace
      .getConfiguration('erdWorkbench')
      .get<number>('catalogPageSize', 200);

    const schemas = options.schemas?.length
      ? options.schemas
      : await this.listSchemas(connectionId);

    const existing = this.catalogs.get(connectionId);
    const tables: TableMeta[] = options.full ? [] : [...(existing?.tables ?? [])].filter(
      (t) => !schemas.includes(t.schema)
    );

    const placeholders = schemas.map(() => '?').join(',');
    if (!schemas.length) {
      const empty: CatalogSnapshot = {
        connectionId,
        fetchedAt: new Date().toISOString(),
        schemas: [],
        tables: [],
        syncStatus: 'pristine',
        hashes: {},
      };
      this.catalogs.set(connectionId, empty);
      this.onDidChangeEmitter.fire(connectionId);
      return empty;
    }

    // Fetch table/view list in pages
    let offset = 0;
    const baseRows: RowDataPacket[] = [];
    for (;;) {
      const [page] = await this.connections.query<RowDataPacket[]>(
        connectionId,
        `SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, TABLE_TYPE AS tableType,
                ENGINE AS engine, TABLE_COMMENT AS tableComment
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA IN (${placeholders})
         ORDER BY TABLE_SCHEMA, TABLE_NAME
         LIMIT ? OFFSET ?`,
        [...schemas, pageSize, offset]
      );
      baseRows.push(...page);
      if (page.length < pageSize) {
        break;
      }
      offset += pageSize;
    }

    // Bulk columns for these schemas
    const [columnRows] = await this.connections.query<RowDataPacket[]>(
      connectionId,
      `SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
              ORDINAL_POSITION AS ordinalPosition, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey, EXTRA AS extra,
              COLUMN_DEFAULT AS columnDefault, COLUMN_COMMENT AS columnComment
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA IN (${placeholders})
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      schemas
    );

    const [indexRows] = await this.connections.query<RowDataPacket[]>(
      connectionId,
      `SELECT TABLE_SCHEMA AS tableSchema, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
              COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seq, NON_UNIQUE AS nonUnique, INDEX_TYPE AS indexType
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA IN (${placeholders})
       ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      schemas
    );

    const [fkRows] = await this.connections.query<RowDataPacket[]>(
      connectionId,
      `SELECT k.CONSTRAINT_SCHEMA AS constraintSchema, k.CONSTRAINT_NAME AS constraintName,
              k.TABLE_SCHEMA AS tableSchema, k.TABLE_NAME AS tableName, k.COLUMN_NAME AS columnName,
              k.REFERENCED_TABLE_SCHEMA AS referencedSchema, k.REFERENCED_TABLE_NAME AS referencedTable,
              k.REFERENCED_COLUMN_NAME AS referencedColumn, k.ORDINAL_POSITION AS ordinalPosition,
              r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
       WHERE k.TABLE_SCHEMA IN (${placeholders}) AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_SCHEMA, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      schemas
    );

    const columnsByTable = groupColumns(columnRows);
    const indexesByTable = groupIndexes(indexRows);
    const fksByTable = groupForeignKeys(fkRows);

    for (const row of baseRows) {
      const schema = String(row.tableSchema);
      const name = String(row.tableName);
      const id = tableId(schema, name);
      const kind = String(row.tableType).toUpperCase().includes('VIEW') ? 'view' : 'table';
      const meta: TableMeta = {
        id,
        schema,
        name,
        kind,
        engine: row.engine ? String(row.engine) : undefined,
        comment: row.tableComment ? String(row.tableComment) : undefined,
        columns: columnsByTable.get(id) ?? [],
        indexes: indexesByTable.get(id) ?? [],
        foreignKeys: fksByTable.get(id) ?? [],
        constraints: [],
        columnsHydrated: true,
      };
      meta.contentHash = hashTableMeta(meta);
      tables.push(meta);
    }

    const hashes: Record<string, string> = {};
    for (const t of tables) {
      if (t.contentHash) {
        hashes[t.id] = t.contentHash;
      }
    }

    const snapshot: CatalogSnapshot = {
      connectionId,
      fetchedAt: new Date().toISOString(),
      schemas,
      tables,
      syncStatus: 'pristine',
      hashes,
    };
    this.catalogs.set(connectionId, snapshot);
    this.onDidChangeEmitter.fire(connectionId);
    return snapshot;
  }

  /**
   * Cheap probe — hint only. Never treat match as proof of unchanged schema.
   */
  async probeDrift(connectionId: string): Promise<{ suspect: boolean; detail: string }> {
    const current = this.catalogs.get(connectionId);
    if (!current) {
      return { suspect: true, detail: 'No catalog loaded' };
    }
    try {
      const [rows] = await this.connections.query<RowDataPacket[]>(
        connectionId,
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLES
         WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')`
      );
      const cnt = Number(rows[0]?.cnt ?? 0);
      if (cnt !== current.tables.length) {
        return { suspect: true, detail: `Table count ${cnt} vs cached ${current.tables.length}` };
      }
      return { suspect: false, detail: 'Count matches (hint only — not proof of equality)' };
    } catch (err) {
      return {
        suspect: true,
        detail: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  toSummary(t: TableMeta): CatalogTableSummary {
    const pkCols =
      t.indexes?.find((i) => i.primary)?.columns ??
      t.columns?.filter((c) => c.columnKey === 'PRI').map((c) => c.name) ??
      [];
    return {
      id: t.id,
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      pkCols,
      fkCount: t.foreignKeys?.length ?? 0,
      columnCount: t.columns?.length ?? 0,
    };
  }

  search(connectionId: string, query: string, limit = 100): CatalogTableSummary[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      return this.getSummaries(connectionId).slice(0, limit);
    }
    return this.getSummaries(connectionId)
      .filter((t) => t.id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .slice(0, limit);
  }
}

function groupColumns(rows: RowDataPacket[]): Map<string, ColumnMeta[]> {
  const map = new Map<string, ColumnMeta[]>();
  for (const r of rows) {
    const id = tableId(String(r.tableSchema), String(r.tableName));
    const list = map.get(id) ?? [];
    list.push({
      name: String(r.columnName),
      ordinalPosition: Number(r.ordinalPosition),
      dataType: String(r.dataType),
      columnType: String(r.columnType),
      isNullable: String(r.isNullable).toUpperCase() === 'YES',
      columnKey: String(r.columnKey ?? ''),
      extra: String(r.extra ?? ''),
      columnDefault: r.columnDefault === null || r.columnDefault === undefined ? null : String(r.columnDefault),
      comment: r.columnComment ? String(r.columnComment) : undefined,
    });
    map.set(id, list);
  }
  return map;
}

function groupIndexes(rows: RowDataPacket[]): Map<string, IndexMeta[]> {
  const map = new Map<string, IndexMeta[]>();
  const builders = new Map<string, IndexMeta>();
  for (const r of rows) {
    const tid = tableId(String(r.tableSchema), String(r.tableName));
    const key = `${tid}::${r.indexName}`;
    let idx = builders.get(key);
    if (!idx) {
      idx = {
        name: String(r.indexName),
        tableId: tid,
        columns: [],
        unique: Number(r.nonUnique) === 0,
        primary: String(r.indexName).toUpperCase() === 'PRIMARY',
        type: r.indexType ? String(r.indexType) : undefined,
      };
      builders.set(key, idx);
      const list = map.get(tid) ?? [];
      list.push(idx);
      map.set(tid, list);
    }
    idx.columns.push(String(r.columnName));
  }
  return map;
}

/** Group composite FKs by constraint name. */
function groupForeignKeys(rows: RowDataPacket[]): Map<string, ForeignKeyMeta[]> {
  const map = new Map<string, ForeignKeyMeta[]>();
  const builders = new Map<string, ForeignKeyMeta>();
  for (const r of rows) {
    const tid = tableId(String(r.tableSchema), String(r.tableName));
    const key = `${tid}::${r.constraintName}`;
    let fk = builders.get(key);
    if (!fk) {
      fk = {
        name: String(r.constraintName),
        schema: String(r.tableSchema),
        table: String(r.tableName),
        columns: [],
        referencedSchema: String(r.referencedSchema),
        referencedTable: String(r.referencedTable),
        referencedColumns: [],
        onUpdate: r.onUpdate ? String(r.onUpdate) : undefined,
        onDelete: r.onDelete ? String(r.onDelete) : undefined,
      };
      builders.set(key, fk);
      const list = map.get(tid) ?? [];
      list.push(fk);
      map.set(tid, list);
    }
    fk.columns.push(String(r.columnName));
    fk.referencedColumns.push(String(r.referencedColumn));
  }
  return map;
}
