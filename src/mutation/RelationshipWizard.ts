import * as vscode from 'vscode';
import type {
  Cardinality,
  ColumnMeta,
  DiagramEdge,
  SchemaDiffItem,
  TableMeta,
} from '../../shared/types';
import { MutationPipeline } from './MutationPipeline';
import {
  buildAddFkColumnsAndConstraintSql,
  buildNmJunctionSql,
  buildPhysicalFkSql,
  columnTypeMap,
  defaultReferencedColumns,
  suggestFkColumnName,
  suggestJunctionName,
  type ReferentialAction,
} from './relationshipDdl';

export interface RelationshipWizardResult {
  applied: boolean;
  mode?: 'visual' | 'physical';
  /** Edge to persist on the diagram (visual always; physical after successful DDL) */
  edge?: Omit<DiagramEdge, 'id'> & { id?: string };
  /** Junction table id created for N:M (schema.name) */
  junctionTableId?: string;
  sql?: string;
}

const REF_ACTIONS: ReferentialAction[] = [
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'NO ACTION',
  'SET DEFAULT',
];

export interface PromoteInferredPrefill {
  sourceColumns: string[];
  targetColumns: string[];
  cardinality: Cardinality;
  /** Short label shown in confirm pick, e.g. orders.user_id → users.id */
  mappingLabel?: string;
}

/**
 * Host QuickPick flow for creating relationships from an ERD connection gesture.
 * Physical path always ends in MutationPipeline SQL preview + confirm.
 */
export async function runRelationshipWizard(input: {
  connectionId: string;
  sourceTable: TableMeta;
  targetTable: TableMeta;
  mutations: MutationPipeline;
}): Promise<RelationshipWizardResult> {
  const { sourceTable, targetTable, connectionId, mutations } = input;

  if (sourceTable.id === targetTable.id) {
    void vscode.window.showWarningMessage('Cannot create a relationship from a table to itself.');
    return { applied: false };
  }

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(eye) Visual only',
        description: 'Diagram annotation — no database change',
        mode: 'visual' as const,
      },
      {
        label: '$(database) Physical',
        description: 'SQL preview + confirm via MutationPipeline',
        mode: 'physical' as const,
      },
    ],
    {
      title: `Relationship: ${sourceTable.name} → ${targetTable.name}`,
      placeHolder: 'Visual (default) or physical foreign key / junction',
    }
  );
  if (!modePick) {
    return { applied: false };
  }

  const cardPick = await vscode.window.showQuickPick(
    [
      {
        label: '1:N',
        description: `FK on ${sourceTable.name} → ${targetTable.name} (many → one)`,
        cardinality: '1:N' as const,
      },
      {
        label: '1:1',
        description: `FK on ${sourceTable.name} → ${targetTable.name} (unique)`,
        cardinality: '1:1' as const,
      },
      {
        label: 'N:M',
        description: 'Create junction table with two FKs',
        cardinality: 'N:M' as const,
      },
    ],
    {
      title: 'Cardinality',
      placeHolder: 'Choose relationship cardinality',
    }
  );
  if (!cardPick) {
    return { applied: false };
  }

  if (modePick.mode === 'visual') {
    return visualFlow(sourceTable, targetTable, cardPick.cardinality);
  }

  if (cardPick.cardinality === 'N:M') {
    return physicalNmFlow(connectionId, sourceTable, targetTable, mutations);
  }

  return physicalFkFlow(
    connectionId,
    sourceTable,
    targetTable,
    cardPick.cardinality,
    mutations
  );
}

/**
 * Tight promote path for inferred edges: skip visual/mode/cardinality picks when
 * suggested columns already exist on both tables. Still asks ON DELETE/UPDATE
 * and always goes through MutationPipeline preview + confirm.
 */
