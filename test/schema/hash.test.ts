import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashTableMeta } from '../../src/schema/hash';
import type { TableMeta } from '../../shared/types';

describe('hashTableMeta', () => {
  it('is stable for equivalent tables', () => {
    const a: TableMeta = {
      id: 'app.users',
      schema: 'app',
      name: 'users',
      kind: 'table',
      columns: [
        {
          name: 'id',
          ordinalPosition: 1,
          dataType: 'int',
          columnType: 'int',
          isNullable: false,
          columnKey: 'PRI',
          extra: 'auto_increment',
          columnDefault: null,
        },
      ],
      indexes: [{ name: 'PRIMARY', tableId: 'app.users', columns: ['id'], unique: true, primary: true }],
      foreignKeys: [],
    };
    const b = structuredClone(a);
    assert.equal(hashTableMeta(a), hashTableMeta(b));
  });

  it('changes when column type changes', () => {
    const a: TableMeta = {
      id: 'app.users',
      schema: 'app',
      name: 'users',
      kind: 'table',
      columns: [
        {
          name: 'id',
          ordinalPosition: 1,
          dataType: 'int',
          columnType: 'int',
          isNullable: false,
          columnKey: 'PRI',
          extra: '',
          columnDefault: null,
        },
      ],
    };
    const b = structuredClone(a);
    b.columns![0].columnType = 'bigint';
    assert.notEqual(hashTableMeta(a), hashTableMeta(b));
  });
});
