import * as vscode from 'vscode';
import type { ColumnMeta, SchemaDiffItem, TableMeta } from '../../shared/types';
import {
  COMMON_COLUMN_TYPES,
  buildAddColumnSql,
  buildDropColumnSql,
  buildModifyColumnSql,
  type AlterColumnInput,
  type ColumnDefinitionInput,
} from './columnDdl';
import { MutationPipeline } from './MutationPipeline';

export type TableEditAction = 'open' | 'addColumn' | 'alterColumn' | 'dropColumn';

export interface TableEditWizardResult {
  applied: boolean;
  action?: 'addColumn' | 'alterColumn' | 'dropColumn';
  sql?: string;
}

/**
 * Host-side QuickPick/InputBox flow for add / alter / drop column.
 * Always ends in MutationPipeline.proposePreviewConfirmExecute (SQL preview + confirm).
 */
export async function runTableEditWizard(input: {
  connectionId: string;
  table: TableMeta;
  mutations: MutationPipeline;
  action?: TableEditAction;
  /** Pre-selected column (alter/drop) */
  columnName?: string;
}): Promise<TableEditWizardResult> {
  const { table, connectionId, mutations } = input;

  if (table.kind === 'view') {
    void vscode.window.showWarningMessage(
      `Cannot ALTER columns on view ${table.id}. Edit the view definition instead.`
    );
    return { applied: false };
  }

  let action = input.action && input.action !== 'open' ? input.action : undefined;
  if (!action) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(add) Add column',
          description: 'ALTER TABLE … ADD COLUMN',
          action: 'addColumn' as const,
        },
        {
          label: '$(edit) Alter column',
          description: 'MODIFY / CHANGE COLUMN',
          action: 'alterColumn' as const,
        },
        {
          label: '$(trash) Drop column',
          description: 'DROP COLUMN (destructive)',
          action: 'dropColumn' as const,
        },
      ],
      {
        title: `Edit table ${table.id}`,
        placeHolder: 'Choose a column operation',
      }
    );
    if (!pick) {
      return { applied: false };
    }
    action = pick.action;
  }

  if (action === 'addColumn') {
    return addColumnFlow(connectionId, table, mutations);
  }
  if (action === 'alterColumn') {
    return alterColumnFlow(connectionId, table, mutations, input.columnName);
  }
  return dropColumnFlow(connectionId, table, mutations, input.columnName);
}

async function addColumnFlow(
  connectionId: string,
  table: TableMeta,
  mutations: MutationPipeline
): Promise<TableEditWizardResult> {
  const name = await vscode.window.showInputBox({
    title: `Add column to ${table.id}`,
    prompt: 'Column name',
    placeHolder: 'email',
    validateInput: (v) => validateColumnName(v, table.columns ?? []),
  });
  if (name === undefined) {
    return { applied: false };
  }

  const def = await collectColumnDefinition({
    title: `Define ${table.id}.${name.trim()}`,
    defaults: {
      name: name.trim(),
      columnType: 'VARCHAR(255)',
      isNullable: true,
      defaultValue: null,
    },
    existingColumns: table.columns ?? [],
  });
  if (!def) {
    return { applied: false };
  }

  const sql = buildAddColumnSql(table.schema, table.name, def);
  const expectedDiff: SchemaDiffItem = {
    objectType: 'column',
    objectId: `${table.id}.${def.name}`,
    change: 'added',
    after: def,
    summary: `ADD COLUMN ${def.name} ${def.columnType}`,
  };

  const applied = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: `Add column ${def.name} on ${table.id}`,
    intent: 'add-column',
    sql,
    expectedDiffItems: [expectedDiff],
  });

  return { applied, action: 'addColumn', sql };
}