export async function runPromoteInferredWizard(input: {
  connectionId: string;
  sourceTable: TableMeta;
  targetTable: TableMeta;
  mutations: MutationPipeline;
  prefill: PromoteInferredPrefill;
}): Promise<RelationshipWizardResult> {
  const { sourceTable, targetTable, connectionId, mutations, prefill } = input;

  if (sourceTable.id === targetTable.id) {
    void vscode.window.showWarningMessage('Cannot promote a self-relationship.');
    return { applied: false };
  }

  if (prefill.cardinality === 'N:M') {
    // Inferred suggestions are 1:N today; N:M falls back to full physical junction flow.
    return physicalNmFlow(connectionId, sourceTable, targetTable, mutations);
  }

  const cardinality: '1:1' | '1:N' =
    prefill.cardinality === '1:1' ? '1:1' : '1:N';

  const sourceNames = new Set((sourceTable.columns ?? []).map((c) => c.name));
  const targetNames = new Set((targetTable.columns ?? []).map((c) => c.name));
  const colsReady =
    prefill.sourceColumns.length > 0 &&
    prefill.targetColumns.length > 0 &&
    prefill.sourceColumns.length === prefill.targetColumns.length &&
    prefill.sourceColumns.every((c) => sourceNames.has(c)) &&
    prefill.targetColumns.every((c) => targetNames.has(c));

  const mapping =
    prefill.mappingLabel ??
    `${sourceTable.name}.(${prefill.sourceColumns.join(', ')}) → ${targetTable.name}.(${prefill.targetColumns.join(', ')})`;

  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: '$(database) Promote with suggested columns',
        description: mapping,
        detail: `${cardinality} physical FK · SQL preview next`,
        choice: 'use' as const,
      },
      {
        label: '$(edit) Change columns…',
        description: 'Full column picker (existing or create)',
        choice: 'change' as const,
      },
      {
        label: '$(close) Cancel',
        choice: 'cancel' as const,
      },
    ],
    {
      title: `Promote inferred → physical: ${sourceTable.name} → ${targetTable.name}`,
      placeHolder: 'Confirm suggested FK mapping or change columns',
    }
  );
  if (!confirm || confirm.choice === 'cancel') {
    return { applied: false };
  }

  if (confirm.choice === 'change' || !colsReady) {
    if (!colsReady && confirm.choice === 'use') {
      void vscode.window.showWarningMessage(
        'Suggested columns are missing from the catalog — pick columns manually.'
      );
    }
    return physicalFkFlow(connectionId, sourceTable, targetTable, cardinality, mutations);
  }

  return physicalFkFlowWithColumns(
    connectionId,
    sourceTable,
    targetTable,
    cardinality,
    prefill.sourceColumns,
    prefill.targetColumns,
    mutations
  );
}

/**
 * Physical FK when columns are already chosen (promote shortcut).
 * Still collects referential actions + MutationPipeline confirm.
 */
async function physicalFkFlowWithColumns(
  connectionId: string,
  source: TableMeta,
  target: TableMeta,
  cardinality: '1:1' | '1:N',
  fkColumns: string[],
  refCols: string[],
  mutations: MutationPipeline
): Promise<RelationshipWizardResult> {
  const onDelete = await pickRefAction('ON DELETE', 'RESTRICT');
  if (onDelete === undefined) {
    return { applied: false };
  }
  const onUpdate = await pickRefAction('ON UPDATE', 'RESTRICT');
  if (onUpdate === undefined) {
    return { applied: false };
  }

  const constraintName = `fk_${source.name}_${target.name}_${fkColumns.join('_')}`.slice(0, 64);
  const sql = buildAddFkColumnsAndConstraintSql({
    schema: source.schema,
    table: source.name,
    newColumns: [],
    constraintName,
    fkColumns,
    refSchema: target.schema,
    refTable: target.name,
    refColumns: refCols,
    onDelete,
    onUpdate,
  });

  const ok = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: `Promote inferred FK ${source.id} → ${target.id}`,
    intent: cardinality === '1:1' ? 'physical-fk-1-1' : 'physical-fk-1-n',
    sql,
    expectedDiffItems: [
      {
        objectType: 'fk',
        objectId: `${source.id}.${constraintName}`,
        change: 'added',
        summary: `ADD FK (${fkColumns.join(', ')}) → ${target.id}(${refCols.join(', ')})`,
      },
    ],
  });

  if (!ok) {
    return { applied: false, mode: 'physical', sql };
  }

  return {
    applied: true,
    mode: 'physical',
    sql,
    edge: {
      sourceTableId: source.id,
      targetTableId: target.id,
      sourceColumns: fkColumns,
      targetColumns: refCols,
      cardinality,
      relationshipKind: 'physical',
      constraintName,
      label: fkColumns.join(', '),
    },
  };
}

