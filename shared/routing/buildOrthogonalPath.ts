import type { HandleSide } from './types';

export interface OrthogonalPathInput {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceSide: HandleSide;
  targetSide: HandleSide;
  sourcePortOffset?: number;
  targetPortOffset?: number;
  bundleOffset?: number;
  stem?: number;
  borderRadius?: number;
}

export interface OrthogonalPathResult {
  path: string;
  labelX: number;
  labelY: number;
  points: { x: number; y: number }[];
}

/**
 * Build an H/V orthogonal polyline with port offsets and a light trunk bundle offset.
 */
export function buildOrthogonalPath(input: OrthogonalPathInput): OrthogonalPathResult {
  const stem = input.stem ?? 20;
  const radius = input.borderRadius ?? 8;
  const sourcePort = input.sourcePortOffset ?? 0;
  const targetPort = input.targetPortOffset ?? 0;
  const bundle = input.bundleOffset ?? 0;

  let sx = input.sourceX;
  let sy = input.sourceY;
  let tx = input.targetX;
  let ty = input.targetY;

  if (input.sourceSide === 'left' || input.sourceSide === 'right') {
    sy += sourcePort;
  } else {
    sx += sourcePort;
  }
  if (input.targetSide === 'left' || input.targetSide === 'right') {
    ty += targetPort;
  } else {
    tx += targetPort;
  }

  const sExit = step(sx, sy, input.sourceSide, stem);
  const tExit = step(tx, ty, input.targetSide, stem);

  const points: { x: number; y: number }[] = [{ x: sx, y: sy }, sExit];

  const sourceHoriz = input.sourceSide === 'left' || input.sourceSide === 'right';
  const targetHoriz = input.targetSide === 'left' || input.targetSide === 'right';

  if (sourceHoriz && targetHoriz) {
    const midX = (sExit.x + tExit.x) / 2 + bundle;
    points.push({ x: midX, y: sExit.y });
    points.push({ x: midX, y: tExit.y });
  } else if (!sourceHoriz && !targetHoriz) {
    const midY = (sExit.y + tExit.y) / 2 + bundle;
    points.push({ x: sExit.x, y: midY });
    points.push({ x: tExit.x, y: midY });
  } else if (sourceHoriz) {
    // source horizontal → target vertical: go to target's x then down/up
    points.push({ x: tExit.x + bundle, y: sExit.y });
    points.push({ x: tExit.x + bundle, y: tExit.y });
  } else {
    points.push({ x: sExit.x, y: tExit.y + bundle });
    points.push({ x: tExit.x, y: tExit.y + bundle });
  }

  points.push(tExit);
  points.push({ x: tx, y: ty });

  const simplified = simplifyColinear(points);
  const path = pointsToRoundedPath(simplified, radius);
  const mid = simplified[Math.floor(simplified.length / 2)] ?? { x: (sx + tx) / 2, y: (sy + ty) / 2 };

  return {
    path,
    labelX: mid.x,
    labelY: mid.y,
    points: simplified,
  };
}

function step(x: number, y: number, side: HandleSide, stem: number): { x: number; y: number } {
  switch (side) {
    case 'left':
      return { x: x - stem, y };
    case 'right':
      return { x: x + stem, y };
    case 'top':
      return { x, y: y - stem };
    case 'bottom':
      return { x, y: y + stem };
  }
}

function simplifyColinear(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length <= 2) {
    return points;
  }
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    const colinear =
      (nearly(prev.x, cur.x) && nearly(cur.x, next.x)) || (nearly(prev.y, cur.y) && nearly(cur.y, next.y));
    if (!colinear) {
      out.push(cur);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function nearly(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

function pointsToRoundedPath(points: { x: number; y: number }[], radius: number): string {
  if (points.length < 2) {
    return '';
  }
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const len1 = Math.hypot(dx1, dy1) || 1;
    const len2 = Math.hypot(dx2, dy2) || 1;
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const before = { x: cur.x - (dx1 / len1) * r, y: cur.y - (dy1 / len1) * r };
    const after = { x: cur.x + (dx2 / len2) * r, y: cur.y + (dy2 / len2) * r };
    d += ` L ${before.x} ${before.y} Q ${cur.x} ${cur.y} ${after.x} ${after.y}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
