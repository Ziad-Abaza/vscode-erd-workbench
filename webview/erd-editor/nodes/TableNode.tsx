import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ColumnMeta } from '../../../shared/types';

export type LodLevel = 'far' | 'mid' | 'near';

export interface TableNodeData {
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

function TableNodeComponent(props: NodeProps) {
  const data = props.data as unknown as TableNodeData;
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

  return (
    <div className={className}>
      <Handle type="target" position={Position.Left} id="t-left" />
      <Handle type="source" position={Position.Right} id="s-right" />
      <div className="table-node__header" title={`${data.schema}.${data.name}`}>
        <span className="table-node__schema">{data.schema}.</span>
        <span className="table-node__name">{data.name}</span>
        {data.kind === 'view' && <span className="table-node__tag">view</span>}
        {data.orphaned && <span className="table-node__tag">gone</span>}
      </div>

      {data.lod !== 'far' && (
        <div className="table-node__cols">
          {visibleCols.map((c) => {
            const isPk = data.pkCols.includes(c.name) || c.columnKey === 'PRI';
            const isFk = data.fkCols.includes(c.name) || c.columnKey === 'MUL';
            return (
              <div className="table-node__col" key={c.name}>
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

      <Handle type="target" position={Position.Top} id="t-top" />
      <Handle type="source" position={Position.Bottom} id="s-bottom" />
    </div>
  );
}

export const TableNode = memo(TableNodeComponent);
