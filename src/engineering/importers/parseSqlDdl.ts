import { Parser } from 'node-sql-parser';
import {
  tableId,
  type ColumnMeta,
  type ForeignKeyMeta,
  type IndexMeta,
  type TableMeta,
} from '../../../shared/types';
import { buildPhysicalEdges } from '../../schema/SchemaSyncService';
import type { ImportOptions, SchemaImportResult } from './types';

/**
 * Import CREATE TABLE (+ inline constraints) and ALTER TABLE … ADD FOREIGN KEY.
 * Does not execute SQL — parse-only → TableMeta[] for a private diagram.
 */
export function parseSqlDdl(content: string, options: ImportOptions = {}): SchemaImportResult {
  const defaultSchema = options.defaultSchema?.trim() || 'default';
  const warnings: string[] = [];
  const parser = new Parser();
  const cleaned = stripSqlComments(content).trim();
  if (!cleaned) {
    throw new Error('Empty SQL');
  }

  const tables = new Map<string, TableMeta>();
  const nodes = parseAstNodes(parser, cleaned, warnings);

  for (const node of nodes) {
    const type = String((node as { type?: string }).type ?? '').toLowerCase();
    if (type === 'create' && String((node as { keyword?: string }).keyword ?? '').toLowerCase() === 'table') {
      const table = createTableFromAst(node as Record<string, unknown>, defaultSchema, warnings);
      if (table) {
        tables.set(table.id, table);
      }
      continue;
    }
    if (type === 'alter') {
      applyAlterFk(node as Record<string, unknown>, tables, defaultSchema, warnings);
      continue;
    }
    if (type === 'use') {
      // USE db — update default for subsequent unqualified names via warning only
      const db = extractUseDb(node as Record<string, unknown>);
      if (db) {
        warnings.push(`USE ${db} noted; unqualified tables still use defaultSchema="${defaultSchema}" unless qualified`);
      }
      continue;
    }
    // Ignore SELECT/INSERT etc. with a soft warning once
  }

  const ignored = nodes.filter((n) => {
    const t = String((n as { type?: string }).type ?? '').toLowerCase();
    const kw = String((n as { keyword?: string }).keyword ?? '').toLowerCase();
    return !(
      (t === 'create' && kw === 'table') ||
      t === 'alter' ||
      t === 'use'
    );
  });
  if (ignored.length) {
    warnings.push(`Ignored ${ignored.length} non-DDL statement(s) (import is schema-only)`);
  }

  const list = [...tables.values()];
  if (!list.length) {
    throw new Error('No CREATE TABLE statements found in SQL');
  }

  return {
    format: 'sql',
    tables: list,
    edges: buildPhysicalEdges(list),
    diagram: null,
    schemas: [...new Set(list.map((t) => t.schema))].sort(),
    warnings,
    nameHint: 'Imported SQL schema',
  };
}

