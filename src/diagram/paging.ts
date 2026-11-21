import type { DiagramNodeLayout, ErdDocument } from '../../shared/types';

export interface PageInfo {
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  totalTables: number;
  visibleTableIds: string[];
}

export function computePageInfo(erd: ErdDocument): PageInfo {
  const ordered = filteredNodeIds(erd);
  const pageSize = erd.filters.pageMode ? Math.max(10, erd.filters.pageSize ?? 50) : ordered.length || 1;
  const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
  const pageIndex = Math.min(Math.max(0, erd.filters.pageIndex ?? 0), pageCount - 1);
  const start = pageIndex * pageSize;
  const visibleTableIds = ordered.slice(start, start + pageSize);
  return {
    pageIndex,
    pageSize,
    pageCount,
    totalTables: ordered.length,
    visibleTableIds,
  };
}

export function filteredNodeIds(erd: ErdDocument): string[] {
  const q = (erd.filters.search ?? '').trim().toLowerCase();
  const schemaFilter = erd.filters.schemas;
  const showViews = erd.filters.showViews !== false;
  const groupFilter = erd.filters.groupIds;

  return erd.nodes
    .filter((n) => {
      if (q && !n.tableId.toLowerCase().includes(q)) {
        return false;
      }
      if (schemaFilter?.length) {
        const schema = n.tableId.split('.')[0];
        if (!schemaFilter.includes(schema)) {
          return false;
        }
      }
      if (!showViews) {
        const snap = erd.schemaSnapshot?.tables.find((t) => t.id === n.tableId);
        if (snap?.kind === 'view') {
          return false;
        }
      }
      if (groupFilter?.length && (!n.groupId || !groupFilter.includes(n.groupId))) {
        return false;
      }
      return true;
    })
    .map((n) => n.tableId)
    .sort();
}

export function pageNodes(erd: ErdDocument): DiagramNodeLayout[] {
  const info = computePageInfo(erd);
  const set = new Set(info.visibleTableIds);
  if (!erd.filters.pageMode) {
    return erd.nodes;
  }
  return erd.nodes.filter((n) => set.has(n.tableId));
}
