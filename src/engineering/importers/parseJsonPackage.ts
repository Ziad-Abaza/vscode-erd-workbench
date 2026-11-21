import {
  ERD_FORMAT_VERSION,
  tableId,
  type CatalogSnapshot,
  type DiagramEdge,
  type ErdDocument,
  type TableMeta,
} from '../../../shared/types';
import { buildPhysicalEdges } from '../../schema/SchemaSyncService';
import type { ImportOptions, SchemaImportResult } from './types';

/**
 * Accepts:
 * - erd-workbench-package { format, catalog, diagram? }
 * - CatalogSnapshot { connectionId, tables, … }
 * - ErdDocument { erdFormatVersion, nodes, … }
 * - { tables: TableMeta[] }
 */
export function parseJsonPackage(content: string, options: ImportOptions = {}): SchemaImportResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('JSON root must be an object');
  }

  const obj = raw as Record<string, unknown>;

  // Full package
  if (obj.format === 'erd-workbench-package' || (obj.catalog && typeof obj.catalog === 'object')) {
    const catalog = (obj.catalog ?? obj) as CatalogSnapshot;
    const tables = normalizeTables(catalog.tables ?? [], warnings);
    const diagram = sanitizeDiagram(obj.diagram, options.connectionId, warnings);
    const edges =
      diagram?.edges?.length
        ? diagram.edges
        : buildPhysicalEdges(tables);
    const schemas = uniqueSchemas(tables, catalog.schemas);
    return {
      format: 'json',
      tables,
      edges,
      diagram: diagram ?? null,
      schemas,
      warnings,
      nameHint: diagram?.name ?? 'Imported package',
    };
  }

  // Bare ErdDocument
  if (obj.erdFormatVersion !== undefined) {
    const diagram = sanitizeDiagram(obj, options.connectionId, warnings);
    if (!diagram) {
      throw new Error('Unsupported or invalid ErdDocument JSON');
    }
    const tables = diagram.schemaSnapshot?.tables ?? [];
    const edges = diagram.edges?.length ? diagram.edges : buildPhysicalEdges(tables);
    return {
      format: 'json',
      tables,
      edges,
      diagram,
      schemas: diagram.schemas.length ? diagram.schemas : uniqueSchemas(tables),
      warnings,
      nameHint: diagram.name,
    };
  }

  // Catalog-like or tables array
  const tablesRaw = Array.isArray(obj.tables) ? obj.tables : Array.isArray(raw) ? raw : null;
  if (!tablesRaw) {
    throw new Error(
      'Unrecognized JSON. Expected erd-workbench-package, CatalogSnapshot, ErdDocument, or { tables: [] }'
    );
  }
  const tables = normalizeTables(tablesRaw as TableMeta[], warnings);
  const edges = buildPhysicalEdges(tables);
  return {
    format: 'json',
    tables,
    edges,
    diagram: null,
    schemas: uniqueSchemas(tables, Array.isArray(obj.schemas) ? (obj.schemas as string[]) : undefined),
    warnings,
    nameHint: 'Imported tables',
  };
}

function normalizeTables(tables: TableMeta[], warnings: string[]): TableMeta[] {
  const out: TableMeta[] = [];
  for (const t of tables) {
    if (!t || typeof t !== 'object') {
      warnings.push('Skipped non-object table entry');
      continue;
    }
    const schema = String(t.schema || 'default');
    const name = String(t.name || '');
    if (!name) {
      warnings.push('Skipped table with empty name');
      continue;
    }
    const id = t.id || tableId(schema, name);
    out.push({
      ...t,
      id,
      schema,
      name,
      kind: t.kind === 'view' ? 'view' : 'table',
      columns: t.columns ?? [],
      indexes: t.indexes ?? [],
      foreignKeys: t.foreignKeys ?? [],
      columnsHydrated: true,
    });
  }
  return out;
}

function sanitizeDiagram(
  value: unknown,
  connectionId: string | undefined,
  warnings: string[]
): ErdDocument | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const d = value as ErdDocument;
  if (d.erdFormatVersion !== ERD_FORMAT_VERSION) {
    warnings.push(
      `Diagram erdFormatVersion ${String(d.erdFormatVersion)} ≠ ${ERD_FORMAT_VERSION}; layout kept if possible`
    );
  }
  return {
    ...d,
    erdFormatVersion: ERD_FORMAT_VERSION,
    connectionId: connectionId ?? d.connectionId ?? '',
    nodes: d.nodes ?? [],
    edges: (d.edges ?? []) as DiagramEdge[],
    groups: d.groups ?? [],
    schemas: d.schemas ?? [],
    filters: d.filters ?? { showViews: true, showInferred: false },
    viewport: d.viewport ?? { x: 0, y: 0, zoom: 1 },
    updatedAt: new Date().toISOString(),
  };
}

function uniqueSchemas(tables: TableMeta[], extra?: string[]): string[] {
  const set = new Set<string>(extra ?? []);
  for (const t of tables) {
    set.add(t.schema);
  }
  return [...set].sort();
}
