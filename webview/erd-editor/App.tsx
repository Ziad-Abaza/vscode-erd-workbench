import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnNodesChange,
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
import { post } from './vscodeApi';
import { TableNode, type LodLevel, type TableNodeData } from './nodes/TableNode';
import { OrthogonalEdge } from './edges/OrthogonalEdge';

const nodeTypes = { tableNode: TableNode };
const edgeTypes = { orthogonal: OrthogonalEdge };

const VIEWPORT_MARGIN = 400;
const MAX_MOUNTED = 300;

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
          const doc = msg.document;
          setDocument(doc);
          // Keep toolbar in sync for live agent edits too
          setSearch(doc.filters.search ?? '');
          setHideUnconnected(Boolean(doc.filters.hideUnconnected));
          setShowInferred(Boolean(doc.filters.showInferred));
          setShowViews(doc.filters.showViews !== false);
          if (msg.type === 'init') {
            setCatalog(msg.catalogSummary);
          }
          const pageMode = doc.filters.pageMode
            ? ` · page ${(doc.filters.pageIndex ?? 0) + 1}`
            : '';
          setStatus(`${doc.nodes.length} tables · ${doc.edges.length} edges${pageMode}`);
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
              pkCols: msg.columns.filter((c) => c.columnKey === 'PRI').map((c) => c.name),
            },
          }));
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
  }, []);

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
    const pageMode = Boolean(document.filters.pageMode);
    const pageSize = pageMode ? Math.max(10, document.filters.pageSize ?? 50) : ordered.length || 1;
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize));
    const pageIndex = Math.min(Math.max(0, document.filters.pageIndex ?? 0), pageCount - 1);
    return { pageIndex, pageSize, pageCount, total: ordered.length, ordered };
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

    if (document.filters.pageMode) {
      const start = pageInfo.pageIndex * pageInfo.pageSize;
      const pageSet = new Set((pageInfo.ordered ?? ids).slice(start, start + pageInfo.pageSize));
      ids = ids.filter((id) => pageSet.has(id));
    }

    return new Set(ids);
  }, [document, search, hideUnconnected, showInferred, showViews, catalogIndex, pageInfo]);

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

    const candidates = document.nodes.filter((n) => filteredTableIds.has(n.tableId));
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
      };
    });

    const rfEdges: Edge[] = document.edges
      .filter((e) => {
        if (e.hidden) {
          return false;
        }
        if (e.relationshipKind === 'inferred' && !showInferred) {
          return false;
        }
        return mountIds.has(e.sourceTableId) && mountIds.has(e.targetTableId);
      })
      .map((e) => ({
        id: e.id,
        source: e.sourceTableId,
        target: e.targetTableId,
        sourceHandle: 's-right',
        targetHandle: 't-left',
        type: 'orthogonal',
        data: {
          relationshipKind: e.relationshipKind,
          label: e.label,
          cardinality: e.cardinality,
        },
        selectable: true,
      }));

    setNodes(rfNodes);
    setEdges(rfEdges);
    setStatus(
      `${rfNodes.length} on canvas · ${filteredTableIds.size} filtered · ${document.nodes.length} total`
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
      const map = new Map(posChanges.map((c) => [c.id, c.position]));
      const nodes = doc.nodes.map((n) => {
        const p = map.get(n.tableId);
        return p ? { ...n, x: p.x, y: p.y } : n;
      });
      const dragging = changes.some((c) => c.type === 'position' && (c as { dragging?: boolean }).dragging);
      const next = { ...doc, nodes, updatedAt: new Date().toISOString() };
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
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    post({ type: 'requestAutoLayout', tableIds: ids });
  };

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) {
      return;
    }
    // Default: visual-only. Physical is an explicit second confirm.
    const visual = window.confirm(
      'Create a VISUAL-ONLY relationship?\n\nOK = visual (no database change)\nCancel = choose physical or abort'
    );
    if (visual) {
      post({
        type: 'createRelationship',
        mode: 'visual',
        edge: {
          sourceTableId: connection.source,
          targetTableId: connection.target,
          sourceColumns: [],
          targetColumns: [],
          cardinality: '1:N',
          relationshipKind: 'visual',
        },
      });
      return;
    }
    const physical = window.confirm(
      'Create a PHYSICAL foreign key instead?\n\nOK = SQL preview + VS Code confirmation\nCancel = abort (no changes)'
    );
    if (!physical) {
      return;
    }
    post({
      type: 'createRelationship',
      mode: 'physical',
      edge: {
        sourceTableId: connection.source,
        targetTableId: connection.target,
        sourceColumns: ['id'],
        targetColumns: ['id'],
        cardinality: '1:N',
        relationshipKind: 'physical',
      },
    });
  }, []);

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
          <label className={`chip ${showInferred ? 'is-on' : ''}`}>
            <input
              type="checkbox"
              checked={showInferred}
              onChange={(e) => {
                setShowInferred(e.target.checked);
                persistFilters({ showInferred: e.target.checked });
              }}
            />
            Inferred
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
          <label className={`chip ${document.filters.pageMode ? 'is-on' : ''}`}>
            <input
              type="checkbox"
              checked={Boolean(document.filters.pageMode)}
              onChange={(e) => {
                persistFilters({
                  pageMode: e.target.checked,
                  pageIndex: 0,
                  pageSize: document.filters.pageSize ?? 50,
                });
              }}
            />
            Pages
          </label>
        </div>

        {document.filters.pageMode && (
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
                  pageSize: Math.max(
                    10,
                    Number(window.prompt('Page size', String(pageInfo.pageSize)) || pageInfo.pageSize)
                  ),
                  pageIndex: 0,
                })
              }
            >
              Size
            </button>
          </div>
        )}

        <button type="button" className="primary" onClick={autoLayout}>
          Auto-layout
        </button>
        <button
          type="button"
          onClick={() => post({ type: 'requestAutoLayout', tableIds: [] })}
          title="Arrange current page/filter as a compact grid via host layout"
        >
          Compact layout
        </button>

        <span className="erd-toolbar__meta">Zoom detail: {lod}</span>
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
            // Fit lightly on first open if viewport is default origin
            if (document.viewport.zoom === 1 && document.viewport.x === 0 && document.viewport.y === 0) {
              requestAnimationFrame(() => instance.fitView({ padding: 0.12, maxZoom: 1 }));
            }
          }}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          selectionMode={SelectionMode.Partial}
          multiSelectionKeyCode="Shift"
          fitView={false}
          defaultViewport={{
            x: document.viewport.x,
            y: document.viewport.y,
            zoom: document.viewport.zoom || 1,
          }}
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
        <div>
          <strong>{status}</strong>
          {document.filters.pageMode
            ? ` · page ${pageInfo.pageIndex + 1}/${pageInfo.pageCount}`
            : ''}
        </div>
        <div className="erd-footer__hint">
          Drag tables · Shift+select · Connect handles for relationships · Pages for large schemas
        </div>
      </div>
    </div>
  );
}
