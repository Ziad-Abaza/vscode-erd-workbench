import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDiagram, tableId, type TableMeta } from '../../shared/types';
import { buildPhysicalEdges } from '../../src/schema/SchemaSyncService';
import { suggestInferredRelationships } from '../../src/engineering/InferredRelationships';

function syntheticSchema(tableCount: number): TableMeta[] {
  const tables: TableMeta[] = [];
  for (let i = 0; i < tableCount; i++) {
    const name = `t_${i}`;
    const id = tableId('app', name);
    const columns = [
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
    ];
    if (i > 0) {
      columns.push({
        name: `t_${i - 1}_id`,
        ordinalPosition: 2,
        dataType: 'int',
        columnType: 'int',
        isNullable: true,
        columnKey: 'MUL',
        extra: '',
        columnDefault: null,
      });
    }
    const foreignKeys =
      i > 0
        ? [
            {
              name: `fk_${name}`,
              schema: 'app',
              table: name,
              columns: [`t_${i - 1}_id`],
              referencedSchema: 'app',
              referencedTable: `t_${i - 1}`,
              referencedColumns: ['id'],
            },
          ]
        : [];
    tables.push({
      id,
      schema: 'app',
      name,
      kind: 'table',
      columns,
      indexes: [{ name: 'PRIMARY', tableId: id, columns: ['id'], unique: true, primary: true }],
      foreignKeys,
    });
  }
  return tables;
}

describe('large schema synthetic', () => {
  it('builds edges for 1000 tables quickly', () => {
    const start = Date.now();
    const tables = syntheticSchema(1000);
    const edges = buildPhysicalEdges(tables);
    const doc = createEmptyDiagram('c1', ['app']);
    doc.nodes = tables.map((t, i) => ({
      tableId: t.id,
      x: (i % 40) * 280,
      y: Math.floor(i / 40) * 200,
    }));
    doc.edges = edges;
    const elapsed = Date.now() - start;
    assert.equal(tables.length, 1000);
    assert.equal(edges.length, 999);
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  });

  it('marks inferred suggestions separately from physical', () => {
    const tables = syntheticSchema(5);
    // Remove physical FKs to allow inference
    for (const t of tables) {
      t.foreignKeys = [];
    }
    const inferred = suggestInferredRelationships(tables, []);
    assert.ok(inferred.every((e) => e.relationshipKind === 'inferred'));
  });
});
