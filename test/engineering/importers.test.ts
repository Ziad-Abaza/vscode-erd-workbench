import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiagramFromImport,
  detectImportFormat,
  importSchemaContent,
  parseDbml,
  parseJsonPackage,
  parseSqlDdl,
} from '../../src/engineering/importers';
import { exportDbml, exportJsonPackage, exportSqlDdl } from '../../src/engineering/ImportExport';
import type { CatalogSnapshot, TableMeta } from '../../shared/types';

const sampleTables: TableMeta[] = [
  {
    id: 'app.users',
    schema: 'app',
    name: 'users',
    kind: 'table',
    columns: [
      {
        name: 'id',
        ordinalPosition: 1,
        dataType: 'int',
        columnType: 'INT',
        isNullable: false,
        columnKey: 'PRI',
        extra: 'auto_increment',
        columnDefault: null,
      },
      {
        name: 'email',
        ordinalPosition: 2,
        dataType: 'varchar',
        columnType: 'VARCHAR(255)',
        isNullable: true,
        columnKey: '',
        extra: '',
        columnDefault: null,
      },
    ],
    indexes: [
      { name: 'PRIMARY', tableId: 'app.users', columns: ['id'], unique: true, primary: true },
    ],
    foreignKeys: [],
    columnsHydrated: true,
  },
  {
    id: 'app.orders',
    schema: 'app',
    name: 'orders',
    kind: 'table',
    columns: [
      {
        name: 'id',
        ordinalPosition: 1,
        dataType: 'int',
        columnType: 'INT',
        isNullable: false,
        columnKey: 'PRI',
        extra: '',
        columnDefault: null,
      },
      {
        name: 'user_id',
        ordinalPosition: 2,
        dataType: 'int',
        columnType: 'INT',
        isNullable: false,
        columnKey: 'MUL',
        extra: '',
        columnDefault: null,
      },
    ],
    indexes: [
      { name: 'PRIMARY', tableId: 'app.orders', columns: ['id'], unique: true, primary: true },
    ],
    foreignKeys: [
      {
        name: 'fk_orders_users',
        schema: 'app',
        table: 'orders',
        columns: ['user_id'],
        referencedSchema: 'app',
        referencedTable: 'users',
        referencedColumns: ['id'],
      },
    ],
    columnsHydrated: true,
  },
];

describe('detectImportFormat', () => {
  it('detects by extension and content', () => {
    assert.equal(detectImportFormat('{}', 'x.json'), 'json');
    assert.equal(detectImportFormat('CREATE TABLE t (id INT);', 'x.sql'), 'sql');
    assert.equal(detectImportFormat('Table users {\n  id int\n}', 'x.dbml'), 'dbml');
    assert.equal(detectImportFormat('{"format":"erd-workbench-package"}'), 'json');
    assert.equal(detectImportFormat('Table app.users {\n  id int [pk]\n}'), 'dbml');
  });
});

describe('parseSqlDdl', () => {
  it('round-trips exported SQL into tables + FK edges', () => {
    const sql = exportSqlDdl(sampleTables);
    const result = parseSqlDdl(sql, { defaultSchema: 'app' });
    assert.equal(result.tables.length, 2);
    const users = result.tables.find((t) => t.name === 'users');
    const orders = result.tables.find((t) => t.name === 'orders');
    assert.ok(users);
    assert.ok(orders);
    assert.equal(users.columns?.find((c) => c.name === 'id')?.columnKey, 'PRI');
    assert.ok((orders.foreignKeys ?? []).some((fk) => fk.referencedTable === 'users'));
    assert.ok(result.edges.some((e) => e.relationshipKind === 'physical'));
  });

  it('parses unqualified CREATE TABLE with defaultSchema', () => {
    const result = parseSqlDdl(
      `CREATE TABLE products (
        id BIGINT NOT NULL,
        name VARCHAR(100) NULL,
        PRIMARY KEY (id)
      );`,
      { defaultSchema: 'shop' }
    );
    assert.equal(result.tables[0]?.id, 'shop.products');
    assert.equal(result.tables[0]?.columns?.length, 2);
  });
});

describe('parseDbml', () => {
  it('round-trips exported DBML', () => {
    const dbml = exportDbml(sampleTables);
    const result = parseDbml(dbml, { defaultSchema: 'app' });
    assert.equal(result.tables.length, 2);
    assert.ok(result.tables.some((t) => t.id === 'app.users'));
    assert.ok(
      result.tables
        .find((t) => t.id === 'app.orders')
        ?.foreignKeys?.some((fk) => fk.referencedTable === 'users')
    );
  });

  it('parses common dbdiagram Ref syntax', () => {
    const dbml = `
Table users {
  id int [pk]
  email varchar(255)
}
Table orders {
  id int [pk]
  user_id int [not null]
}
Ref: orders.user_id > users.id
`;
    const result = parseDbml(dbml, { defaultSchema: 'public' });
    assert.equal(result.tables.length, 2);
    const orders = result.tables.find((t) => t.name === 'orders');
    assert.equal(orders?.foreignKeys?.[0]?.referencedTable, 'users');
    assert.equal(orders?.foreignKeys?.[0]?.columns[0], 'user_id');
  });
});

describe('parseJsonPackage', () => {
  it('imports erd-workbench-package', () => {
    const catalog: CatalogSnapshot = {
      connectionId: 'c1',
      fetchedAt: new Date().toISOString(),
      schemas: ['app'],
      tables: sampleTables,
      syncStatus: 'pristine',
      hashes: {},
    };
    const json = exportJsonPackage(catalog);
    const result = parseJsonPackage(json);
    assert.equal(result.tables.length, 2);
    assert.equal(result.format, 'json');
  });

  it('imports bare tables array', () => {
    const result = parseJsonPackage(JSON.stringify({ tables: sampleTables }));
    assert.equal(result.tables.length, 2);
  });
});

describe('importAndBuildDiagram', () => {
  it('builds a private diagram with schema snapshot', () => {
    const imported = importSchemaContent(exportDbml(sampleTables), 'dbml', {
      defaultSchema: 'app',
    });
    const doc = buildDiagramFromImport(imported, { connectionId: 'conn_x', pageSize: 40 });
    assert.equal(doc.connectionId, 'conn_x');
    assert.equal(doc.nodes.length, 2);
    assert.equal(doc.schemaSnapshot?.tables.length, 2);
    assert.ok(doc.edges.length >= 1);
  });
});
