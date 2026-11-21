import { sideAxis } from './assignHandles';
import type { HandleSide, NodeRect, RoutedEdge } from './types';

interface PortIncident {
  edgeId: string;
  /** Sort key: opposite node center along the side axis. */
  key: number;
  isSource: boolean;
}

/**
 * Order edges on each node side by opposite-node center to cut fan braiding.
 * Mutates sourcePortOffset / targetPortOffset on the provided edges.
 */
export function sortPorts(
  edges: RoutedEdge[],
  nodes: Map<string, NodeRect>,
  portGap = 14
): void {
  const byNodeSide = new Map<string, PortIncident[]>();

  const push = (nodeId: string, side: HandleSide, incident: PortIncident) => {
    const key = `${nodeId}::${side}`;
    const list = byNodeSide.get(key) ?? [];
    list.push(incident);
    byNodeSide.set(key, list);
  };

  for (const edge of edges) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) {
      continue;
    }
    const sourceOpp = sideAxis(edge.sourceSide) === 'y' ? target.y + target.height / 2 : target.x + target.width / 2;
    const targetOpp = sideAxis(edge.targetSide) === 'y' ? source.y + source.height / 2 : source.x + source.width / 2;
    push(edge.sourceId, edge.sourceSide, { edgeId: edge.id, key: sourceOpp, isSource: true });
    push(edge.targetId, edge.targetSide, { edgeId: edge.id, key: targetOpp, isSource: false });
  }

  const offsetByEdge = new Map<string, { source?: number; target?: number }>();

  for (const incidents of byNodeSide.values()) {
    incidents.sort((a, b) => a.key - b.key || a.edgeId.localeCompare(b.edgeId));
    const mid = (incidents.length - 1) / 2;
    for (let i = 0; i < incidents.length; i++) {
      const offset = (i - mid) * portGap;
      const slot = offsetByEdge.get(incidents[i].edgeId) ?? {};
      if (incidents[i].isSource) {
        slot.source = offset;
      } else {
        slot.target = offset;
      }
      offsetByEdge.set(incidents[i].edgeId, slot);
    }
  }

  for (const edge of edges) {
    const slot = offsetByEdge.get(edge.id);
    edge.sourcePortOffset = slot?.source ?? 0;
    edge.targetPortOffset = slot?.target ?? 0;
  }
}

/** Count axis-aligned segment crossings for a set of edge polylines (diagnostics / tests). */
export function countSegmentCrossings(polylines: { x: number; y: number }[][]): number {
  let crossings = 0;
  const segs: [{ x: number; y: number }, { x: number; y: number }][] = [];
  for (const poly of polylines) {
    for (let i = 0; i < poly.length - 1; i++) {
      segs.push([poly[i], poly[i + 1]]);
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segmentsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function segmentsCross(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
): boolean {
  // Only count proper H/V crossings (not shared endpoints / overlaps).
  const aHoriz = nearlyEqual(a1.y, a2.y);
  const aVert = nearlyEqual(a1.x, a2.x);
  const bHoriz = nearlyEqual(b1.y, b2.y);
  const bVert = nearlyEqual(b1.x, b2.x);
  if (aHoriz && bVert) {
    return pointInRange(b1.x, a1.x, a2.x) && pointInRange(a1.y, b1.y, b2.y) && !sharedEndpoint(a1, a2, b1, b2);
  }
  if (aVert && bHoriz) {
    return pointInRange(a1.x, b1.x, b2.x) && pointInRange(b1.y, a1.y, a2.y) && !sharedEndpoint(a1, a2, b1, b2);
  }
  return false;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.5;
}

function pointInRange(v: number, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return v > lo + 0.5 && v < hi - 0.5;
}

function sharedEndpoint(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
): boolean {
  const pts = [a1, a2];
  for (const p of pts) {
    if (
      (nearlyEqual(p.x, b1.x) && nearlyEqual(p.y, b1.y)) ||
      (nearlyEqual(p.x, b2.x) && nearlyEqual(p.y, b2.y))
    ) {
      return true;
    }
  }
  return false;
}
