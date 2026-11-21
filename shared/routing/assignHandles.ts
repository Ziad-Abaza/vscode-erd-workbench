import type { HandleAssignment, HandleSide, NodeRect } from './types';

const HYSTERESIS = 24;

/**
 * Pick source/target sides from relative node centers.
 * Hysteresis keeps the previous assignment when the dominant axis is close to diagonal.
 */
export function assignHandles(
  source: NodeRect,
  target: NodeRect,
  previous?: Pick<HandleAssignment, 'sourceSide' | 'targetSide'>
): HandleAssignment {
  const scx = source.x + source.width / 2;
  const scy = source.y + source.height / 2;
  const tcx = target.x + target.width / 2;
  const tcy = target.y + target.height / 2;
  const dx = tcx - scx;
  const dy = tcy - scy;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let horizontal: boolean;
  if (previous) {
    const prevHorizontal = previous.sourceSide === 'left' || previous.sourceSide === 'right';
    if (prevHorizontal) {
      horizontal = absDx + HYSTERESIS >= absDy;
    } else {
      horizontal = absDx >= absDy + HYSTERESIS;
    }
  } else {
    horizontal = absDx >= absDy;
  }

  let sourceSide: HandleSide;
  let targetSide: HandleSide;
  if (horizontal) {
    if (dx >= 0) {
      sourceSide = 'right';
      targetSide = 'left';
    } else {
      sourceSide = 'left';
      targetSide = 'right';
    }
  } else if (dy >= 0) {
    sourceSide = 'bottom';
    targetSide = 'top';
  } else {
    sourceSide = 'top';
    targetSide = 'bottom';
  }

  return {
    sourceSide,
    targetSide,
    sourceHandle: `s-${sourceSide}`,
    targetHandle: `t-${targetSide}`,
  };
}

export function sideAxis(side: HandleSide): 'x' | 'y' {
  return side === 'left' || side === 'right' ? 'y' : 'x';
}