async function alterColumnFlow(
  connectionId: string,
  table: TableMeta,
  mutations: MutationPipeline,
  preferredColumn?: string
): Promise<TableEditWizardResult> {
  const columns = table.columns ?? [];
  if (!columns.length) {
    void vscode.window.showWarningMessage(
      `No columns loaded for ${table.id}. Refresh the catalog and try again.`
    );
    return { applied: false };
  }

  const existing =
    (preferredColumn && columns.find((c) => c.name === preferredColumn)) ||
    (await pickColumn(columns, `Alter column on ${table.id}`));
  if (!existing) {
    return { applied: false };
  }

  const newName = await vscode.window.showInputBox({
    title: `Alter ${table.id}.${existing.name}`,
    prompt: 'Column name (change to rename)',
    value: existing.name,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) {
        return 'Name required';
      }
      if (t !== existing.name && columns.some((c) => c.name === t)) {
        return `Column ${t} already exists`;
      }
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) {
        return 'Use letters, digits, underscore (start with letter/_)';
      }
      return undefined;
    },
  });
  if (newName === undefined) {
    return { applied: false };
  }

  const def = await collectColumnDefinition({
    title: `Redefine ${table.id}.${existing.name}`,
    defaults: columnMetaToInput(existing, newName.trim()),
    existingColumns: columns.filter((c) => c.name !== existing.name),
  });
  if (!def) {
    return { applied: false };
  }

  const alter: AlterColumnInput = {
    ...def,
    previousName: existing.name,
  };
  const sql = buildModifyColumnSql(table.schema, table.name, alter);
  const renamed = existing.name !== def.name;
  const expectedDiff: SchemaDiffItem = {
    objectType: 'column',
    objectId: `${table.id}.${def.name}`,
    change: 'changed',
    before: existing,
    after: alter,
    summary: renamed
      ? `CHANGE COLUMN ${existing.name} → ${def.name} ${def.columnType}`
      : `MODIFY COLUMN ${def.name} ${def.columnType}`,
  };

  const applied = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: renamed
      ? `Rename/alter column ${existing.name} → ${def.name} on ${table.id}`
      : `Alter column ${def.name} on ${table.id}`,
    intent: 'alter-column',
    sql,
    expectedDiffItems: [expectedDiff],
  });

  return { applied, action: 'alterColumn', sql };
}

async function dropColumnFlow(
  connectionId: string,
  table: TableMeta,
  mutations: MutationPipeline,
  preferredColumn?: string
): Promise<TableEditWizardResult> {
  const columns = table.columns ?? [];
  if (!columns.length) {
    void vscode.window.showWarningMessage(
      `No columns loaded for ${table.id}. Refresh the catalog and try again.`
    );
    return { applied: false };
  }
  if (columns.length <= 1) {
    void vscode.window.showWarningMessage(
      `Cannot drop the only column on ${table.id}. Drop the table instead if that is intended.`
    );
    return { applied: false };
  }

  const existing =
    (preferredColumn && columns.find((c) => c.name === preferredColumn)) ||
    (await pickColumn(columns, `Drop column on ${table.id}`));
  if (!existing) {
    return { applied: false };
  }

  const sql = buildDropColumnSql(table.schema, table.name, existing.name);
  const expectedDiff: SchemaDiffItem = {
    objectType: 'column',
    objectId: `${table.id}.${existing.name}`,
    change: 'removed',
    before: existing,
    summary: `DROP COLUMN ${existing.name}`,
  };

  const applied = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: `Drop column ${existing.name} on ${table.id}`,
    intent: 'drop-column',
    sql,
    expectedDiffItems: [expectedDiff],
  });

  return { applied, action: 'dropColumn', sql };
}