function parseAstNodes(
  parser: Parser,
  sql: string,
  warnings: string[]
): unknown[] {
  try {
    const ast = parser.astify(sql, { database: 'MySQL' });
    return Array.isArray(ast) ? ast : [ast];
  } catch (err) {
    // Fallback: statement-by-statement for resilient partial import
    const parts = splitSqlStatements(sql);
    const nodes: unknown[] = [];
    for (const part of parts) {
      try {
        const ast = parser.astify(part, { database: 'MySQL' });
        nodes.push(...(Array.isArray(ast) ? ast : [ast]));
      } catch (inner) {
        warnings.push(
          `Skipped unparseable statement: ${inner instanceof Error ? inner.message : String(inner)}`
        );
      }
    }
    if (!nodes.length) {
      throw new Error(
        `SQL parse failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    warnings.push('Used statement-by-statement parse fallback');
    return nodes;
  }
}

function createTableFromAst(
  node: Record<string, unknown>,
  defaultSchema: string,
  warnings: string[]
): TableMeta | undefined {
  const tableRef = firstTableRef(node.table);
  if (!tableRef) {
    warnings.push('CREATE TABLE without table name — skipped');
    return undefined;
  }
  const schema = tableRef.db || defaultSchema;
  const name = tableRef.table;
  const id = tableId(schema, name);
  const defs = Array.isArray(node.create_definitions) ? node.create_definitions : [];

  const columns: ColumnMeta[] = [];
  const indexes: IndexMeta[] = [];
  const foreignKeys: ForeignKeyMeta[] = [];
  let ordinal = 0;

  for (const def of defs as Record<string, unknown>[]) {
    const resource = String(def.resource ?? '');
    if (resource === 'column') {
      ordinal += 1;
      const colName = columnName(def.column);
      if (!colName) {
        continue;
      }
      const columnType = formatDataType(def.definition as Record<string, unknown> | undefined);
      const isNullable = !isNotNull(def);
      const isPk = Boolean(def.primary);
      const isUnique = Boolean(def.unique);
      columns.push({
        name: colName,
        ordinalPosition: ordinal,
        dataType: String((def.definition as { dataType?: string } | undefined)?.dataType ?? columnType),
        columnType,
        isNullable,
        columnKey: isPk ? 'PRI' : isUnique ? 'UNI' : '',
        extra: def.auto_increment ? 'auto_increment' : '',
        columnDefault: extractDefault(def.default_val),
        comment: extractComment(def.comment),
      });
      if (isPk) {
        indexes.push({
          name: 'PRIMARY',
          tableId: id,
          columns: [colName],
          unique: true,
          primary: true,
        });
      } else if (isUnique) {
        indexes.push({
          name: `uniq_${colName}`,
          tableId: id,
          columns: [colName],
          unique: true,
          primary: false,
        });
      }
      continue;
    }

    if (resource === 'constraint' || def.constraint_type) {
      const ctype = String(def.constraint_type ?? '').toLowerCase();
      if (ctype === 'primary key') {
        const cols = columnList(def.definition);
        mergePrimary(indexes, id, cols);
        markPkColumns(columns, cols);
      } else if (ctype.includes('unique')) {
        const cols = columnList(def.definition);
        indexes.push({
          name: String(def.constraint ?? def.index ?? `uniq_${cols.join('_')}`),
          tableId: id,
          columns: cols,
          unique: true,
          primary: false,
        });
      } else if (ctype === 'foreign key') {
        const fk = foreignKeyFromConstraint(def, schema, name, defaultSchema);
        if (fk) {
          foreignKeys.push(fk);
          markFkColumns(columns, fk.columns);
        }
      }
    }
  }

  return {
    id,
    schema,
    name,
    kind: 'table',
    columns,
    indexes,
    foreignKeys,
    constraints: [],
    columnsHydrated: true,
  };
}

function applyAlterFk(
  node: Record<string, unknown>,
  tables: Map<string, TableMeta>,
  defaultSchema: string,
  warnings: string[]
): void {
  const tableRef = firstTableRef(node.table);
  if (!tableRef) {
    return;
  }
  const schema = tableRef.db || defaultSchema;
  const name = tableRef.table;
  const id = tableId(schema, name);
  const table = tables.get(id);
  if (!table) {
    warnings.push(`ALTER TABLE ${id}: table not found in import (CREATE it first)`);
    return;
  }

  const exprs = Array.isArray(node.expr) ? node.expr : [];
  for (const expr of exprs as Record<string, unknown>[]) {
    const action = String(expr.action ?? '').toLowerCase();
    const createDef = expr.create_definitions as Record<string, unknown> | undefined;
    if (action !== 'add' || !createDef) {
      continue;
    }
    const ctype = String(createDef.constraint_type ?? '').toLowerCase();
    if (ctype !== 'foreign key') {
      continue;
    }
    const fk = foreignKeyFromConstraint(createDef, schema, name, defaultSchema);
    if (!fk) {
      continue;
    }
    table.foreignKeys = [...(table.foreignKeys ?? []), fk];
    markFkColumns(table.columns ?? [], fk.columns);
  }
}

function foreignKeyFromConstraint(
  def: Record<string, unknown>,
  tableSchema: string,
  tableName: string,
  defaultSchema: string
): ForeignKeyMeta | undefined {
  const columns = columnList(def.definition);
  const ref = def.reference_definition as Record<string, unknown> | undefined;
  if (!ref || !columns.length) {
    return undefined;
  }
  const refTable = firstTableRef(ref.table);
  if (!refTable) {
    return undefined;
  }
  const referencedColumns = columnList(ref.definition);
  const onActions = Array.isArray(ref.on_action) ? ref.on_action : [];
  let onDelete: string | undefined;
  let onUpdate: string | undefined;
  for (const a of onActions as Record<string, unknown>[]) {
    const t = String(a.type ?? '').toLowerCase();
    const v = String((a.value as { value?: string } | undefined)?.value ?? a.value ?? '').toUpperCase();
    if (t.includes('delete')) {
      onDelete = v;
    }
    if (t.includes('update')) {
      onUpdate = v;
    }
  }
  return {
    name: String(def.constraint ?? `fk_${tableName}_${refTable.table}`),
    schema: tableSchema,
    table: tableName,
    columns,
    referencedSchema: refTable.db || defaultSchema,
    referencedTable: refTable.table,
    referencedColumns,
    onDelete,
    onUpdate,
  };
}

function firstTableRef(table: unknown): { db: string | null; table: string } | undefined {
  if (!table) {
    return undefined;
  }
  const arr = Array.isArray(table) ? table : [table];
  const first = arr[0] as { db?: string | null; table?: string } | undefined;
  if (!first?.table) {
    return undefined;
  }
  return { db: first.db ?? null, table: String(first.table) };
}

function columnName(col: unknown): string | undefined {
  if (!col) {
    return undefined;
  }
  if (typeof col === 'string') {
    return col;
  }
  const c = col as { column?: unknown };
  if (typeof c.column === 'string') {
    return c.column;
  }
  if (c.column && typeof c.column === 'object' && 'expr' in (c.column as object)) {
    const expr = (c.column as { expr?: { value?: string } }).expr;
    return expr?.value;
  }
  return undefined;
}

function columnList(def: unknown): string[] {
  if (!Array.isArray(def)) {
    const one = columnName(def);
    return one ? [one] : [];
  }
  return def.map((d) => columnName(d)).filter((x): x is string => Boolean(x));
}

function formatDataType(def: Record<string, unknown> | undefined): string {
  if (!def) {
    return 'TEXT';
  }
  const base = String(def.dataType ?? 'TEXT');
  const length = def.length;
  const scale = def.scale;
  const suffix = Array.isArray(def.suffix)
    ? def.suffix.map((s) => String(s).toUpperCase()).join(' ')
    : '';
  let type = base;
  if (length !== undefined && length !== null && def.parentheses) {
    type = scale !== undefined && scale !== null ? `${base}(${length},${scale})` : `${base}(${length})`;
  } else if (length !== undefined && length !== null && /^(VARCHAR|CHAR|VARBINARY|BINARY)$/i.test(base)) {
    type = `${base}(${length})`;
  } else if (length !== undefined && scale !== undefined) {
    type = `${base}(${length},${scale})`;
  }
  return suffix ? `${type} ${suffix}` : type;
}

function isNotNull(def: Record<string, unknown>): boolean {
  const n = def.nullable as { type?: string } | undefined;
  if (n && String(n.type).toLowerCase().includes('not null')) {
    return true;
  }
  if (def.primary) {
    return true;
  }
  return false;
}

function extractDefault(defaultVal: unknown): string | null {
  if (!defaultVal || typeof defaultVal !== 'object') {
    return null;
  }
  const v = (defaultVal as { value?: unknown }).value;
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as { type?: string; value?: unknown };
    if (o.type === 'null') {
      return null;
    }
    if (o.value !== undefined) {
      return String(o.value);
    }
  }
  return String(v);
}

function extractComment(comment: unknown): string | undefined {
  if (!comment || typeof comment !== 'object') {
    return undefined;
  }
  const v = (comment as { value?: { value?: string } | string }).value;
  if (typeof v === 'string') {
    return v;
  }
  if (v && typeof v === 'object' && 'value' in v) {
    return String((v as { value: string }).value);
  }
  return undefined;
}

function mergePrimary(indexes: IndexMeta[], tableIdStr: string, cols: string[]): void {
  const existing = indexes.find((i) => i.primary);
  if (existing) {
    existing.columns = cols;
    return;
  }
  indexes.push({
    name: 'PRIMARY',
    tableId: tableIdStr,
    columns: cols,
    unique: true,
    primary: true,
  });
}

function markPkColumns(columns: ColumnMeta[], pkCols: string[]): void {
  const set = new Set(pkCols);
  for (const c of columns) {
    if (set.has(c.name)) {
      c.columnKey = 'PRI';
    }
  }
}

function markFkColumns(columns: ColumnMeta[], fkCols: string[]): void {
  const set = new Set(fkCols);
  for (const c of columns) {
    if (set.has(c.name) && c.columnKey !== 'PRI') {
      c.columnKey = 'MUL';
    }
  }
}

function extractUseDb(node: Record<string, unknown>): string | undefined {
  const db = node.db;
  if (typeof db === 'string') {
    return db;
  }
  return undefined;
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ');
}

export function splitSqlStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
    } else if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
    }
    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}
