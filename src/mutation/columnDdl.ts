/**
 * Pure MySQL/MariaDB column DDL builders for MutationPipeline.
 * No VS Code / side effects — unit-testable.
 */

export interface ColumnDefinitionInput {
  name: string;
  /** Full MySQL type, e.g. VARCHAR(255), INT, DECIMAL(10,2) */
  columnType: string;
  isNullable: boolean;
  /**
   * undefined = omit DEFAULT clause;
   * null = DEFAULT NULL;
   * string = literal / expression (CURRENT_TIMESTAMP, numbers, quoted strings)
   */
  defaultValue?: string | null;
  /** e.g. AUTO_INCREMENT, ON UPDATE CURRENT_TIMESTAMP */
  extra?: string;
  comment?: string;
  /** Place AFTER this column; use FIRST for leading position */
  position?: { kind: 'first' } | { kind: 'after'; column: string };
}

export interface AlterColumnInput extends ColumnDefinitionInput {
  /** Existing column name when renaming (CHANGE COLUMN) */
  previousName?: string;
}

export function quoteIdent(ident: string): string {
  if (!ident || /[\x00\n\r]/.test(ident)) {
    throw new Error('Invalid SQL identifier');
  }
  return `\`${ident.replace(/`/g, '``')}\``;
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Format a DEFAULT clause value. Bare numbers, NULL, TRUE/FALSE,
 * CURRENT_TIMESTAMP(+), and parenthesized expressions stay unquoted.
 */
export function formatDefaultValue(value: string | null): string {
  if (value === null) {
    return 'NULL';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "''";
  }
  if (/^(NULL|TRUE|FALSE)$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^CURRENT_TIMESTAMP(?:\(\d*\))?$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return trimmed;
  }
  // Already single-quoted literal
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed;
  }
  return `'${trimmed.replace(/'/g, "''")}'`;
}

export function buildColumnDefinition(col: ColumnDefinitionInput): string {
  const name = col.name.trim();
  const type = col.columnType.trim();
  if (!name) {
    throw new Error('Column name is required');
  }
  if (!type) {
    throw new Error('Column type is required');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`Invalid column name: ${name}`);
  }

  const parts: string[] = [quoteIdent(name), type];
  parts.push(col.isNullable ? 'NULL' : 'NOT NULL');

  if (col.defaultValue !== undefined) {
    parts.push(`DEFAULT ${formatDefaultValue(col.defaultValue)}`);
  }

  if (col.extra?.trim()) {
    parts.push(col.extra.trim());
  }

  if (col.comment?.trim()) {
    parts.push(`COMMENT '${col.comment.trim().replace(/'/g, "''")}'`);
  }

  return parts.join(' ');
}

function positionClause(position?: ColumnDefinitionInput['position']): string {
  if (!position) {
    return '';
  }
  if (position.kind === 'first') {
    return ' FIRST';
  }
  return ` AFTER ${quoteIdent(position.column)}`;
}

export function buildAddColumnSql(
  schema: string,
  table: string,
  col: ColumnDefinitionInput
): string {
  return (
    `ALTER TABLE ${qualifyTable(schema, table)}\n` +
    `  ADD COLUMN ${buildColumnDefinition(col)}${positionClause(col.position)};`
  );
}

export function buildModifyColumnSql(
  schema: string,
  table: string,
  col: AlterColumnInput
): string {
  const prev = (col.previousName ?? col.name).trim();
  const next = col.name.trim();
  if (prev !== next) {
    // CHANGE COLUMN can rename + redefine
    const def = buildColumnDefinition(col);
    // buildColumnDefinition starts with quoted new name — CHANGE needs old then new def
    return (
      `ALTER TABLE ${qualifyTable(schema, table)}\n` +
      `  CHANGE COLUMN ${quoteIdent(prev)} ${def}${positionClause(col.position)};`
    );
  }
  return (
    `ALTER TABLE ${qualifyTable(schema, table)}\n` +
    `  MODIFY COLUMN ${buildColumnDefinition(col)}${positionClause(col.position)};`
  );
}

export function buildDropColumnSql(schema: string, table: string, columnName: string): string {
  const name = columnName.trim();
  if (!name) {
    throw new Error('Column name is required');
  }
  return (
    `ALTER TABLE ${qualifyTable(schema, table)}\n` +
    `  DROP COLUMN ${quoteIdent(name)};`
  );
}

/** Common MySQL/MariaDB types offered in the edit wizard */
export const COMMON_COLUMN_TYPES = [
  'INT',
  'BIGINT',
  'TINYINT(1)',
  'SMALLINT',
  'VARCHAR(50)',
  'VARCHAR(100)',
  'VARCHAR(255)',
  'CHAR(36)',
  'TEXT',
  'MEDIUMTEXT',
  'DECIMAL(10,2)',
  'DOUBLE',
  'FLOAT',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'JSON',
  'BLOB',
] as const;
