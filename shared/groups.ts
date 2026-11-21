import type { DiagramEdge, DiagramGroup, DiagramNodeLayout, ErdDocument } from './types';

/** Stable prefix for collapsed group proxy nodes on the canvas / edge remapping. */
export const GROUP_NODE_PREFIX = 'group:';

const GROUP_COLORS = [
  '#3d5a80',
  '#4a6fa5',
  '#5c4d7a',
  '#2d6a4f',
  '#7f5539',
  '#495057',
  '#6b4f3a',
  '#3a5a40',
];

export function groupNodeId(groupId: string): string {
  return `${GROUP_NODE_PREFIX}${groupId}`;
}

export function parseGroupNodeId(nodeId: string): string | undefined {
  return nodeId.startsWith(GROUP_NODE_PREFIX) ? nodeId.slice(GROUP_NODE_PREFIX.length) : undefined;
}

export function newGroupId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function pickGroupColor(existing: DiagramGroup[]): string {
  const used = new Set(existing.map((g) => g.color).filter(Boolean));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[existing.length % GROUP_COLORS.length];
}

export function groupMembers(doc: ErdDocument, groupId: string): DiagramNodeLayout[] {
  return doc.nodes.filter((n) => n.groupId === groupId);
}

export function computeGroupBounds(
  members: DiagramNodeLayout[],
  padding = 28
): { x: number; y: number; width: number; height: number } | null {
  if (!members.length) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of members) {
    const w = n.width ?? 220;
    const h = n.height ?? 120;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  // Extra top space for swimlane header
  const header = 36;
  return {
    x: minX - padding,
    y: minY - padding - header,
    width: Math.max(160, maxX - minX + padding * 2),
    height: Math.max(72, maxY - minY + padding * 2 + header),
  };
}

/** Snapshot bounds onto the group record (used when collapsing / swimlane layout). */
export function withUpdatedGroupBounds(doc: ErdDocument, groupId: string): ErdDocument {
  const members = groupMembers(doc, groupId);
  const bounds = computeGroupBounds(members);
  if (!bounds) {
    return doc;
  }
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, ...bounds } : g)),
    updatedAt: new Date().toISOString(),
  };
}

export function createGroup(
  doc: ErdDocument,
  name: string,
  tableIds: string[],
  color?: string
): ErdDocument {
  const idSet = new Set(tableIds);
  if (!idSet.size) {
    return doc;
  }
  const group: DiagramGroup = {
    id: newGroupId(),
    name: name.trim() || 'Group',
    collapsed: false,
    color: color ?? pickGroupColor(doc.groups),
  };
  const nodes = doc.nodes.map((n) => (idSet.has(n.tableId) ? { ...n, groupId: group.id } : n));
  const next: ErdDocument = {
    ...doc,
    groups: [...doc.groups, group],
    nodes,
    updatedAt: new Date().toISOString(),
  };
  return withUpdatedGroupBounds(next, group.id);
}

export function renameGroup(doc: ErdDocument, groupId: string, name: string): ErdDocument {
  const trimmed = name.trim();
  if (!trimmed) {
    return doc;
  }
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
    updatedAt: new Date().toISOString(),
  };
}

export function dissolveGroup(doc: ErdDocument, groupId: string): ErdDocument {
  return {
    ...doc,
    groups: doc.groups.filter((g) => g.id !== groupId),
    nodes: doc.nodes.map((n) =>
      n.groupId === groupId ? { ...n, groupId: undefined } : n
    ),
    filters: {
      ...doc.filters,
      groupIds: doc.filters.groupIds?.filter((id) => id !== groupId),
    },
    updatedAt: new Date().toISOString(),
  };
}

export function toggleGroupCollapsed(doc: ErdDocument, groupId: string): ErdDocument {
  const group = doc.groups.find((g) => g.id === groupId);
  if (!group) {
    return doc;
  }
  if (!group.collapsed) {
    // Snapshot bounds before hiding members
    const withBounds = withUpdatedGroupBounds(doc, groupId);
    return {
      ...withBounds,
      groups: withBounds.groups.map((g) =>
        g.id === groupId ? { ...g, collapsed: true } : g
      ),
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g)),
    updatedAt: new Date().toISOString(),
  };
}

export function setAllGroupsCollapsed(doc: ErdDocument, collapsed: boolean): ErdDocument {
  let next = doc;
  for (const g of doc.groups) {
    if (g.collapsed === collapsed) {
      continue;
    }
    if (collapsed) {
      next = withUpdatedGroupBounds(next, g.id);
    }
  }
  return {
    ...next,
    groups: next.groups.map((g) => ({ ...g, collapsed })),
    updatedAt: new Date().toISOString(),
  };
}

export function moveCollapsedGroup(
  doc: ErdDocument,
  groupId: string,
  x: number,
  y: number
): ErdDocument {
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, x, y } : g)),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Create / refresh one swimlane group per schema.
 * Manual groups (non `grp_schema_*`) are kept but their members may be reassigned.
 */
