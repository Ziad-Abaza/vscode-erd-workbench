import { memo, type MouseEvent } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from '@xyflow/react';
import { buildOrthogonalPath, type HandleSide } from '../../../shared/routing';

export type InferredEdgeAction = 'accept-visual' | 'promote-physical' | 'reject';

export interface OrthogonalEdgeData {
  relationshipKind: 'physical' | 'visual' | 'inferred';
  label?: string;
  cardinality?: string;
  sourceSide?: HandleSide;
  targetSide?: HandleSide;
  sourcePortOffset?: number;
  targetPortOffset?: number;
  bundleLane?: number;
  bundleOffset?: number;
  /** Canvas controls for inferred suggestions — host applies via proposeInferredAction */
  onInferredAction?: (action: InferredEdgeAction) => void;
}

/**
 * Orthogonal routing with port offsets + light parallel bundling from the shared router.
 * Inferred edges always show Accept / Promote / Reject controls on the label.
 */
function OrthogonalEdgeComponent(props: EdgeProps) {
  const data = (props.data ?? {}) as OrthogonalEdgeData;
  const sourceSide = data.sourceSide;
  const targetSide = data.targetSide;

  const routed =
    sourceSide && targetSide
      ? buildOrthogonalPath({
          sourceX: props.sourceX,
          sourceY: props.sourceY,
          targetX: props.targetX,
          targetY: props.targetY,
          sourceSide,
          targetSide,
          sourcePortOffset: data.sourcePortOffset ?? 0,
          targetPortOffset: data.targetPortOffset ?? 0,
          bundleOffset: data.bundleOffset ?? 0,
          stem: 18,
          borderRadius: 8,
        })
      : null;

  const fallback = routed
    ? null
    : getSmoothStepPath({
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
        sourcePosition: props.sourcePosition,
        targetPosition: props.targetPosition,
        borderRadius: 8,
        offset: 20 + Math.abs(data.bundleOffset ?? 0),
      });

  const path = routed?.path ?? fallback?.[0] ?? '';
  const labelX = routed?.labelX ?? fallback?.[1] ?? (props.sourceX + props.targetX) / 2;
  const labelY = routed?.labelY ?? fallback?.[2] ?? (props.sourceY + props.targetY) / 2;

  const isInferred = data.relationshipKind === 'inferred';
  const cls = isInferred
    ? 'edge-inferred'
    : data.relationshipKind === 'visual'
      ? 'edge-visual'
      : 'edge-physical';

  const showLabel = Boolean(props.selected || data.label || isInferred);

  const fire = (action: InferredEdgeAction) => (ev: MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    data.onInferredAction?.(action);
  };

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          ...props.style,
          strokeWidth: props.selected || isInferred ? 2.5 : 1.5,
        }}
        className={cls}
        interactionWidth={24}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className={`nodrag nopan edge-label-wrap${isInferred ? ' edge-label-wrap--inferred' : ''}${
              props.selected ? ' is-selected' : ''
            }`}
          >
            {(data.label || data.cardinality) && (
              <div className={`edge-label${isInferred ? ' edge-label--inferred' : ''}`}>
                {data.cardinality ? `${data.cardinality} ` : ''}
                {data.label}
              </div>
            )}
            {isInferred && data.onInferredAction && (
              <div className="edge-inferred-actions" role="group" aria-label="Inferred relationship actions">
                <button
                  type="button"
                  className="edge-inferred-btn edge-inferred-btn--accept"
                  title="Accept as visual relationship (no DDL)"
                  onClick={fire('accept-visual')}
                >
                  ✓ Visual
                </button>
                <button
                  type="button"
                  className="edge-inferred-btn edge-inferred-btn--promote"
                  title="Promote to physical FK (SQL preview + confirm)"
                  onClick={fire('promote-physical')}
                >
                  ↑ Physical
                </button>
                <button
                  type="button"
                  className="edge-inferred-btn edge-inferred-btn--reject"
                  title="Dismiss this suggestion"
                  onClick={fire('reject')}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const OrthogonalEdge = memo(OrthogonalEdgeComponent);
