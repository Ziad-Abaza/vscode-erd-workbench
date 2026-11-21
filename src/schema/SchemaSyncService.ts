import type { ErdDocument, DiagramNodeLayout, DiagramEdge, TableMeta } from '../../shared/types';
import { tableId } from '../../shared/types';
import { SchemaCatalogService } from './SchemaCatalogService';
import { SchemaDiffService } from './SchemaDiffService';

/**
 * Merges live catalog into diagram layout without resetting manual positions.
 */
export class SchemaSyncService {
  constructor(
    private readonly catalog: SchemaCatalogService,
    private readonly diff: SchemaDiffService
  ) {}

  async syncDiagram(
    doc: ErdDocument,
    options: { full: boolean }
  ): Promise<{ document: ErdDocument; message: string }> {
    const snapshot = await this.catalog.refresh(doc.connectionId, {
      full: options.full,
      schemas: doc.schemas.length ? doc.schemas : undefined,
    });

    const relevant = snapshot.tables.filter(
      (t) => !doc.schemas.length || doc.schemas.includes(t.schema)
    );
    const relevantIds = new Set(relevant.map((t) => t.id));
    const existingNodes = new Map(doc.nodes.map((n) => [n.tableId, n]));

    const nodes: DiagramNodeLayout[] = [];
    let stagingX = 0;
    let stagingY = -200;
    const gap = 280;

    for (const t of relevant) {
      const prev = existingNodes.get(t.id);
      if (prev) {
        nodes.push({ ...prev, orphaned: false });
      } else {
        nodes.push({
          tableId: t.id,
          x: stagingX,
          y: stagingY,
          pinned: false,
        });
        stagingX += gap;
        if (stagingX > gap * 8) {
          stagingX = 0;
          stagingY -= 200;
        }
      }
    }

    // Preserve orphaned (removed from DB) nodes as ghosts — never silent delete
    for (const n of doc.nodes) {
      if (!relevantIds.has(n.tableId) && !nodes.some((x) => x.tableId === n.tableId)) {
        nodes.push({ ...n, orphaned: true });
      }
    }

    const physicalEdges = buildPhysicalEdges(relevant);
    const physicalIds = new Set(physicalEdges.map((e) => e.id));
    const preserved = doc.edges.filter(
      (e) => e.relationshipKind !== 'physical' || physicalIds.has(e.id)
    );
    const mergedEdges: DiagramEdge[] = [...preserved];
    for (const e of physicalEdges) {
      if (!mergedEdges.some((x) => x.id === e.id)) {
        mergedEdges.push(e);
      } else {
        const idx = mergedEdges.findIndex((x) => x.id === e.id);
        mergedEdges[idx] = {
          ...mergedEdges[idx],
          ...e,
          relationshipKind: 'physical',
        };
      }
    }

    const next: ErdDocument = {
      ...doc,
      nodes,
      edges: mergedEdges,
      schemaSnapshot: {
        tables: relevant,
        capturedAt: snapshot.fetchedAt,
      },
      updatedAt: new Date().toISOString(),
    };

    const diff = this.diff.diffAgainstSnapshot(
      { ...doc, schemaSnapshot: doc.schemaSnapshot },
      snapshot
    );
    return {
      document: next,
      message: options.full
        ? `Full refresh complete. Diff items: ${diff.items.length}`
        : `Incremental sync complete. Diff items: ${diff.items.length}`,
    };
  }
}

export function buildPhysicalEdges(tables: TableMeta[]): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      const targetId = tableId(fk.referencedSchema, fk.referencedTable);
      const id = `fk:${t.id}:${fk.name}`;
      const cardinality = inferCardinality(t, fk.columns);
      edges.push({
        id,
        sourceTableId: t.id,
        targetTableId: targetId,
        sourceColumns: fk.columns,
        targetColumns: fk.referencedColumns,
        cardinality,
        relationshipKind: 'physical',
        constraintName: fk.name,
        label: fk.columns.join(', '),
      });
    }
  }
  return edges;
}

function inferCardinality(table: TableMeta, fkCols: string[]): '1:1' | '1:N' {
  const unique = (table.indexes ?? []).some(
    (i) =>
      i.unique &&
      i.columns.length === fkCols.length &&
      i.columns.every((c, idx) => c === fkCols[idx])
  );
  return unique ? '1:1' : '1:N';
}
