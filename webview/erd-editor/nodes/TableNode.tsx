import { memo, useCallback, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ColumnMeta, EditTableAction } from '../../../shared/types';
import { post } from '../vscodeApi';

export type LodLevel = 'far' | 'mid' | 'near';

export interface TableNodeData {
  tableId: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
  orphaned?: boolean;
  pkCols: string[];
  fkCols: string[];
  columns?: ColumnMeta[];
  lod: LodLevel;
  columnCount: number;
}

interface MenuState {
  x: number;
  y: number;
  columnName?: string;
}

function TableNodeComponent(props: NodeProps) {
  const data = props.data as unknown as TableNodeData;
  const [menu, setMenu] = useState<MenuState | null>(null);

  const className = [
    'table-node',
    `lod-${data.lod}`,
    data.kind === 'view' ? 'view' : '',
    data.orphaned ? 'orphaned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const cols = data.columns ?? [];
  const limit = data.lod === 'mid' ? 6 : 14;
  const visibleCols = cols.slice(0, limit);
  const remaining = Math.max(0, (cols.length || data.columnCount) - visibleCols.length);

  // When columns not hydrated yet, still show PK hints from summary
  const placeholderCols =
    !cols.length && data.pkCols.length
      ? data.pkCols.map((name) => ({ name, kind: 'pk' as const }))
      : [];

  const tableId = data.tableId || `${data.schema}.${data.name}`;
  const editable = data.kind !== 'view' && !data.orphaned;

  const sendEdit = useCallback(
    (action: EditTableAction, columnName?: string) => {
      setMenu(null);
      post({
        type: 'editTable',
        tableId,
        action,
        payload: columnName ? { columnName } : undefined,
      });
    },
    [tableId]
  );

  const openMenu = (e: MouseEvent, columnName?: string) => {
    if (!editable) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, columnName });
  };

  return (
    <div
      className={className}
      onContextMenu={(e) => openMenu(e)}
      onDoubleClick={(e) => {
        if (!editable) {
          return;
        }
        e.stopPropagation();
        sendEdit('open');
      }}
    >
      <Handle type="target" position={Position.Left} id="t-left" />
      <Handle type="source" position={Position.Left} id="s-left" />
      <Handle type="target" position={Position.Right} id="t-right" />
      <Handle type="source" position={Position.Right} id="s-right" />
      <Handle type="target" position={Position.Top} id="t-top" />
      <Handle type="source" position={Position.Top} id="s-top" />
      <Handle type="target" position={Position.Bottom} id="t-bottom" />
      <Handle type="source" position={Position.Bottom} id="s-bottom" />
      <div className="table-node__header" title={`${data.schema}.${data.name}`}>
        <span className="table-node__schema">{data.schema}.</span>
        <span className="table-node__name">{data.name}</span>
        {data.kind === 'view' && <span className="table-node__tag">view</span>}
        {data.orphaned && <span className="table-node__tag">gone</span>}
        {editable && (
          <button
            type="button"
            className="table-node__edit"
            title="Edit columns (SQL preview + confirm)"
            onClick={(e) => {
              e.stopPropagation();
              sendEdit('open');
            }}
          >
            ✎
          </button>
        )}
      </div>

      {data.lod !== 'far' && (
        <div className="table-node__cols">
          {visibleCols.map((c) => {
            const isPk = data.pkCols.includes(c.name) || c.columnKey === 'PRI';
            const isFk = data.fkCols.includes(c.name) || c.columnKey === 'MUL';
            return (
              <div
                className="table-node__col"
                key={c.name}
                onContextMenu={(e) => openMenu(e, c.name)}
                onDoubleClick={(e) => {
                  if (!editable) {
                    return;
                  }
                  e.stopPropagation();
                  sendEdit('alterColumn', c.name);
                }}
                title={editable ? 'Double-click to alter · right-click for more' : undefined}
              >
                <span className={`table-node__badge ${isFk && !isPk ? 'fk' : ''}`}>
                  {isPk ? 'PK' : isFk ? 'FK' : ''}
                </span>
                <span className="table-node__col-name">{c.name}</span>
                <span className="table-node__type">{c.columnType}</span>
              </div>
            );
          })}

          {!visibleCols.length &&
            placeholderCols.map((c) => (
              <div className="table-node__col" key={c.name}>
                <span className="table-node__badge">PK</span>
                <span className="table-node__col-name">{c.name}</span>
                <span className="table-node__type">key</span>
              </div>
            ))}

          {!visibleCols.length && !placeholderCols.length && (
            <div className="table-node__col">
              <span />
              <span className="table-node__col-name" style={{ color: 'var(--erd-muted)' }}>
                Loading columns…
              </span>
              <span className="table-node__type">{data.columnCount || '—'}</span>
            </div>
          )}
        </div>
      )}

      {data.lod !== 'far' && (remaining > 0 || (!cols.length && data.columnCount > 0)) && (
        <div className="table-node__footer">
          {cols.length
            ? remaining > 0
              ? `+${remaining} more · ${data.columnCount || cols.length} cols`
              : `${cols.length} columns`
            : `${data.columnCount} columns`}
        </div>
      )}

      {menu &&
        createPortal(
          <div
            className="table-node__menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          >
            <div
              className="table-node__menu"
              style={{ left: menu.x, top: menu.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" onClick={() => sendEdit('open')}>
                Edit table…
              </button>
              <button type="button" onClick={() => sendEdit('addColumn')}>
                Add column…
              </button>
              {menu.columnName ? (
                <>
                  <button type="button" onClick={() => sendEdit('alterColumn', menu.columnName)}>
                    Alter “{menu.columnName}”…
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => sendEdit('dropColumn', menu.columnName)}
                  >
                    Drop “{menu.columnName}”…
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => sendEdit('alterColumn')}>
                    Alter column…
                  </button>
                  <button type="button" className="danger" onClick={() => sendEdit('dropColumn')}>
                    Drop column…
                  </button>
                </>
              )}
            </div>
          </div>,
          window.document.body
        )}
    </div>
  );
}

export const TableNode = memo(TableNodeComponent);
