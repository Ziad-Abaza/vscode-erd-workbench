/**
 * Pure MySQL/MariaDB relationship DDL builders (FK + N:M junction).
 * No VS Code / side effects — unit-testable.
 */

import { quoteIdent, qualifyTable } from './columnDdl';

export type ReferentialAction =
  | 'RESTRICT'
  | 'CASCADE'
  | 'SET NULL'
  | 'NO ACTION'
  | 'SET DEFAULT';

export interface PhysicalFkInput {
  schema: string;
  table: string;
  constraintName: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export interface JunctionFkSide {
  /** Column names on the junction table */
  columns: string[];
  /** Matching referenced columns on the parent table */
  refColumns: string[];
  /** MySQL types for junction columns (aligned with columns[]) */
  columnTypes: string[];
  refSchema: string;
  refTable: string;
  constraintName: string;
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}

export interface NmJunctionInput {
  schema: string;
  junctionName: string;
  left: JunctionFkSide;
  right: JunctionFkSide;
  /** Optional extra columns, already formatted as `name TYPE …` fragments */
  extraColumnDefs?: string[];
}

export function suggestFkColumnName(refTable: string, refColumn: string): string {
  const table = refTable.replace(/[^A-Za-z0-9_]/g, '') || 'ref';
  if (refColumn.toLowerCase() === 'id') {
    return `${table}_id`;
  }
  if (refColumn.toLowerCase().startsWith(`${table.toLowerCase()}_`)) {
    return refColumn;
  }
  return `${table}_${refColumn}`;
}

export function suggestJunctionName(leftTable: string, rightTable: string): string {
  return `${leftTable}_${rightTable}`;
}

function refActionClause(onDelete?: ReferentialAction, onUpdate?: ReferentialAction): string {
  const parts: string[] = [];
  if (onDelete) {
    parts.push(`ON DELETE ${onDelete}`);
  }
  if (onUpdate) {
    parts.push(`ON UPDATE ${onUpdate}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function buildPhysicalFkSql(input: PhysicalFkInput): string {
  if (input.columns.length === 0 || input.columns.length !== input.refColumns.length) {
    throw new Error('FK columns and referenced columns must be non-empty and same length');
  }
  const cols = input.columns.map(quoteIdent).join(', ');
  const refs = input.refColumns.map(quoteIdent).join(', ');
  return (
    `ALTER TABLE ${qualifyTable(input.schema, input.table)}\n` +
    `  ADD CONSTRAINT ${quoteIdent(input.constraintName)}\n` +
    `  FOREIGN KEY (${cols}) REFERENCES ${qualifyTable(input.refSchema, input.refTable)} (${refs})` +
    `${refActionClause(input.onDelete, input.onUpdate)};`
  );
}

/**
 * ADD COLUMN (matching parent types) + ADD CONSTRAINT in one batch for MutationPipeline.
 */
export function buildAddFkColumnsAndConstraintSql(input: {
  schema: string;
  table: string;
  newColumns: Array<{ name: string; columnType: string; isNullable: boolean }>;
  constraintName: string;
  fkColumns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
}): string {
  if (!input.newColumns.length) {
    return buildPhysicalFkSql({
      schema: input.schema,
      table: input.table,
      constraintName: input.constraintName,
      columns: input.fkColumns,
      refSchema: input.refSchema,
      refTable: input.refTable,
      refColumns: input.refColumns,
      onDelete: input.onDelete,
      onUpdate: input.onUpdate,
    });
  }

  const adds = input.newColumns
    .map((c) => {
      const nullability = c.isNullable ? 'NULL' : 'NOT NULL';
      return `  ADD COLUMN ${quoteIdent(c.name)} ${c.columnType} ${nullability}`;
    })
    .join(',\n');

  const cols = input.fkColumns.map(quoteIdent).join(', ');
  const refs = input.refColumns.map(quoteIdent).join(', ');
  return (
    `ALTER TABLE ${qualifyTable(input.schema, input.table)}\n` +
    `${adds},\n` +
    `  ADD CONSTRAINT ${quoteIdent(input.constraintName)}\n` +
    `  FOREIGN KEY (${cols}) REFERENCES ${qualifyTable(input.refSchema, input.refTable)} (${refs})` +
    `${refActionClause(input.onDelete, input.onUpdate)};`
  );
}

export function buildNmJunctionSql(input: NmJunctionInput): string {
  const { left, right } = input;
  if (
    left.columns.length === 0 ||
    left.columns.length !== left.refColumns.length ||
    left.columns.length !== left.columnTypes.length
  ) {
    throw new Error('Left junction FK columns/types/refs length mismatch');
  }
  if (
    right.columns.length === 0 ||
    right.columns.length !== right.refColumns.length ||
    right.columns.length !== right.columnTypes.length
  ) {
    throw new Error('Right junction FK columns/types/refs length mismatch');
  }

  const leftDefs = left.columns
    .map((c, i) => `  ${quoteIdent(c)} ${left.columnTypes[i]} NOT NULL`)
    .join(',\n');
  const rightDefs = right.columns
    .map((c, i) => `  ${quoteIdent(c)} ${right.columnTypes[i]} NOT NULL`)
    .join(',\n');
  const extras = (input.extraColumnDefs ?? []).map((d) => `  ${d}`).join(',\n');
  const pk = [...left.columns, ...right.columns].map(quoteIdent).join(', ');

  const leftFk =
    `  CONSTRAINT ${quoteIdent(left.constraintName)} FOREIGN KEY (${left.columns.map(quoteIdent).join(', ')})\n` +
    `    REFERENCES ${qualifyTable(left.refSchema, left.refTable)} (${left.refColumns.map(quoteIdent).join(', ')})` +
    `${refActionClause(left.onDelete, left.onUpdate)}`;

  const rightFk =
    `  CONSTRAINT ${quoteIdent(right.constraintName)} FOREIGN KEY (${right.columns.map(quoteIdent).join(', ')})\n` +
    `    REFERENCES ${qualifyTable(right.refSchema, right.refTable)} (${right.refColumns.map(quoteIdent).join(', ')})` +
    `${refActionClause(right.onDelete, right.onUpdate)}`;

  const body = [leftDefs, rightDefs, extras, `  PRIMARY KEY (${pk})`, leftFk, rightFk]
    .filter((s) => s && String(s).trim())
    .join(',\n');

  return `CREATE TABLE ${qualifyTable(input.schema, input.junctionName)} (\n${body}\n);`;
}

/** Prefer primary key columns; fall back to first unique index; else empty. */
export function defaultReferencedColumns(table: {
  columns?: Array<{ name: string; columnKey: string }>;
  indexes?: Array<{ primary: boolean; unique: boolean; columns: string[] }>;
}): string[] {
  const pk = table.indexes?.find((i) => i.primary)?.columns;
  if (pk?.length) {
    return [...pk];
  }
  const uniq = table.indexes?.find((i) => i.unique && i.columns.length)?.columns;
  if (uniq?.length) {
    return [...uniq];
  }
  const priCols = (table.columns ?? []).filter((c) => c.columnKey === 'PRI').map((c) => c.name);
  return priCols;
}

export function columnTypeMap(
  table: { columns?: Array<{ name: string; columnType: string; dataType: string }> }
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of table.columns ?? []) {
    map.set(c.name, c.columnType || c.dataType || 'INT');
  }
  return map;
}
