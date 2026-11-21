import * as vscode from 'vscode';
import {
  createEmptyDiagram,
  type ErdDocument,
  type DiagramNodeLayout,
  type DiagramEdge,
} from '../../shared/types';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { buildPhysicalEdges } from '../schema/SchemaSyncService';
import { suggestInferredRelationships } from './InferredRelationships';

export class ReverseEngineerService {
  constructor(private readonly catalog: SchemaCatalogService) {}

  async reverseEngineer(
    connectionId: string,
    schemas: string[],
    options?: { includeInferred?: boolean }
  ): Promise<ErdDocument> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Reverse engineering schema…',
        cancellable: false,
      },
      async () => {
        await this.catalog.refresh(connectionId, { full: true, schemas });
      }
    );

    const cat = this.catalog.getCatalog(connectionId);
    if (!cat) {
      throw new Error('Catalog refresh failed');
    }
    const tables = cat.tables.filter((t) => schemas.includes(t.schema));
    const doc = createEmptyDiagram(
      connectionId,
      schemas,
      `ERD ${schemas.join(',') || 'all'} ${new Date().toISOString().slice(0, 10)}`
    );

    const nodes: DiagramNodeLayout[] = [];
    // Denser initial grid — less empty canvas for medium/large schemas
    const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length * 1.15)));
    const gapX = 236;
    const gapY = 132;
    tables.forEach((t, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      nodes.push({
        tableId: t.id,
        x: col * gapX,
        y: row * gapY,
        pinned: false,
      });
    });

    let edges: DiagramEdge[] = buildPhysicalEdges(tables);
    const includeInferred =
      options?.includeInferred ??
      vscode.workspace.getConfiguration('erdWorkbench').get<boolean>('inferredRelationships', false);
    if (includeInferred) {
      edges = [...edges, ...suggestInferredRelationships(tables, edges)];
    }

    doc.nodes = nodes;
    doc.edges = edges;
    doc.schemaSnapshot = {
      tables,
      capturedAt: cat.fetchedAt,
    };
    doc.filters = {
      ...doc.filters,
      schemas,
      showInferred: includeInferred,
      showViews: true,
    };
    return doc;
  }
}
