import { memo, type MouseEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface GroupNodeData {
  groupId: string;
  name: string;
  color: string;
  memberCount: number;
  collapsed: boolean;
  width: number;
  height: number;
  onToggle?: (groupId: string) => void;
  onRename?: (groupId: string) => void;
  onDissolve?: (groupId: string) => void;
}

function GroupNodeComponent(props: NodeProps) {
  const data = props.data as unknown as GroupNodeData;
  const color = data.color || '#3d5a80';

  const onToggle = (e: MouseEvent) => {
    e.stopPropagation();
    data.onToggle?.(data.groupId);
  };

  const onRename = (e: MouseEvent) => {
    e.stopPropagation();
    data.onRename?.(data.groupId);
  };

  const onDissolve = (e: MouseEvent) => {
    e.stopPropagation();
    data.onDissolve?.(data.groupId);
  };

  if (data.collapsed) {
    return (
      <div
        className="group-node group-node--collapsed"
        style={{
          width: data.width,
          borderColor: color,
          background: `color-mix(in srgb, ${color} 28%, var(--erd-panel))`,
        }}
        title="Collapsed swimlane — click ▸ to expand"
      >
        <Handle type="target" position={Position.Left} id="t-left" className="group-node__handle" />
        <Handle type="source" position={Position.Right} id="s-right" className="group-node__handle" />
        <Handle type="target" position={Position.Top} id="t-top" className="group-node__handle" />
        <Handle type="source" position={Position.Bottom} id="s-bottom" className="group-node__handle" />
        <button type="button" className="group-node__toggle" onClick={onToggle} title="Expand group">
          ▸
        </button>
        <div className="group-node__title" onDoubleClick={onRename}>
          <strong>{data.name}</strong>
          <span>{data.memberCount} tables</span>
        </div>
        <button
          type="button"
          className="group-node__ghost"
          onClick={onDissolve}
          title="Dissolve group"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div
      className="group-node group-node--expanded"
      style={{
        width: data.width,
        height: data.height,
        borderColor: color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
    >
      <div className="group-node__header" style={{ borderBottomColor: color }}>
        <button type="button" className="group-node__toggle" onClick={onToggle} title="Collapse group">
          ▾
        </button>
        <div className="group-node__title" onDoubleClick={onRename}>
          <strong>{data.name}</strong>
          <span>{data.memberCount}</span>
        </div>
        <button
          type="button"
          className="group-node__ghost"
          onClick={onDissolve}
          title="Dissolve group"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export const GroupNode = memo(GroupNodeComponent);