export function autoGroupBySchema(doc: ErdDocument): ErdDocument {
  const schemas = [
    ...new Set(doc.nodes.map((n) => n.tableId.split('.')[0] || 'default')),
  ].sort();

  const manualGroups = doc.groups.filter((g) => !g.id.startsWith('grp_schema_'));
  const schemaGroups: DiagramGroup[] = schemas.map((schema, i) => {
    const existing = doc.groups.find((g) => g.id === `grp_schema_${schema}`);
    return (
      existing ?? {
        id: `grp_schema_${schema}`,
        name: schema,
        collapsed: false,
        color: GROUP_COLORS[i % GROUP_COLORS.length],
      }
    );
  });
  const bySchema = new Map(schemaGroups.map((g) => [g.name, g.id]));

  let next: ErdDocument = {
    ...doc,
    groups: [...manualGroups, ...schemaGroups],
    nodes: doc.nodes.map((n) => {
      const schema = n.tableId.split('.')[0] || 'default';
      return { ...n, groupId: bySchema.get(schema) };
    }),
    updatedAt: new Date().toISOString(),
  };

  for (const g of schemaGroups) {
    next = withUpdatedGroupBounds(next, g.id);
  }
  return next;
}

/**
 * Stack groups as horizontal swimlanes (top → bottom). Ungrouped tables go last.
 */
export function layoutSwimlanes(
  doc: ErdDocument,
  opts?: { laneGap?: number; padding?: number; colGap?: number; rowGap?: number }
): ErdDocument {
  const laneGap = opts?.laneGap ?? 48;
  const padding = opts?.padding ?? 28;
  const colGap = opts?.colGap ?? 36;
  const rowGap = opts?.rowGap ?? 28;
  const cellW = 220;
  const cellH = 120;

  const groups = [...doc.groups].sort((a, b) => a.name.localeCompare(b.name));
  const ungrouped = doc.nodes.filter((n) => !n.groupId);

  let cursorY = 0;
  const pos = new Map<string, { x: number; y: number }>();
  const groupBoxes = new Map<string, DiagramGroup>();

  const placeBand = (members: DiagramNodeLayout[], titleRows = 1) => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(members.length, 1) * 1.2)));
    const header = 36 * titleRows;
    for (let i = 0; i < members.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      pos.set(members[i].tableId, {
        x: padding + col * (cellW + colGap),
        y: cursorY + header + padding + row * (cellH + rowGap),
      });
    }
    const rows = Math.max(1, Math.ceil(members.length / cols));
    const width = padding * 2 + cols * cellW + Math.max(0, cols - 1) * colGap;
    const height = header + padding * 2 + rows * cellH + Math.max(0, rows - 1) * rowGap;
    const box = { x: 0, y: cursorY, width, height };
    cursorY += height + laneGap;
    return box;
  };

  for (const g of groups) {
    const members = groupMembers(doc, g.id);
    if (!members.length) {
      groupBoxes.set(g.id, { ...g });
      continue;
    }
    const box = placeBand(members);
    groupBoxes.set(g.id, { ...g, ...box, collapsed: g.collapsed });
  }

  if (ungrouped.length) {
    placeBand(ungrouped, 0);
  }

  return {
    ...doc,
    groups: doc.groups.map((g) => groupBoxes.get(g.id) ?? g),
    nodes: doc.nodes.map((n) => {
      const p = pos.get(n.tableId);
      return p ? { ...n, x: p.x, y: p.y } : n;
    }),
    updatedAt: new Date().toISOString(),
  };
}

/** Tables hidden because their swimlane group is collapsed. */
export function isHiddenByCollapsedGroup(doc: ErdDocument, tableId: string): boolean {
  const node = doc.nodes.find((n) => n.tableId === tableId);
  if (!node?.groupId) {
    return false;
  }
  const group = doc.groups.find((g) => g.id === node.groupId);
  return Boolean(group?.collapsed);
}

/**
 * Resolve a table endpoint to either the table id or a collapsed group proxy node.
 * Returns hide=true when both ends collapse into the same group (internal edge).
 */
export function resolveEdgeEndpoint(
  doc: ErdDocument,
  tableId: string
): { endpointId: string; viaGroupId?: string } {
  const node = doc.nodes.find((n) => n.tableId === tableId);
  if (!node?.groupId) {
    return { endpointId: tableId };
  }
  const group = doc.groups.find((g) => g.id === node.groupId);
  if (group?.collapsed) {
    return { endpointId: groupNodeId(group.id), viaGroupId: group.id };
  }
  return { endpointId: tableId };
}

export function remapEdgeForCollapse(
  doc: ErdDocument,
  edge: DiagramEdge
): { sourceId: string; targetId: string; hide: boolean } {
  const src = resolveEdgeEndpoint(doc, edge.sourceTableId);
  const tgt = resolveEdgeEndpoint(doc, edge.targetTableId);
  const hide =
    Boolean(src.viaGroupId && tgt.viaGroupId && src.viaGroupId === tgt.viaGroupId) ||
    src.endpointId === tgt.endpointId;
  return { sourceId: src.endpointId, targetId: tgt.endpointId, hide };
}

export function collapsedGroupDisplay(
  group: DiagramGroup,
  memberCount: number
): { x: number; y: number; width: number; height: number; label: string } {
  return {
    x: group.x ?? 0,
    y: group.y ?? 0,
    width: Math.max(180, group.width ? Math.min(group.width, 280) : 220),
    height: 56,
    label: `${group.name} · ${memberCount}`,
  };
}
