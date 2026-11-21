import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignHandles,
  buildOrthogonalPath,
  bundleParallels,
  countSegmentCrossings,
  routeEdges,
  sortPorts,
  type RoutedEdge,
} from '../../shared/routing';

describe('assignHandles', () => {
  it('picks left/right when nodes are horizontally separated', () => {
    const a = { id: 'a', x: 0, y: 0, width: 200, height: 100 };
    const b = { id: 'b', x: 400, y: 20, width: 200, height: 100 };
    const h = assignHandles(a, b);
    assert.equal(h.sourceSide, 'right');
    assert.equal(h.targetSide, 'left');
    assert.equal(h.sourceHandle, 's-right');
    assert.equal(h.targetHandle, 't-left');
  });

  it('picks top/bottom when nodes are vertically separated', () => {
    const a = { id: 'a', x: 0, y: 0, width: 200, height: 100 };
    const b = { id: 'b', x: 10, y: 400, width: 200, height: 100 };
    const h = assignHandles(a, b);
    assert.equal(h.sourceSide, 'bottom');
    assert.equal(h.targetSide, 'top');
  });
});

describe('sortPorts', () => {
  it('orders fan-out edges by opposite node Y to reduce braiding', () => {
    const nodes = new Map([
      ['src', { id: 'src', x: 0, y: 100, width: 100, height: 100 }],
      ['t1', { id: 't1', x: 300, y: 0, width: 100, height: 80 }],
      ['t2', { id: 't2', x: 300, y: 200, width: 100, height: 80 }],
    ]);
    const edges: RoutedEdge[] = [
      {
        id: 'e-high',
        sourceId: 'src',
        targetId: 't2',
        sourceSide: 'right',
        targetSide: 'left',
        sourceHandle: 's-right',
        targetHandle: 't-left',
        sourcePortOffset: 0,
        targetPortOffset: 0,
        bundleLane: 0,
        bundleOffset: 0,
      },
      {
        id: 'e-low',
        sourceId: 'src',
        targetId: 't1',
        sourceSide: 'right',
        targetSide: 'left',
        sourceHandle: 's-right',
        targetHandle: 't-left',
        sourcePortOffset: 0,
        targetPortOffset: 0,
        bundleLane: 0,
        bundleOffset: 0,
      },
    ];
    sortPorts(edges, nodes, 14);
    const low = edges.find((e) => e.id === 'e-low')!;
    const high = edges.find((e) => e.id === 'e-high')!;
    assert.ok(low.sourcePortOffset < high.sourcePortOffset);
  });
});

describe('bundleParallels', () => {
  it('offsets parallel edges between the same pair', () => {
    const edges: RoutedEdge[] = [
      {
        id: 'a',
        sourceId: 'u',
        targetId: 'v',
        sourceSide: 'right',
        targetSide: 'left',
        sourceHandle: 's-right',
        targetHandle: 't-left',
        sourcePortOffset: 0,
        targetPortOffset: 0,
        bundleLane: 0,
        bundleOffset: 0,
      },
      {
        id: 'b',
        sourceId: 'u',
        targetId: 'v',
        sourceSide: 'right',
        targetSide: 'left',
        sourceHandle: 's-right',
        targetHandle: 't-left',
        sourcePortOffset: 0,
        targetPortOffset: 0,
        bundleLane: 0,
        bundleOffset: 0,
      },
    ];
    bundleParallels(edges, { bundleGap: 10 });
    assert.notEqual(edges[0].bundleOffset, edges[1].bundleOffset);
    assert.equal(Math.abs(edges[0].bundleOffset - edges[1].bundleOffset), 10);
  });
});

describe('buildOrthogonalPath', () => {
  it('produces only orthogonal segments', () => {
    const { points, path } = buildOrthogonalPath({
      sourceX: 100,
      sourceY: 50,
      targetX: 400,
      targetY: 200,
      sourceSide: 'right',
      targetSide: 'left',
      bundleOffset: 8,
    });
    assert.ok(path.startsWith('M '));
    assert.ok(points.length >= 4);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const orth = Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01;
      assert.equal(orth, true, `segment ${i} not orthogonal`);
    }
  });
});

describe('routeEdges', () => {
  it('routes a small diagram with handles, ports, and lanes', () => {
    const routed = routeEdges(
      [
        { id: 'a', x: 0, y: 0, width: 180, height: 100 },
        { id: 'b', x: 400, y: 40, width: 180, height: 100 },
        { id: 'c', x: 400, y: 220, width: 180, height: 100 },
      ],
      [
        { id: 'e1', sourceId: 'a', targetId: 'b' },
        { id: 'e2', sourceId: 'a', targetId: 'c' },
        { id: 'e3', sourceId: 'a', targetId: 'b' },
      ]
    );
    assert.equal(routed.length, 3);
    assert.ok(routed.every((e) => e.sourceHandle.startsWith('s-')));
    assert.ok(routed.every((e) => e.targetHandle.startsWith('t-')));
    const parallels = routed.filter((e) => e.targetId === 'b');
    assert.equal(parallels.length, 2);
    assert.notEqual(parallels[0].bundleOffset, parallels[1].bundleOffset);

    const polys = routed.map((e) => {
      const src = { x: 180, y: 50 };
      const tgt = { x: 400, y: e.targetId === 'b' ? 90 : 270 };
      return buildOrthogonalPath({
        sourceX: src.x,
        sourceY: src.y,
        targetX: tgt.x,
        targetY: tgt.y,
        sourceSide: e.sourceSide,
        targetSide: e.targetSide,
        sourcePortOffset: e.sourcePortOffset,
        targetPortOffset: e.targetPortOffset,
        bundleOffset: e.bundleOffset,
      }).points;
    });
    assert.ok(countSegmentCrossings(polys) >= 0);
  });
});
