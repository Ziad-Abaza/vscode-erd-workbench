import type { DiagramEdge, ErdDocument } from './types';

export type InferredCanvasAction = 'accept-visual' | 'promote-physical' | 'reject';

/** Find an inferred (suggestion) edge by id, or undefined. */
export function findInferredEdge(doc: ErdDocument, edgeId: string): DiagramEdge | undefined {
  const edge = doc.edges.find((e) => e.id === edgeId);
  return edge?.relationshipKind === 'inferred' ? edge : undefined;
}

/**
 * Accept suggestion as a diagram-only visual relationship (no DDL).
 * Strips the "suggested:" label prefix when present.
 */
export function applyInferredAcceptVisual(doc: ErdDocument, edgeId: string): ErdDocument {
  return {
    ...doc,
    edges: doc.edges.map((e) => {
      if (e.id !== edgeId || e.relationshipKind !== 'inferred') {
        return e;
      }
      const cleaned = e.label?.replace(/^suggested:\s*/i, '').trim();
      return {
        ...e,
        relationshipKind: 'visual' as const,
        label: cleaned || e.sourceColumns.join(', ') || undefined,
      };
    }),
    updatedAt: new Date().toISOString(),
  };
}

/** Hide / dismiss an inferred suggestion without deleting history from the document. */
export function applyInferredReject(doc: ErdDocument, edgeId: string): ErdDocument {
  return {
    ...doc,
    edges: doc.edges.map((e) =>
      e.id === edgeId && e.relationshipKind === 'inferred' ? { ...e, hidden: true } : e
    ),
    updatedAt: new Date().toISOString(),
  };
}

/** Count visible (non-hidden) inferred edges — useful for toolbar badges. */
export function countVisibleInferred(doc: ErdDocument): number {
  return doc.edges.filter((e) => e.relationshipKind === 'inferred' && !e.hidden).length;
}

/** Short human label for promote confirmation: `orders.user_id → users.id`. */
export function formatInferredMapping(edge: DiagramEdge): string {
  const src = edge.sourceColumns.join(', ') || '?';
  const tgt = edge.targetColumns.join(', ') || '?';
  const srcTable = edge.sourceTableId.split('.').pop() ?? edge.sourceTableId;
  const tgtTable = edge.targetTableId.split('.').pop() ?? edge.targetTableId;
  return `${srcTable}.${src} → ${tgtTable}.${tgt}`;
}
