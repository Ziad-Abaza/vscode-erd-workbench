import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDiagram } from '../../shared/types';
import { computePageInfo } from '../../src/diagram/paging';

describe('diagram paging', () => {
  it('pages large diagrams into stable slices', () => {
    const erd = createEmptyDiagram('c1', ['app']);
    erd.nodes = Array.from({ length: 120 }, (_, i) => ({
      tableId: `app.t_${String(i).padStart(3, '0')}`,
      x: 0,
      y: 0,
    }));
    erd.filters = { pageMode: true, pageIndex: 0, pageSize: 50 };
    const p0 = computePageInfo(erd);
    assert.equal(p0.pageCount, 3);
    assert.equal(p0.visibleTableIds.length, 50);

    erd.filters.pageIndex = 2;
    const p2 = computePageInfo(erd);
    assert.equal(p2.visibleTableIds.length, 20);
    assert.ok(p2.visibleTableIds[0]?.endsWith('t_100'));
  });
});
