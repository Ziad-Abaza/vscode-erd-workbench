import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhysicalEdges } from '../../src/schema/SchemaSyncService';
import type { TableMeta } from '../../shared/types';

describe('composite foreign keys', () => {
  it('preserves ordered multi-column FK endpoints', () => {
    const tables: TableMeta[] = [
      {
        id: 'app.order_items',
        schema: 'app',
        name: 'order_items',
        kind: 'table',
        columns: [],
        foreignKeys: [
          {
            name: 'fk_oi_order',
            schema: 'app',
            table: 'order_items',
            columns: ['tenant_id', 'order_id'],
            referencedSchema: 'app',
            referencedTable: 'orders',
            referencedColumns: ['tenant_id', 'id'],
          },
        ],
      },
    ];
    const edges = buildPhysicalEdges(tables);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0].sourceColumns, ['tenant_id', 'order_id']);
    assert.deepEqual(edges[0].targetColumns, ['tenant_id', 'id']);
    assert.equal(edges[0].relationshipKind, 'physical');
  });
});
