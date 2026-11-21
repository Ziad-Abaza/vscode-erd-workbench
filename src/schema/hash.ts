import * as crypto from 'crypto';
import type { TableMeta } from '../../shared/types';

/** Stable JSON stringify with sorted keys for hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hashTableMeta(table: TableMeta): string {
  const normalized = {
    schema: table.schema,
    name: table.name,
    kind: table.kind,
    columns: (table.columns ?? []).map((c) => ({
      name: c.name,
      columnType: c.columnType,
      isNullable: c.isNullable,
      columnKey: c.columnKey,
      extra: c.extra,
      columnDefault: c.columnDefault,
    })),
    indexes: (table.indexes ?? []).map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: i.unique,
      primary: i.primary,
    })),
    foreignKeys: (table.foreignKeys ?? []).map((f) => ({
      name: f.name,
      columns: f.columns,
      referencedSchema: f.referencedSchema,
      referencedTable: f.referencedTable,
      referencedColumns: f.referencedColumns,
      onUpdate: f.onUpdate,
      onDelete: f.onDelete,
    })),
    constraints: (table.constraints ?? []).map((c) => ({
      name: c.name,
      type: c.type,
      columns: c.columns,
      checkClause: c.checkClause,
    })),
  };
  return sha256(stableStringify(normalized));
}
