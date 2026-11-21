import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnNodesChange,
  type ReactFlowInstance,
  applyNodeChanges,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import type {
  CatalogTableSummary,
  ErdDocument,
  HostToWebviewMessage,
} from '../../shared/types';
import { routeEdges } from '../../shared/routing';
import {
  applyInferredAcceptVisual,
  applyInferredReject,
  countVisibleInferred,
} from '../../shared/inferredActions';
import {
  autoGroupBySchema,
  collapsedGroupDisplay,
  computeGroupBounds,
  createGroup,
  dissolveGroup,
  groupMembers,
  groupNodeId,
  isHiddenByCollapsedGroup,
  layoutSwimlanes,
  moveCollapsedGroup,
  parseGroupNodeId,
  remapEdgeForCollapse,
  renameGroup,
  setAllGroupsCollapsed,
  toggleGroupCollapsed,
} from '../../shared/groups';
import { post } from './vscodeApi';
import { TableNode, type LodLevel, type TableNodeData } from './nodes/TableNode';
import { GroupNode, type GroupNodeData } from './nodes/GroupNode';
import { OrthogonalEdge, type InferredEdgeAction } from './edges/OrthogonalEdge';

const nodeTypes = { tableNode: TableNode, groupNode: GroupNode };
const edgeTypes = { orthogonal: OrthogonalEdge };

const VIEWPORT_MARGIN = 280;
const MAX_MOUNTED = 80;
/** Above this, force paging so the canvas stays on-screen */
const AUTO_PAGE_THRESHOLD = 48;
const DEFAULT_PAGE_SIZE = 40;