async function visualFlow(
  source: TableMeta,
  target: TableMeta,
  cardinality: Cardinality
): Promise<RelationshipWizardResult> {
  let sourceColumns: string[] = [];
  let targetColumns: string[] = [];

  if (cardinality === 'N:M') {
    // Visual N:M — optional column labels only
    const label = await vscode.window.showInputBox({
      title: `Visual N:M: ${source.name} ↔ ${target.name}`,
      prompt: 'Optional edge label',
      placeHolder: 'e.g. enrolled_in',
    });
    if (label === undefined) {
      return { applied: false };
    }
    return {
      applied: true,
      mode: 'visual',
      edge: {
        sourceTableId: source.id,
        targetTableId: target.id,
        sourceColumns: [],
        targetColumns: [],
        cardinality: 'N:M',
        relationshipKind: 'visual',
        label: label.trim() || undefined,
      },
    };
  }

  const wantCols = await vscode.window.showQuickPick(
    [
      { label: 'Skip columns', description: 'Visual link without column mapping', pick: false },
      { label: 'Pick columns…', description: 'Annotate FK ↔ referenced columns', pick: true },
    ],
    { title: 'Visual relationship columns', placeHolder: 'Optional column mapping' }
  );
  if (!wantCols) {
    return { applied: false };
  }

  if (wantCols.pick) {
    const refCols = await pickColumns(
      target,
      defaultReferencedColumns(target),
      `Referenced columns on ${target.id}`
    );
    if (!refCols) {
      return { applied: false };
    }
    targetColumns = refCols;

    const suggested = refCols.map((c) => suggestFkColumnName(target.name, c));
    const fkCols = await pickColumns(
      source,
      matchExistingOrSuggested(source, suggested),
      `FK columns on ${source.id} (same count as referenced)`,
      refCols.length
    );
    if (!fkCols) {
      return { applied: false };
    }
    sourceColumns = fkCols;
  }

  return {
    applied: true,
    mode: 'visual',
    edge: {
      sourceTableId: source.id,
      targetTableId: target.id,
      sourceColumns,
      targetColumns,
      cardinality,
      relationshipKind: 'visual',
      label: sourceColumns.length ? sourceColumns.join(', ') : undefined,
    },
  };
}

async function physicalFkFlow(
  connectionId: string,
  source: TableMeta,
  target: TableMeta,
  cardinality: '1:1' | '1:N',
  mutations: MutationPipeline
): Promise<RelationshipWizardResult> {
  const refDefault = defaultReferencedColumns(target);
  if (!refDefault.length && !(target.columns ?? []).length) {
    void vscode.window.showWarningMessage(
      `No columns loaded for ${target.id}. Refresh the catalog and try again.`
    );
    return { applied: false };
  }

  const refCols = await pickColumns(
    target,
    refDefault.length ? refDefault : [(target.columns ?? [])[0]?.name].filter(Boolean) as string[],
    `Referenced columns on parent ${target.id}`
  );
  if (!refCols?.length) {
    return { applied: false };
  }

  const types = columnTypeMap(target);
  const suggestedNames = refCols.map((c) => suggestFkColumnName(target.name, c));
  const existingNames = new Set((source.columns ?? []).map((c) => c.name));

  const columnStrategy = await vscode.window.showQuickPick(
    [
      {
        label: '$(list-selection) Use existing columns',
        description: `Pick FK columns on ${source.name}`,
        strategy: 'existing' as const,
      },
      {
        label: '$(add) Create new FK column(s)',
        description: `ADD COLUMN on ${source.name} matching ${target.name} types, then ADD CONSTRAINT`,
        strategy: 'create' as const,
      },
    ],
    { title: 'Foreign key columns', placeHolder: 'Existing or create new' }
  );
  if (!columnStrategy) {
    return { applied: false };
  }

  let fkColumns: string[] = [];
  let newColumns: Array<{ name: string; columnType: string; isNullable: boolean }> = [];

  if (columnStrategy.strategy === 'existing') {
    const picked = await pickColumns(
      source,
      matchExistingOrSuggested(source, suggestedNames),
      `FK columns on child ${source.id} (${refCols.length} required)`,
      refCols.length
    );
    if (!picked) {
      return { applied: false };
    }
    fkColumns = picked;
  } else {
    for (let i = 0; i < refCols.length; i++) {
      const refCol = refCols[i];
      const suggested = suggestedNames[i];
      const colType = types.get(refCol) ?? 'INT';
      const name = await vscode.window.showInputBox({
        title: `New FK column for ${target.name}.${refCol}`,
        prompt: `Column name on ${source.id} (${colType})`,
        value: existingNames.has(suggested) ? `${suggested}_ref` : suggested,
        validateInput: (v) => {
          const t = v.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) {
            return 'Invalid column name';
          }
          if (existingNames.has(t) || newColumns.some((c) => c.name === t)) {
            return `Column ${t} already exists`;
          }
          return undefined;
        },
      });
      if (name === undefined) {
        return { applied: false };
      }
      newColumns.push({
        name: name.trim(),
        columnType: colType,
        isNullable: cardinality === '1:N',
      });
      fkColumns.push(name.trim());
    }
  }

  const onDelete = await pickRefAction('ON DELETE', 'RESTRICT');
  if (onDelete === undefined) {
    return { applied: false };
  }
  const onUpdate = await pickRefAction('ON UPDATE', 'RESTRICT');
  if (onUpdate === undefined) {
    return { applied: false };
  }

  const constraintName = `fk_${source.name}_${target.name}_${fkColumns.join('_')}`.slice(0, 64);
  const sql = buildAddFkColumnsAndConstraintSql({
    schema: source.schema,
    table: source.name,
    newColumns,
    constraintName,
    fkColumns,
    refSchema: target.schema,
    refTable: target.name,
    refColumns: refCols,
    onDelete,
    onUpdate,
  });

  const diffItems: SchemaDiffItem[] = [
    ...newColumns.map((c) => ({
      objectType: 'column' as const,
      objectId: `${source.id}.${c.name}`,
      change: 'added' as const,
      after: c,
      summary: `ADD COLUMN ${c.name} ${c.columnType}`,
    })),
    {
      objectType: 'fk',
      objectId: `${source.id}.${constraintName}`,
      change: 'added',
      summary: `ADD FK (${fkColumns.join(', ')}) → ${target.id}(${refCols.join(', ')})`,
    },
  ];

  const ok = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: `Create FK ${source.id} → ${target.id}`,
    intent: cardinality === '1:1' ? 'physical-fk-1-1' : 'physical-fk-1-n',
    sql,
    expectedDiffItems: diffItems,
  });

  if (!ok) {
    return { applied: false, mode: 'physical', sql };
  }

  return {
    applied: true,
    mode: 'physical',
    sql,
    edge: {
      sourceTableId: source.id,
      targetTableId: target.id,
      sourceColumns: fkColumns,
      targetColumns: refCols,
      cardinality,
      relationshipKind: 'physical',
      constraintName,
      label: fkColumns.join(', '),
    },
  };
}

