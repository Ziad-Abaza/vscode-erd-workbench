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
 * Pragmatic DBML importer covering the subset we export + common dbdiagram.io shapes:
 *   Table schema.name { col type [pk, not null] }
 *   Table name { … }
 *   Ref: schema.a.col > schema.b.col
 *   Ref: a.col > b.col
 *   Ref: a.col <> b.col   (N:M annotated as two visual-style notes → physical if both sides exist)
 */
export function parseDbml(content: string, options: ImportOptions = {}): SchemaImportResult {
  const defaultSchema = options.defaultSchema?.trim() || 'default';
  const warnings: string[] = [];
  const tables = new Map<string, TableMeta>();

  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '\n').replace(/^\s*\/\/.*$/gm, '');

  const tableRe = /Table\s+([A-Za-z0-9_$.`"]+)\s*(?:\([^)]*\))?\s*\{([^}]*)\}/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(stripped))) {
    const rawName = m[1].replace(/[`"]/g, '');
    const body = m[2];
    const { schema, name } = splitQualName(rawName, defaultSchema);
    const id = tableId(schema, name);
    const columns: ColumnMeta[] = [];
    const indexes: IndexMeta[] = [];
    let ordinal = 0;

    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Note') || trimmed.startsWith('Indexes')) {
        continue;
      }
      // col type [settings]
      const colMatch = trimmed.match(
        /^([A-Za-z_][A-Za-z0-9_$]*)\s+([A-Za-z0-9_(),.\s]+?)(?:\s*\[([^\]]*)\])?\s*$/
      );
      if (!colMatch) {
        continue;
      }
      ordinal += 1;
      const colName = colMatch[1];
      const colType = colMatch[2].trim();
      const settings = (colMatch[3] ?? '').toLowerCase();
      const isPk = /\bpk\b/.test(settings) || /\bprimary\s*key\b/.test(settings);
      const isUnique = /\bunique\b/.test(settings);
      const notNull = /\bnot\s*null\b/.test(settings) || isPk;
      const increment = /\bincrement\b/.test(settings);
      columns.push({
        name: colName,
        ordinalPosition: ordinal,
        dataType: colType.replace(/\(.*\)$/, ''),
        columnType: colType,
        isNullable: !notNull,
        columnKey: isPk ? 'PRI' : isUnique ? 'UNI' : '',
        extra: increment ? 'auto_increment' : '',
        columnDefault: null,
      });
      if (isPk) {
        indexes.push({
          name: 'PRIMARY',
          tableId: id,
          columns: [colName],
          unique: true,
          primary: true,
        });
      }
    }

    tables.set(id, {
      id,
      schema,
      name,
      kind: 'table',
      columns,
      indexes,
      foreignKeys: [],
      constraints: [],
      columnsHydrated: true,
    });
  }

  // Refs
  const refRe =
    /Ref(?:\s+[A-Za-z0-9_]+)?\s*:\s*([A-Za-z0-9_$.`"]+)\s*([-<>]+)\s*([A-Za-z0-9_$.`"]+)/gi;
  while ((m = refRe.exec(stripped))) {
    const left = parseColumnRef(m[1].replace(/[`"]/g, ''), defaultSchema);
    const right = parseColumnRef(m[3].replace(/[`"]/g, ''), defaultSchema);
    const op = m[2];
    if (!left || !right) {
      warnings.push(`Could not parse Ref: ${m[0]}`);
      continue;
    }

    // DBML: left > right means left is many side (FK), right is one (referenced)
    // <> is N:M — we still store as FK-like edge pair via physical if possible
    let fkTable = left;
    let refTable = right;
    if (op.includes('<') && !op.includes('>')) {
      // left < right → FK on right
      fkTable = right;
      refTable = left;
    }

    const table = tables.get(fkTable.tableId);
    if (!table) {
      warnings.push(`Ref target table missing: ${fkTable.tableId}`);
      continue;
    }
    if (!tables.has(refTable.tableId)) {
      warnings.push(`Ref referenced table missing: ${refTable.tableId}`);
    }

    const fkName = `fk_${table.name}_${refTable.table}_${fkTable.column}`;
    const fk: ForeignKeyMeta = {
      name: fkName,
      schema: table.schema,
      table: table.name,
      columns: [fkTable.column],
      referencedSchema: refTable.schema,
      referencedTable: refTable.table,
      referencedColumns: [refTable.column],
    };
    table.foreignKeys = [...(table.foreignKeys ?? []), fk];
    for (const c of table.columns ?? []) {
      if (c.name === fkTable.column && c.columnKey !== 'PRI') {
        c.columnKey = 'MUL';
      }
    }
  }

  const list = [...tables.values()];
  if (!list.length) {
    throw new Error('No Table { … } blocks found in DBML');
  }

  return {
    format: 'dbml',
    tables: list,
    edges: buildPhysicalEdges(list),
    diagram: null,
    schemas: [...new Set(list.map((t) => t.schema))].sort(),
    warnings,
    nameHint: 'Imported DBML schema',
  };
}

function splitQualName(
  raw: string,
  defaultSchema: string
): { schema: string; name: string } {
  const parts = raw.split('.').filter(Boolean);
  if (parts.length >= 2) {
    return { schema: parts[0], name: parts.slice(1).join('.') };
  }
  return { schema: defaultSchema, name: parts[0] || raw };
}

function parseColumnRef(
  raw: string,
  defaultSchema: string
): { schema: string; table: string; tableId: string; column: string } | undefined {
  const parts = raw.split('.').filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  if (parts.length === 2) {
    const schema = defaultSchema;
    const table = parts[0];
    const column = parts[1];
    return { schema, table, column, tableId: tableId(schema, table) };
  }
  const column = parts[parts.length - 1];
  const table = parts[parts.length - 2];
  const schema = parts.slice(0, -2).join('.') || defaultSchema;
  return { schema, table, column, tableId: tableId(schema, table) };
}
