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
    data.kind === 'view' ? 'view' : '',
    data.orphaned ? 'orphaned' : '',
    data.lod === 'far' ? 'lod-far' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <Handle type="target" position={Position.Left} id="t-left" />
      <Handle type="source" position={Position.Right} id="s-right" />
      <div className="table-node__header" title={`${data.schema}.${data.name}`}>
        <span className="table-node__schema">{data.schema}.</span>
        {data.name}
        {data.kind === 'view' ? ' (view)' : ''}
        {data.orphaned ? ' — removed' : ''}
      </div>
      {data.lod !== 'far' && (
        <div className="table-node__cols">
          {(data.columns ?? []).slice(0, data.lod === 'mid' ? 8 : 50).map((c) => {
            const isPk = data.pkCols.includes(c.name);
            const isFk = data.fkCols.includes(c.name);
            return (
              <div className="table-node__col" key={c.name}>
                <span className={`table-node__badge ${isFk ? 'fk' : ''}`}>
                  {isPk ? 'PK' : isFk ? 'FK' : ''}
                </span>
                <span>{c.name}</span>
                <span className="table-node__type">{c.columnType}</span>
              </div>
            );
          })}
          {data.lod === 'mid' && data.columnCount > 8 && (
            <div className="table-node__col">
              <span />
              <span className="table-node__type">+{data.columnCount - 8} more…</span>
              <span />
            </div>
          )}
          {!data.columns?.length && (
            <div className="table-node__col">
              <span />
              <span className="table-node__type">{data.columnCount} columns</span>
              <span />
            </div>
          )}
        </div>
      )}
      <Handle type="target" position={Position.Top} id="t-top" />
      <Handle type="source" position={Position.Bottom} id="s-bottom" />
    </div>
  );
}

export const TableNode = memo(TableNodeComponent);
