import {
  createEmptyDiagram,
  type DiagramNodeLayout,
  type ErdDocument,
} from '../../../shared/types';
import type { SchemaImportResult } from './types';

/**
 * Turn a SchemaImportResult into a private ErdDocument (never writes into the project folder).
 */
export function buildDiagramFromImport(
  imported: SchemaImportResult,
  options: {
    connectionId?: string;
    name?: string;
    pageSize?: number;
  } = {}
): ErdDocument {
  const connectionId = options.connectionId ?? imported.diagram?.connectionId ?? '';
  const name =
    options.name ??
    imported.diagram?.name ??
    imported.nameHint ??
    `Imported ${imported.format.toUpperCase()}`;

  // Prefer embedded diagram layout when present and it still has nodes
  if (imported.diagram?.nodes?.length) {
    const doc: ErdDocument = {
      ...imported.diagram,
      name,
      connectionId,
      schemas: imported.schemas.length ? imported.schemas : imported.diagram.schemas,
      schemaSnapshot: {
        tables: imported.tables.length
          ? imported.tables
          : imported.diagram.schemaSnapshot?.tables ?? [],
        capturedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    return doc;
  }

  const doc = createEmptyDiagram(connectionId, imported.schemas, name);
  const tables = imported.tables;
  const pageSize = options.pageSize ?? 40;
  const autoPage = tables.length > pageSize;

  const nodes: DiagramNodeLayout[] = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length * 1.15)));
  const gapX = 236;
  const gapY = 132;
  tables.forEach((t, i) => {
    nodes.push({
      tableId: t.id,
      x: (i % cols) * gapX,
      y: Math.floor(i / cols) * gapY,
      pinned: false,
    });
  });

  if (autoPage) {
    const firstPage = nodes.slice(0, pageSize);
    const pCols = Math.max(1, Math.ceil(Math.sqrt(firstPage.length * 1.1)));
    firstPage.forEach((n, i) => {
      n.x = (i % pCols) * 220;
      n.y = Math.floor(i / pCols) * 118;
    });
  }

  doc.nodes = nodes;
  doc.edges = imported.edges;
  doc.schemaSnapshot = {
    tables,
    capturedAt: new Date().toISOString(),
  };
  doc.filters = {
    ...doc.filters,
    schemas: imported.schemas,
    showViews: true,
    showInferred: false,
    pageMode: autoPage,
    pageIndex: 0,
    pageSize,
  };
  return doc;
}