async function pickColumn(
  columns: ColumnMeta[],
  title: string
): Promise<ColumnMeta | undefined> {
  const pick = await vscode.window.showQuickPick(
    columns.map((c) => ({
      label: c.name,
      description: c.columnType,
      detail: [
        c.isNullable ? 'NULL' : 'NOT NULL',
        c.columnKey || undefined,
        c.columnDefault !== null ? `DEFAULT ${c.columnDefault}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      column: c,
    })),
    { title, placeHolder: 'Select a column', matchOnDescription: true, matchOnDetail: true }
  );
  return pick?.column;
}

async function collectColumnDefinition(opts: {
  title: string;
  defaults: ColumnDefinitionInput;
  existingColumns: ColumnMeta[];
}): Promise<ColumnDefinitionInput | undefined> {
  const typePick = await vscode.window.showQuickPick(
    [
      ...COMMON_COLUMN_TYPES.map((t) => ({
        label: t,
        description: t === opts.defaults.columnType ? 'current' : undefined,
      })),
      { label: '$(edit) Custom type…', description: 'Enter a full MySQL type', custom: true },
    ],
    {
      title: opts.title,
      placeHolder: 'Column type',
      matchOnDescription: true,
    }
  );
  if (!typePick) {
    return undefined;
  }

  let columnType = opts.defaults.columnType;
  if ('custom' in typePick && typePick.custom) {
    const custom = await vscode.window.showInputBox({
      title: opts.title,
      prompt: 'MySQL column type',
      value: opts.defaults.columnType,
      placeHolder: 'VARCHAR(255)',
      validateInput: (v) => (v.trim() ? undefined : 'Type required'),
    });
    if (custom === undefined) {
      return undefined;
    }
    columnType = custom.trim();
  } else {
    columnType = typePick.label;
  }

  const nullPick = await vscode.window.showQuickPick(
    [
      { label: 'NULL', description: 'Allow NULL values', nullable: true },
      { label: 'NOT NULL', description: 'Disallow NULL', nullable: false },
    ],
    {
      title: opts.title,
      placeHolder: 'Nullability',
    }
  );
  if (!nullPick) {
    return undefined;
  }

  const defaultMode = await vscode.window.showQuickPick(
    [
      {
        label: 'No DEFAULT clause',
        description: 'Omit DEFAULT',
        mode: 'omit' as const,
      },
      {
        label: 'DEFAULT NULL',
        description: 'Explicit NULL default',
        mode: 'null' as const,
      },
      {
        label: 'DEFAULT value…',
        description: 'Literal or expression',
        mode: 'value' as const,
      },
    ],
    { title: opts.title, placeHolder: 'Default value' }
  );
  if (!defaultMode) {
    return undefined;
  }

  let defaultValue: string | null | undefined;
  if (defaultMode.mode === 'omit') {
    defaultValue = undefined;
  } else if (defaultMode.mode === 'null') {
    defaultValue = null;
  } else {
    const raw = await vscode.window.showInputBox({
      title: opts.title,
      prompt: 'Default (quote strings yourself or enter bare number / CURRENT_TIMESTAMP)',
      value:
        opts.defaults.defaultValue === null || opts.defaults.defaultValue === undefined
          ? ''
          : String(opts.defaults.defaultValue),
      placeHolder: "'' | 0 | CURRENT_TIMESTAMP",
    });
    if (raw === undefined) {
      return undefined;
    }
    defaultValue = raw.trim() === '' ? "''" : raw.trim();
  }

  type PositionPick = {
    label: string;
    description?: string;
    positionMode: 'none' | 'first' | 'after';
    column?: string;
  };
  const positionPick = await vscode.window.showQuickPick<PositionPick>(
    [
      { label: 'End of table (default)', positionMode: 'none' },
      { label: 'FIRST', positionMode: 'first' },
      ...opts.existingColumns.map((c) => ({
        label: `AFTER ${c.name}`,
        description: c.columnType,
        positionMode: 'after' as const,
        column: c.name,
      })),
    ],
    { title: opts.title, placeHolder: 'Column position' }
  );
  if (!positionPick) {
    return undefined;
  }

  let position: ColumnDefinitionInput['position'];
  if (positionPick.positionMode === 'first') {
    position = { kind: 'first' };
  } else if (positionPick.positionMode === 'after' && positionPick.column) {
    position = { kind: 'after', column: positionPick.column };
  }

  const comment = await vscode.window.showInputBox({
    title: opts.title,
    prompt: 'Column comment (optional)',
    value: opts.defaults.comment ?? '',
    placeHolder: 'Leave empty for none',
  });
  if (comment === undefined) {
    return undefined;
  }

  const extra = await vscode.window.showInputBox({
    title: opts.title,
    prompt: 'Extra attributes (optional)',
    value: opts.defaults.extra ?? '',
    placeHolder: 'AUTO_INCREMENT | ON UPDATE CURRENT_TIMESTAMP',
  });
  if (extra === undefined) {
    return undefined;
  }

  return {
    name: opts.defaults.name,
    columnType,
    isNullable: nullPick.nullable,
    defaultValue,
    comment: comment.trim() || undefined,
    extra: extra.trim() || undefined,
    position,
  };
}

function columnMetaToInput(col: ColumnMeta, name: string): ColumnDefinitionInput {
  return {
    name,
    columnType: col.columnType || col.dataType || 'VARCHAR(255)',
    isNullable: col.isNullable,
    defaultValue: col.columnDefault,
    extra: col.extra || undefined,
    comment: col.comment,
  };
}

function validateColumnName(value: string, existing: ColumnMeta[]): string | undefined {
  const name = value.trim();
  if (!name) {
    return 'Column name required';
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    return 'Use letters, digits, underscore (start with letter/_)';
  }
  if (existing.some((c) => c.name === name)) {
    return `Column ${name} already exists`;
  }
  return undefined;
}
