import type { RoutedEdge } from './types';

/**
 * Assign lane offsets for edges that share the same unordered endpoint pair
 * (or same directed pair) so parallel FKs don't fully overlap.
 */
export function bundleParallels(
  edges: RoutedEdge[],
  options?: { bundleGap?: number; maxBundleLanes?: number }
): void {
  const bundleGap = options?.bundleGap ?? 10;
  const maxBundleLanes = options?.maxBundleLanes ?? 5;
  const groups = new Map<string, RoutedEdge[]>();

  for (const edge of edges) {
    const a = edge.sourceId < edge.targetId ? edge.sourceId : edge.targetId;
    const b = edge.sourceId < edge.targetId ? edge.targetId : edge.sourceId;
    const key = `${a}::${b}::${edge.sourceSide}->${edge.targetSide}`;
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      for (const edge of group) {
        edge.bundleLane = 0;
        edge.bundleOffset = 0;
      }
      continue;
    }
    group.sort((a, b) => a.id.localeCompare(b.id));
    const capped = Math.min(group.length, maxBundleLanes * 2 + 1);
    const mid = (capped - 1) / 2;
    for (let i = 0; i < group.length; i++) {
      const laneIndex = Math.min(i, capped - 1);
      const lane = laneIndex - mid;
      group[i].bundleLane = lane;
      group[i].bundleOffset = lane * bundleGap;
    }
  }
}
