import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';

export interface OrthogonalEdgeData {
  relationshipKind: 'physical' | 'visual' | 'inferred';
  label?: string;
  cardinality?: string;
}

/**
 * Orthogonal-ish routing via smooth-step (right angles).
 * Crossing reduction / bundling is applied upstream when assigning handles.
 */
function OrthogonalEdgeComponent(props: EdgeProps) {
  const data = (props.data ?? {}) as OrthogonalEdgeData;
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 8,
    offset: 20,
  });

  const cls =
    data.relationshipKind === 'inferred'
      ? 'edge-inferred'
      : data.relationshipKind === 'visual'
        ? 'edge-visual'
        : 'edge-physical';

  const showLabel = props.selected || (props.style?.opacity !== 0 && props.markerEnd);

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          ...props.style,
          strokeWidth: props.selected ? 2.5 : 1.5,
        }}
        className={cls}
        interactionWidth={24}
      />
      {(props.selected || showLabel) && data.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              fontSize: 10,
              padding: '1px 4px',
              borderRadius: 3,
              background: 'rgba(0,0,0,0.65)',
              color: '#eee',
              whiteSpace: 'nowrap',
            }}
            className="nodrag nopan"
          >
            {data.cardinality ? `${data.cardinality} ` : ''}
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const OrthogonalEdge = memo(OrthogonalEdgeComponent);
