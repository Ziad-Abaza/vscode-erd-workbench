import { assignHandles } from './assignHandles';
import { bundleParallels } from './bundleParallels';
import { sortPorts } from './sortPorts';
import type { EdgeEndpoints, NodeRect, RouteEdgesOptions, RoutedEdge } from './types';

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 120;

/**
 * Full routing pipeline: handle sides → port order → parallel bundling.
 */
export function routeEdges(
  nodes: NodeRect[],
  edges: EdgeEndpoints[],
  options?: RouteEdgesOptions
): RoutedEdge[] {
  const defaultWidth = options?.defaultWidth ?? DEFAULT_WIDTH;
  const defaultHeight = options?.defaultHeight ?? DEFAULT_HEIGHT;
  const nodeMap = new Map<string, NodeRect>();
  for (const n of nodes) {
    nodeMap.set(n.id, {
      ...n,
      width: n.width || defaultWidth,
      height: n.height || defaultHeight,
    });
  }

  const routed: RoutedEdge[] = [];
  for (const edge of edges) {
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) {
      continue;
    }
    const handles = assignHandles(source, target);
    routed.push({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      ...handles,
      sourcePortOffset: 0,
      targetPortOffset: 0,
      bundleLane: 0,
      bundleOffset: 0,
    });
  }

  sortPorts(routed, nodeMap, options?.portGap ?? 14);
  bundleParallels(routed, {
    bundleGap: options?.bundleGap ?? 10,
    maxBundleLanes: options?.maxBundleLanes ?? 5,
  });
  return routed;
}