export function App() {
  const [document, setDocument] = useState<ErdDocument | null>(null);
  const [catalog, setCatalog] = useState<CatalogTableSummary[]>([]);
  const [hydrated, setHydrated] = useState<Record<string, CatalogTableSummary & { columns?: import('../../shared/types').ColumnMeta[] }>>({});
  const [search, setSearch] = useState('');
  const [hideUnconnected, setHideUnconnected] = useState(false);
  const [showInferred, setShowInferred] = useState(false);
  const [showViews, setShowViews] = useState(true);
  const [lod, setLod] = useState<LodLevel>('mid');
  const [viewport, setViewport] = useState({ x: 0, y: 0, zoom: 1, width: 1200, height: 800 });
  const [status, setStatus] = useState('Loading…');
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docRef = useRef<ErdDocument | null>(null);
  const hydrateRequested = useRef<Set<string>>(new Set());
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const autoPagedRef = useRef(false);
  const inferredActionRef = useRef<(edgeId: string, action: InferredEdgeAction) => void>(() => {});
  const groupActionRef = useRef<{
    toggle: (groupId: string) => void;
    rename: (groupId: string) => void;
    dissolve: (groupId: string) => void;
  }>({ toggle: () => {}, rename: () => {}, dissolve: () => {} });

  const fitCanvas = useCallback((padding = 0.14) => {
    requestAnimationFrame(() => {
      rfRef.current?.fitView({ padding, maxZoom: 1, duration: 220 });
    });
  }, []);

  useEffect(() => {
    docRef.current = document;
  }, [document]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || !('type' in msg)) {
        return;
      }
      switch (msg.type) {
        case 'init':
        case 'documentChanged': {
          let doc = msg.document;
          // Force paging for large diagrams so content fits the screen
          if (doc.nodes.length > AUTO_PAGE_THRESHOLD && !doc.filters.pageMode) {
            doc = {
              ...doc,
              filters: {
                ...doc.filters,
                pageMode: true,
                pageIndex: doc.filters.pageIndex ?? 0,
                pageSize: doc.filters.pageSize ?? DEFAULT_PAGE_SIZE,
              },
              updatedAt: new Date().toISOString(),
            };
            if (!autoPagedRef.current) {
              autoPagedRef.current = true;
              post({ type: 'updateDocument', document: doc, reason: 'auto-page-large-schema' });
            }
          }
          setDocument(doc);
          setSearch(doc.filters.search ?? '');
          setHideUnconnected(Boolean(doc.filters.hideUnconnected));
          setShowInferred(Boolean(doc.filters.showInferred));
          setShowViews(doc.filters.showViews !== false);
          if (msg.type === 'init') {
            setCatalog(msg.catalogSummary);
            fitCanvas(0.12);
          }
          break;
        }
        case 'layoutResult': {
          fitCanvas(0.12);
          break;
        }
        case 'hydrateColumns': {
          setHydrated((prev) => ({
            ...prev,
            [msg.tableId]: {
              ...(prev[msg.tableId] ?? {
                id: msg.tableId,
                schema: msg.tableId.split('.')[0],
                name: msg.tableId.split('.').slice(1).join('.'),
                kind: 'table' as const,
                pkCols: [],
                fkCount: msg.foreignKeys.length,
                columnCount: msg.columns.length,
              }),
              columns: msg.columns,
              columnCount: msg.columns.length,
              fkCount: msg.foreignKeys.length,
              pkCols: msg.columns.filter((c) => c.columnKey === 'PRI').map((c) => c.name),
            },
          }));
          break;
        }
        case 'catalogPatch': {
          setCatalog((prev) => {
            const removed = new Set(msg.patch.tablesRemoved);
            const changed = new Map(msg.patch.tablesChanged.map((t) => [t.id, t]));
            const next = prev
              .filter((t) => !removed.has(t.id))
              .map((t) => changed.get(t.id) ?? t);
            const existing = new Set(next.map((t) => t.id));
            for (const t of msg.patch.tablesAdded) {
              if (!existing.has(t.id)) {
                next.push(t);
              }
            }
            return next;
          });
          break;
        }
        case 'error':
          setStatus(`Error: ${msg.message}`);
          break;
        default:
          break;
      }
    };
    window.addEventListener('message', handler);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [fitCanvas]);

  const catalogIndex = useMemo(() => {
    const map = new Map<string, CatalogTableSummary>();
    for (const t of catalog) {
      map.set(t.id, t);
    }
    return map;
  }, [catalog]);

  const pageInfo = useMemo(() => {
    if (!document) {
      return { pageIndex: 0, pageSize: 50, pageCount: 1, total: 0 };
    }
    const q = search.trim().toLowerCase();
    const ordered = document.nodes
      .filter((n) => {
        const summary = catalogIndex.get(n.tableId);
        if (!showViews && summary?.kind === 'view') {
          return false;
        }
        if (q && !n.tableId.toLowerCase().includes(q)) {
          return false;
        }
        return true;
      })
      .map((n) => n.tableId)
      .sort();
    const forcePages = ordered.length > AUTO_PAGE_THRESHOLD;
    const pageMode = Boolean(document.filters.pageMode) || forcePages;
    const pageSize = pageMode
      ? Math.max(10, document.filters.pageSize ?? DEFAULT_PAGE_SIZE)
      : ordered.length || 1;
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
    const pageIndex = Math.min(Math.max(0, document.filters.pageIndex ?? 0), pageCount - 1);
    return { pageIndex, pageSize, pageCount, total: ordered.length, ordered, pageMode, forcePages };
  }, [document, search, showViews, catalogIndex]);

  const filteredTableIds = useMemo(() => {
    if (!document) {
      return new Set<string>();
    }
    const q = search.trim().toLowerCase();
    const connected = new Set<string>();
    for (const e of document.edges) {
      if (e.hidden) {
        continue;
      }
      if (e.relationshipKind === 'inferred' && !showInferred) {
        continue;
      }
      connected.add(e.sourceTableId);
      connected.add(e.targetTableId);
    }

    let ids = document.nodes
      .filter((n) => {
        const summary = catalogIndex.get(n.tableId);
        const kind = summary?.kind ?? 'table';
        if (!showViews && kind === 'view') {
          return false;
        }
        if (q && !n.tableId.toLowerCase().includes(q)) {
          return false;
        }
        if (hideUnconnected && !connected.has(n.tableId) && !n.orphaned) {
          return false;
        }
        return true;
      })
      .map((n) => n.tableId);

    // Always page large sets — never paint 100+ tables off-screen at once
    if (pageInfo.pageMode) {
      const start = pageInfo.pageIndex * pageInfo.pageSize;
      const pageSet = new Set((pageInfo.ordered ?? ids).slice(start, start + pageInfo.pageSize));
      ids = ids.filter((id) => pageSet.has(id));
    }

    return new Set(ids);
  }, [document, search, hideUnconnected, showInferred, showViews, catalogIndex, pageInfo]);

  // Refit when page changes
  useEffect(() => {
    if (!document) {
      return;
    }
    fitCanvas(0.12);
  }, [document?.filters.pageIndex, document?.filters.pageMode, document?.filters.pageSize, fitCanvas]);

  // Build visible nodes with viewport culling
  useEffect(() => {
    if (!document) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const zoom = viewport.zoom || 1;
    const nextLod: LodLevel = zoom < 0.45 ? 'far' : zoom < 0.85 ? 'mid' : 'near';
    setLod(nextLod);

    const worldLeft = (-viewport.x) / zoom - VIEWPORT_MARGIN;
    const worldTop = (-viewport.y) / zoom - VIEWPORT_MARGIN;
    const worldRight = worldLeft + viewport.width / zoom + VIEWPORT_MARGIN * 2;
    const worldBottom = worldTop + viewport.height / zoom + VIEWPORT_MARGIN * 2;

    // Tables whose swimlane is collapsed are represented by a group proxy card
    const candidates = document.nodes.filter(
      (n) => filteredTableIds.has(n.tableId) && !isHiddenByCollapsedGroup(document, n.tableId)
    );
    const inView = candidates.filter((n) => {
      const w = n.width ?? 220;
      const h = n.height ?? 120;
      return n.x + w >= worldLeft && n.x <= worldRight && n.y + h >= worldTop && n.y <= worldBottom;
    });

    // Prefer in-view; if too many, take first MAX_MOUNTED by proximity to center
    let mount = inView;
    if (mount.length > MAX_MOUNTED) {
      const cx = (worldLeft + worldRight) / 2;
      const cy = (worldTop + worldBottom) / 2;
      mount = [...mount]
        .sort((a, b) => {
          const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
          const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
          return da - db;
        })
        .slice(0, MAX_MOUNTED);
    }

    const mountIds = new Set(mount.map((n) => n.tableId));

    const rfNodes: Node[] = mount.map((n) => {
      const summary = catalogIndex.get(n.tableId);
      const hyd = hydrated[n.tableId];
      const pkCols = hyd?.pkCols ?? summary?.pkCols ?? [];
      const data: TableNodeData = {
        tableId: n.tableId,
        schema: summary?.schema ?? n.tableId.split('.')[0],
        name: summary?.name ?? n.tableId.split('.').slice(1).join('.'),
        kind: summary?.kind ?? 'table',
        orphaned: n.orphaned,
        pkCols,
        fkCols: [],
        columns: hyd?.columns,
        lod: nextLod,
        columnCount: summary?.columnCount ?? hyd?.columns?.length ?? 0,
      };
      return {
        id: n.tableId,
        type: 'tableNode',
        position: { x: n.x, y: n.y },
        data,
        selected: false,
        zIndex: 2,
      };
    });

    // Swimlane frames (expanded) + collapsed proxy cards
    const relevantGroups = document.groups.filter((g) => {
      const members = groupMembers(document, g.id);
      return members.some((m) => filteredTableIds.has(m.tableId));
    });

    for (const g of relevantGroups) {
      const members = groupMembers(document, g.id);
      const memberCount = members.length;
      if (g.collapsed) {
        const display = collapsedGroupDisplay(g, memberCount);
        const data: GroupNodeData = {
          groupId: g.id,
          name: g.name,
          color: g.color ?? '#3d5a80',
          memberCount,
          collapsed: true,
          width: display.width,
          height: display.height,
          onToggle: (id) => groupActionRef.current.toggle(id),
          onRename: (id) => groupActionRef.current.rename(id),
          onDissolve: (id) => groupActionRef.current.dissolve(id),
        };
        rfNodes.push({
          id: groupNodeId(g.id),
          type: 'groupNode',
          position: { x: display.x, y: display.y },
          data,
          selectable: true,
          draggable: true,
          connectable: false,
          zIndex: 3,
        });
        mountIds.add(groupNodeId(g.id));
      } else {
        // Only draw frame when at least one member is mounted (or any member in filter)
        const mountedMembers = members.filter((m) => mountIds.has(m.tableId));
        if (!mountedMembers.length && !members.some((m) => filteredTableIds.has(m.tableId))) {
          continue;
        }
        const bounds =
          computeGroupBounds(mountedMembers.length ? mountedMembers : members) ??
          computeGroupBounds(members);
        if (!bounds) {
          continue;
        }
        const data: GroupNodeData = {
          groupId: g.id,
          name: g.name,
          color: g.color ?? '#3d5a80',
          memberCount,
          collapsed: false,
          width: bounds.width,
          height: bounds.height,
          onToggle: (id) => groupActionRef.current.toggle(id),
          onRename: (id) => groupActionRef.current.rename(id),
          onDissolve: (id) => groupActionRef.current.dissolve(id),
        };
        rfNodes.unshift({
          id: groupNodeId(g.id),
          type: 'groupNode',
          position: { x: bounds.x, y: bounds.y },
          data,
          selectable: false,
          draggable: false,
          connectable: false,
          zIndex: 0,
        });
      }
    }

    const remapped = document.edges
      .filter((e) => {
        if (e.hidden) {
          return false;
        }
        if (e.relationshipKind === 'inferred' && !showInferred) {
          return false;
        }
        return true;
      })
      .map((e) => {
        const mapped = remapEdgeForCollapse(document, e);
        return { edge: e, ...mapped };
      })
      .filter((m) => !m.hide && mountIds.has(m.sourceId) && mountIds.has(m.targetId));

    const routeNodes = [
      ...mount.map((n) => ({
        id: n.tableId,
        x: n.x,
        y: n.y,
        width: n.width ?? 220,
        height: n.height ?? 120,
      })),
      ...relevantGroups
        .filter((g) => g.collapsed)
        .map((g) => {
          const display = collapsedGroupDisplay(g, groupMembers(document, g.id).length);
          return {
            id: groupNodeId(g.id),
            x: display.x,
            y: display.y,
            width: display.width,
            height: display.height,
          };
        }),
    ];

    const routed = routeEdges(
      routeNodes,
      remapped.map((m) => ({
        id: m.edge.id,
        sourceId: m.sourceId,
        targetId: m.targetId,
      }))
    );
    const routeById = new Map(routed.map((r) => [r.id, r]));

    const rfEdges: Edge[] = remapped.map((m) => {
      const e = m.edge;
      const route = routeById.get(e.id);
      const isInferred = e.relationshipKind === 'inferred';
      return {
        id: e.id,
        source: m.sourceId,
        target: m.targetId,
        sourceHandle: route?.sourceHandle ?? 's-right',
        targetHandle: route?.targetHandle ?? 't-left',
        type: 'orthogonal',
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: isInferred
            ? '#c586c0'
            : e.relationshipKind === 'visual'
              ? '#8aa4c8'
              : '#6fbf95',
        },
        data: {
          relationshipKind: e.relationshipKind,
          label: e.label,
          cardinality: e.cardinality,
          sourceSide: route?.sourceSide,
          targetSide: route?.targetSide,
          sourcePortOffset: route?.sourcePortOffset ?? 0,
          targetPortOffset: route?.targetPortOffset ?? 0,
          bundleLane: route?.bundleLane ?? 0,
          bundleOffset: route?.bundleOffset ?? 0,
          ...(isInferred
            ? {
                onInferredAction: (action: InferredEdgeAction) =>
                  inferredActionRef.current(e.id, action),
              }
            : {}),
        },
        selectable: true,
      };
    });

    setNodes(rfNodes);
    setEdges(rfEdges);
    const groupNote = document.groups.length
      ? ` · ${document.groups.filter((g) => g.collapsed).length}/${document.groups.length} groups collapsed`
      : '';
    setStatus(
      `${mount.length} tables · ${filteredTableIds.size} filtered · ${document.nodes.length} total${groupNote}`
    );

    // Auto-hydrate columns for visible tables (don't wait for hover)
    if (nextLod !== 'far') {
      for (const n of mount) {
        if (!hydrated[n.tableId]?.columns && !hydrateRequested.current.has(n.tableId)) {
          hydrateRequested.current.add(n.tableId);
          post({ type: 'requestHydrate', tableId: n.tableId });
        }
      }
    }
  }, [document, filteredTableIds, viewport, catalogIndex, hydrated, showInferred, setNodes, setEdges]);

  const scheduleSave = useCallback((next: ErdDocument) => {
    setDocument(next);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => {
      post({ type: 'updateDocument', document: next, reason: 'layout' });
    }, 80);
  }, []);

  const onNodesChange: OnNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
      const doc = docRef.current;
      if (!doc) {
        return;
      }
      const posChanges = changes.filter(
        (c): c is NodeChange & { type: 'position'; id: string; position: { x: number; y: number } } =>
          c.type === 'position' && 'position' in c && Boolean((c as { position?: unknown }).position)
      );
      if (!posChanges.length) {
        return;
      }

      let next = doc;
      const tablePos = new Map<string, { x: number; y: number }>();
      for (const c of posChanges) {
        const gid = parseGroupNodeId(c.id);
        if (gid) {
          next = moveCollapsedGroup(next, gid, c.position.x, c.position.y);
        } else {
          tablePos.set(c.id, c.position);
        }
      }
      if (tablePos.size) {
        next = {
          ...next,
          nodes: next.nodes.map((n) => {
            const p = tablePos.get(n.tableId);
            return p ? { ...n, x: p.x, y: p.y } : n;
          }),
          updatedAt: new Date().toISOString(),
        };
      }

      const dragging = changes.some((c) => c.type === 'position' && (c as { dragging?: boolean }).dragging);
      docRef.current = next;
      if (!dragging) {
        scheduleSave(next);
      } else {
        setDocument(next);
      }
    },
    [setNodes, scheduleSave]
  );

  const onNodeMouseEnter = useCallback((_: MouseEvent, node: Node) => {
    if (!hydrated[node.id]?.columns && !hydrateRequested.current.has(node.id)) {
      hydrateRequested.current.add(node.id);
      post({ type: 'requestHydrate', tableId: node.id });
    }
  }, [hydrated]);

  const autoLayout = () => {
    const selected = nodes.filter((n) => n.selected).map((n) => n.id);
    // Layout only what's on screen (selection or current page)
    const ids = selected.length ? selected : [...filteredTableIds];
    post({ type: 'requestAutoLayout', tableIds: ids });
  };

  const compactLayout = () => {
    const ids = [...filteredTableIds];
    const doc = docRef.current;
    if (!doc || !ids.length) {
      return;
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length * 1.1)));
    const gapX = 220;
    const gapY = 118;
    const map = new Map(ids.map((id, i) => [id, { x: (i % cols) * gapX, y: Math.floor(i / cols) * gapY }]));
    const nextNodes = doc.nodes.map((n) => {
      const p = map.get(n.tableId);
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
    const next = { ...doc, nodes: nextNodes, updatedAt: new Date().toISOString() };
    scheduleSave(next);
    fitCanvas(0.1);
  };

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }
    if (connection.source === connection.target) {
      setStatus('Cannot connect a table to itself');
      return;
    }
    // Host RelationshipWizard: pick mode, cardinality, FK columns (physical → SQL preview)
    post({
      type: 'createRelationship',
      sourceTableId: connection.source,
      targetTableId: connection.target,
    });
    setStatus(`Relationship wizard: ${connection.source} → ${connection.target}`);
  }, []);

  /** Canvas Accept / Promote / Reject on inferred edges → host proposeInferredAction */
  inferredActionRef.current = (edgeId, action) => {
    const doc = docRef.current;
    if (!doc) {
      return;
    }
    // Optimistic local update for accept/reject; promote waits on host wizard + DDL
    if (action === 'accept-visual') {
      const next = applyInferredAcceptVisual(doc, edgeId);
      docRef.current = next;
      setDocument(next);
      setStatus(`Accepted inferred as visual · ${edgeId}`);
    } else if (action === 'reject') {
      const next = applyInferredReject(doc, edgeId);
      docRef.current = next;
      setDocument(next);
      setStatus(`Dismissed inferred suggestion · ${edgeId}`);
    } else {
      setStatus(`Promote inferred → physical… · ${edgeId}`);
    }
    post({ type: 'proposeInferredAction', edgeId, action });
  };

  groupActionRef.current = {
    toggle: (groupId) => {
      const doc = docRef.current;
      if (!doc) {
        return;
      }
      scheduleSave(toggleGroupCollapsed(doc, groupId));
    },
    rename: (groupId) => {
      const doc = docRef.current;
      if (!doc) {
        return;
      }
      const current = doc.groups.find((g) => g.id === groupId);
      const name = window.prompt('Group name', current?.name ?? 'Group');
      if (name === null) {
        return;
      }
      scheduleSave(renameGroup(doc, groupId, name));
    },
    dissolve: (groupId) => {
      const doc = docRef.current;
      if (!doc) {
        return;
      }
      const current = doc.groups.find((g) => g.id === groupId);
      if (!window.confirm(`Dissolve group “${current?.name ?? groupId}”? Tables stay on the canvas.`)) {
        return;
      }
      scheduleSave(dissolveGroup(doc, groupId));
    },
  };

  const inferredCount = document ? countVisibleInferred(document) : 0;

  const groupSelectedTables = () => {
    const doc = docRef.current;
    if (!doc) {
      return;
    }
    const selected = nodes.filter((n) => n.selected && n.type === 'tableNode').map((n) => n.id);
    if (selected.length < 1) {
      setStatus('Select one or more tables to group');
      return;
    }
    const name = window.prompt('Group / swimlane name', 'Group');
    if (name === null) {
      return;
    }
    scheduleSave(createGroup(doc, name, selected));
    setStatus(`Grouped ${selected.length} table(s)`);
  };

  const runAutoGroupBySchema = () => {
    const doc = docRef.current;
    if (!doc) {
      return;
    }
    scheduleSave(autoGroupBySchema(doc));
    setStatus('Grouped tables by schema');
  };

  const runLayoutSwimlanes = () => {
    const doc = docRef.current;
    if (!doc) {
      return;
    }
    if (!doc.groups.length) {
      setStatus('Create groups first (selection or By schema)');
      return;
    }
    scheduleSave(layoutSwimlanes(doc));
    fitCanvas(0.1);
    setStatus('Arranged swimlanes');
  };

  const collapseOrExpandAll = (collapsed: boolean) => {
    const doc = docRef.current;
    if (!doc?.groups.length) {
      return;
    }
    scheduleSave(setAllGroupsCollapsed(doc, collapsed));
  };

  const persistFilters = (patch: Partial<ErdDocument['filters']>) => {
    const doc = docRef.current;
    if (!doc) {
      return;
    }
    const next = {
      ...doc,
      filters: { ...doc.filters, ...patch },
      updatedAt: new Date().toISOString(),
    };
    scheduleSave(next);
  };

  if (!document) {
    return (
      <div className="erd-app">
        <div className="erd-toolbar">Loading diagram…</div>
      </div>
    );
  }

  return (
    <div className="erd-app">
      <div className="erd-toolbar">
        <div className="erd-toolbar__search">
          <span className="erd-toolbar__search-icon">⌕</span>
          <input
            type="search"
            placeholder="Filter tables…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              persistFilters({ search: e.target.value });
            }}
          />
        </div>

        <div className="erd-toolbar__group" role="group" aria-label="Filters">
          <label className={`chip ${hideUnconnected ? 'is-on' : ''}`}>
            <input
              type="checkbox"
              checked={hideUnconnected}
              onChange={(e) => {
                setHideUnconnected(e.target.checked);
                persistFilters({ hideUnconnected: e.target.checked });
              }}
            />
            Linked only
          </label>
          <label
            className={`chip ${showInferred ? 'is-on' : ''}`}
            title={
              inferredCount
                ? `${inferredCount} inferred suggestion(s) — Accept / Promote / Reject on each edge`
                : 'Show inferred (non-FK) relationship suggestions'
            }
          >
            <input
              type="checkbox"
              checked={showInferred}
              onChange={(e) => {
                setShowInferred(e.target.checked);
                persistFilters({ showInferred: e.target.checked });
              }}
            />
            Inferred{inferredCount ? ` (${inferredCount})` : ''}
          </label>
          <label className={`chip ${showViews ? 'is-on' : ''}`}>
            <input
              type="checkbox"
              checked={showViews}
              onChange={(e) => {
                setShowViews(e.target.checked);
                persistFilters({ showViews: e.target.checked });
              }}
            />
            Views
          </label>
          <label
            className={`chip ${pageInfo.pageMode ? 'is-on' : ''}`}
            title={
              pageInfo.forcePages
                ? `Pages required for ${pageInfo.total} tables (max ${AUTO_PAGE_THRESHOLD} on screen)`
                : 'Show tables in pages'
            }
          >
            <input
              type="checkbox"
              checked={pageInfo.pageMode}
              disabled={pageInfo.forcePages}
              onChange={(e) => {
                persistFilters({
                  pageMode: e.target.checked,
                  pageIndex: 0,
                  pageSize: document.filters.pageSize ?? DEFAULT_PAGE_SIZE,
                });
              }}
            />
            Pages{pageInfo.forcePages ? ' (auto)' : ''}
          </label>
        </div>

        {pageInfo.pageMode && (
          <div className="erd-toolbar__group">
            <button
              type="button"
              disabled={pageInfo.pageIndex <= 0}
              onClick={() => persistFilters({ pageIndex: pageInfo.pageIndex - 1 })}
            >
              ‹
            </button>
            <span className="erd-toolbar__meta" style={{ marginLeft: 0 }}>
              {pageInfo.pageIndex + 1}/{pageInfo.pageCount}
            </span>
            <button
              type="button"
              disabled={pageInfo.pageIndex >= pageInfo.pageCount - 1}
              onClick={() => persistFilters({ pageIndex: pageInfo.pageIndex + 1 })}
            >
              ›
            </button>
            <button
              type="button"
              onClick={() =>
                persistFilters({
                  pageSize: Math.min(
                    AUTO_PAGE_THRESHOLD,
                    Math.max(
                      10,
                      Number(window.prompt('Page size', String(pageInfo.pageSize)) || pageInfo.pageSize)
                    )
                  ),
                  pageIndex: 0,
                  pageMode: true,
                })
              }
            >
              Size
            </button>
          </div>
        )}

        <div className="erd-toolbar__group" role="group" aria-label="Groups">
          <button type="button" onClick={groupSelectedTables} title="Group selected tables into a swimlane">
            Group
          </button>
          <button type="button" onClick={runAutoGroupBySchema} title="Create one swimlane per schema">
            By schema
          </button>
          <button type="button" onClick={runLayoutSwimlanes} title="Stack groups as horizontal swimlanes">
            Swimlanes
          </button>
          <button
            type="button"
            onClick={() => collapseOrExpandAll(true)}
            disabled={!document.groups.length}
            title="Collapse all groups"
          >
            Collapse
          </button>
          <button
            type="button"
            onClick={() => collapseOrExpandAll(false)}
            disabled={!document.groups.length}
            title="Expand all groups"
          >
            Expand
          </button>
        </div>

        <button type="button" className="primary" onClick={autoLayout} title="Layout current page only">
          Auto-layout
        </button>
        <button type="button" onClick={compactLayout} title="Pack current page into a tight grid">
          Compact layout
        </button>
        <button type="button" onClick={() => fitCanvas(0.1)} title="Fit current page to screen">
          Fit screen
        </button>

        <span
          className="erd-toolbar__meta"
          title={
            pageInfo.pageMode
              ? `Page ${pageInfo.pageIndex + 1} of ${pageInfo.pageCount} · ${filteredTableIds.size} of ${pageInfo.total} tables`
              : `Zoom detail level: ${lod}`
          }
        >
          {pageInfo.pageMode
            ? `${filteredTableIds.size}/${pageInfo.total} · p${pageInfo.pageIndex + 1}`
            : `LOD ${lod}`}
        </span>
      </div>

      <div className="erd-canvas-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeMouseEnter={onNodeMouseEnter}
          onMove={(_, vp) => {
            setViewport((v) => ({ ...v, x: vp.x, y: vp.y, zoom: vp.zoom }));
          }}
          onInit={(instance) => {
            rfRef.current = instance;
            const el = window.document.querySelector('.erd-canvas-wrap');
            if (el) {
              const ro = new ResizeObserver((entries) => {
                const cr = entries[0]?.contentRect;
                if (cr) {
                  setViewport((v) => ({ ...v, width: cr.width, height: cr.height }));
                }
              });
              ro.observe(el);
            }
            fitCanvas(0.12);
          }}
          minZoom={0.08}
          maxZoom={1.75}
          onlyRenderVisibleElements
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: 'orthogonal',
            animated: false,
          }}
        >
          <Background gap={20} size={1} color="rgba(127,127,127,0.18)" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={2}
            nodeColor={(n) => (n.selected ? '#4fc1ff' : '#3794ff')}
            maskColor="rgba(0,0,0,0.45)"
          />
        </ReactFlow>
      </div>

      <div className="erd-footer">
        <div className="erd-footer__stats" title={status}>
          <strong>
            {filteredTableIds.size} on screen
          </strong>
          {` · ${pageInfo.total} total`}
          {pageInfo.pageMode
            ? ` · page ${pageInfo.pageIndex + 1}/${pageInfo.pageCount}`
            : ''}
          {pageInfo.forcePages ? ' · pages auto' : ''}
        </div>
        <div
          className="erd-footer__hint"
          title="Groups: select tables → Group · By schema · Swimlanes · ▾/▸ collapse · Inferred ✓/↑/✕"
        >
          {document.groups.length
            ? `Groups ${document.groups.length} · Swimlanes · ▾ collapse`
            : showInferred && inferredCount
              ? `Inferred: ✓ Visual · ↑ Physical · ✕ · ${inferredCount} open`
              : 'Group · By schema · Edit ✎ · Fit'}
        </div>
      </div>
    </div>
  );
}
