import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { DiagramEdge, DiagramNodeLayout } from '../../shared/types';

const elk = new ELK();

/**
 * Auto-layout a filtered subgraph only. Cap enforced by caller.
 */
export async function layoutSubgraph(
  nodes: DiagramNodeLayout[],
  edges: DiagramEdge[],
  options?: { direction?: 'RIGHT' | 'DOWN' }
): Promise<DiagramNodeLayout[]> {
  const pinned = new Set(nodes.filter((n) => n.pinned).map((n) => n.tableId));
  const movable = nodes.filter((n) => !n.pinned);
  if (!movable.length) {
    return nodes;
  }

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': options?.direction ?? 'RIGHT',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: movable.map((n) => ({
      id: n.tableId,
      width: n.width ?? 220,
      height: n.height ?? 120,
    })),
    edges: edges
      .filter(
        (e) =>
          movable.some((n) => n.tableId === e.sourceTableId) &&
          movable.some((n) => n.tableId === e.targetTableId)
      )
      .map((e) => ({
        id: e.id,
        sources: [e.sourceTableId],
        targets: [e.targetTableId],
      })),
  };

  const result = await elk.layout(graph);
  const positioned = new Map<string, DiagramNodeLayout>();
  for (const n of nodes) {
    positioned.set(n.tableId, { ...n });
  }
  for (const child of result.children ?? []) {
    if (pinned.has(child.id)) {
      continue;
    }
    const prev = positioned.get(child.id);
    if (prev) {
      positioned.set(child.id, {
        ...prev,
        x: child.x ?? prev.x,
        y: child.y ?? prev.y,
      });
    }
  }
  return [...positioned.values()];
}
