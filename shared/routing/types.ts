export type HandleSide = 'left' | 'right' | 'top' | 'bottom';

export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeEndpoints {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface HandleAssignment {
  sourceSide: HandleSide;
  targetSide: HandleSide;
  sourceHandle: string;
  targetHandle: string;
}

export interface RoutedEdge extends HandleAssignment {
  id: string;
  sourceId: string;
  targetId: string;
  /** Offset along the source side (px from center) to reduce crossings. */
  sourcePortOffset: number;
  /** Offset along the target side (px from center). */
  targetPortOffset: number;
  /** Lane index among parallel edges (0 = center). */
  bundleLane: number;
  /** Pixel offset applied to the shared trunk segment. */
  bundleOffset: number;
}

export interface RouteEdgesOptions {
  defaultWidth?: number;
  defaultHeight?: number;
  portGap?: number;
  bundleGap?: number;
  maxBundleLanes?: number;
}