async function physicalNmFlow(
  connectionId: string,
  left: TableMeta,
  right: TableMeta,
  mutations: MutationPipeline
): Promise<RelationshipWizardResult> {
  const leftRefs = await pickColumns(
    left,
    defaultReferencedColumns(left),
    `Key columns on ${left.id} (referenced by junction)`
  );
  if (!leftRefs?.length) {
    return { applied: false };
  }
  const rightRefs = await pickColumns(
    right,
    defaultReferencedColumns(right),
    `Key columns on ${right.id} (referenced by junction)`
  );
  if (!rightRefs?.length) {
    return { applied: false };
  }

  const junctionSchema = await vscode.window.showInputBox({
    title: 'Junction table schema',
    value: left.schema,
    validateInput: (v) => (v.trim() ? undefined : 'Schema required'),
  });
  if (junctionSchema === undefined) {
    return { applied: false };
  }

  const junctionName = await vscode.window.showInputBox({
    title: 'Junction table name',
    value: suggestJunctionName(left.name, right.name),
    validateInput: (v) => {
      const t = v.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) {
        return 'Invalid table name';
      }
      return undefined;
    },
  });
  if (junctionName === undefined) {
    return { applied: false };
  }

  const leftTypes = columnTypeMap(left);
  const rightTypes = columnTypeMap(right);

  const leftJunctionCols: string[] = [];
  for (const ref of leftRefs) {
    const suggested = suggestFkColumnName(left.name, ref);
    const name = await vscode.window.showInputBox({
      title: `Junction column → ${left.name}.${ref}`,
      value: suggested,
      validateInput: (v) =>
        /^[A-Za-z_][A-Za-z0-9_$]*$/.test(v.trim()) ? undefined : 'Invalid name',
    });
    if (name === undefined) {
      return { applied: false };
    }
    leftJunctionCols.push(name.trim());
  }

  const rightJunctionCols: string[] = [];
  for (const ref of rightRefs) {
    const suggested = suggestFkColumnName(right.name, ref);
    const name = await vscode.window.showInputBox({
      title: `Junction column → ${right.name}.${ref}`,
      value: suggested,
      validateInput: (v) => {
        const t = v.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) {
          return 'Invalid name';
        }
        if (leftJunctionCols.includes(t)) {
          return 'Column name already used on junction';
        }
        return undefined;
      },
    });
    if (name === undefined) {
      return { applied: false };
    }
    rightJunctionCols.push(name.trim());
  }

  const onDelete = await pickRefAction('ON DELETE (both FKs)', 'CASCADE');
  if (onDelete === undefined) {
    return { applied: false };
  }
  const onUpdate = await pickRefAction('ON UPDATE (both FKs)', 'CASCADE');
  if (onUpdate === undefined) {
    return { applied: false };
  }

  const jName = junctionName.trim();
  const jSchema = junctionSchema.trim();
  const leftConstraint = `fk_${jName}_${left.name}`.slice(0, 64);
  const rightConstraint = `fk_${jName}_${right.name}`.slice(0, 64);

  const sql = buildNmJunctionSql({
    schema: jSchema,
    junctionName: jName,
    left: {
      columns: leftJunctionCols,
      refColumns: leftRefs,
      columnTypes: leftRefs.map((c) => leftTypes.get(c) ?? 'INT'),
      refSchema: left.schema,
      refTable: left.name,
      constraintName: leftConstraint,
      onDelete,
      onUpdate,
    },
    right: {
      columns: rightJunctionCols,
      refColumns: rightRefs,
      columnTypes: rightRefs.map((c) => rightTypes.get(c) ?? 'INT'),
      refSchema: right.schema,
      refTable: right.name,
      constraintName: rightConstraint,
      onDelete,
      onUpdate,
    },
  });

  const junctionId = `${jSchema}.${jName}`;
  const ok = await mutations.proposePreviewConfirmExecute({
    connectionId,
    title: `Create N:M junction ${junctionId}`,
    intent: 'physical-nm',
    sql,
    expectedDiffItems: [
      {
        objectType: 'table',
        objectId: junctionId,
        change: 'added',
        summary: `CREATE TABLE ${junctionId} (N:M ${left.id} ↔ ${right.id})`,
      },
    ],
  });

  if (!ok) {
    return { applied: false, mode: 'physical', sql };
  }

  return {
    applied: true,
    mode: 'physical',
    sql,
    junctionTableId: junctionId,
    edge: {
      sourceTableId: left.id,
      targetTableId: right.id,
      sourceColumns: leftRefs,
      targetColumns: rightRefs,
      cardinality: 'N:M',
      relationshipKind: 'physical',
      junctionTableId: junctionId,
      label: jName,
    },
  };
}

async function pickColumns(
  table: TableMeta,
  preferred: string[],
  title: string,
  exactCount?: number
): Promise<string[] | undefined> {
  const columns = table.columns ?? [];
  if (!columns.length) {
    void vscode.window.showWarningMessage(`No columns loaded for ${table.id}`);
    return undefined;
  }

  const preferredSet = new Set(preferred);
  const items = columns.map((c) => ({
    label: c.name,
    description: c.columnType,
    detail: columnDetail(c),
    picked: preferredSet.has(c.name),
  }));

  // Ensure preferred order appears first
  items.sort((a, b) => Number(b.picked) - Number(a.picked));

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: exactCount
      ? `Select exactly ${exactCount} column(s)`
      : 'Select column(s) — Enter to confirm',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }
  if (!picked.length) {
    void vscode.window.showWarningMessage('Select at least one column');
    return undefined;
  }
  if (exactCount !== undefined && picked.length !== exactCount) {
    void vscode.window.showWarningMessage(
      `Select exactly ${exactCount} column(s) (got ${picked.length})`
    );
    return undefined;
  }

  // Preserve preferred order when possible, else pick order
  const pickedNames = picked.map((p) => p.label);
  const ordered = preferred.filter((p) => pickedNames.includes(p));
  const rest = pickedNames.filter((n) => !ordered.includes(n));
  return [...ordered, ...rest];
}

async function pickRefAction(
  title: string,
  defaultAction: ReferentialAction
): Promise<ReferentialAction | undefined> {
  const pick = await vscode.window.showQuickPick(
    REF_ACTIONS.map((a) => ({
      label: a,
      description: a === defaultAction ? 'default' : undefined,
      action: a,
    })),
    { title, placeHolder: title }
  );
  return pick?.action;
}

function matchExistingOrSuggested(table: TableMeta, suggested: string[]): string[] {
  const names = new Set((table.columns ?? []).map((c) => c.name));
  const matched = suggested.filter((s) => names.has(s));
  if (matched.length === suggested.length) {
    return matched;
  }
  return defaultReferencedColumns(table).length
    ? defaultReferencedColumns(table).slice(0, suggested.length)
    : matched;
}

function columnDetail(c: ColumnMeta): string {
  return [
    c.isNullable ? 'NULL' : 'NOT NULL',
    c.columnKey || undefined,
    c.columnDefault !== null ? `DEFAULT ${c.columnDefault}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Re-export builders for MutationPipeline thin wrappers / tests */
export {
  buildPhysicalFkSql,
  buildNmJunctionSql,
  buildAddFkColumnsAndConstraintSql,
};
