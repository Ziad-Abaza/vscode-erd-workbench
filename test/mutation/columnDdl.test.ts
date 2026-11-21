import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAddColumnSql,
  buildColumnDefinition,
  buildDropColumnSql,
  buildModifyColumnSql,
  formatDefaultValue,
  quoteIdent,
} from '../../src/mutation/columnDdl';
import { SqlParserService } from '../../src/sql/parser/SqlParserService';

describe('columnDdl', () => {
  it('quotes identifiers and escapes backticks', () => {
    assert.equal(quoteIdent('users'), '`users`');
    assert.equal(quoteIdent('a`b'), '`a``b`');
  });

  it('formats DEFAULT values', () => {
    assert.equal(formatDefaultValue(null), 'NULL');
    assert.equal(formatDefaultValue('0'), '0');
    assert.equal(formatDefaultValue('3.14'), '3.14');
    assert.equal(formatDefaultValue('CURRENT_TIMESTAMP'), 'CURRENT_TIMESTAMP');
    assert.equal(formatDefaultValue("hello"), "'hello'");
    assert.equal(formatDefaultValue("O'Reilly"), "'O''Reilly'");
    assert.equal(formatDefaultValue("'keep'"), "'keep'");
  });

  it('builds ADD COLUMN SQL', () => {
    const sql = buildAddColumnSql('app', 'users', {
      name: 'email',
      columnType: 'VARCHAR(255)',
      isNullable: true,
      defaultValue: null,
      position: { kind: 'after', column: 'id' },
    });
    assert.match(sql, /ALTER TABLE `app`\.`users`/);
    assert.match(sql, /ADD COLUMN `email` VARCHAR\(255\) NULL DEFAULT NULL AFTER `id`;/);
  });

  it('builds MODIFY COLUMN SQL', () => {
    const sql = buildModifyColumnSql('app', 'users', {
      name: 'email',
      columnType: 'VARCHAR(191)',
      isNullable: false,
      defaultValue: "''",
    });
    assert.match(sql, /MODIFY COLUMN `email` VARCHAR\(191\) NOT NULL DEFAULT ''/);
  });

  it('builds CHANGE COLUMN when renaming', () => {
    const sql = buildModifyColumnSql('app', 'users', {
      previousName: 'email',
      name: 'email_address',
      columnType: 'VARCHAR(255)',
      isNullable: true,
    });
    assert.match(
      sql,
      /CHANGE COLUMN `email` `email_address` VARCHAR\(255\) NULL;/
    );
  });

  it('builds DROP COLUMN SQL', () => {
    const sql = buildDropColumnSql('app', 'users', 'legacy_flag');
    assert.equal(sql, 'ALTER TABLE `app`.`users`\n  DROP COLUMN `legacy_flag`;');
  });

  it('rejects invalid column names', () => {
    assert.throws(() =>
      buildColumnDefinition({
        name: 'bad-name',
        columnType: 'INT',
        isNullable: true,
      })
    );
  });

  it('classifies ADD as write and DROP COLUMN as destructive', () => {
    const parser = new SqlParserService();
    const add = parser.splitAndClassify(
      buildAddColumnSql('s', 't', {
        name: 'c',
        columnType: 'INT',
        isNullable: true,
      })
    );
    assert.equal(add.ok, true);
    assert.equal(add.statements[0]?.risk, 'write');

    const drop = parser.splitAndClassify(buildDropColumnSql('s', 't', 'c'));
    assert.equal(drop.ok, true);
    assert.equal(drop.statements[0]?.risk, 'destructive');
  });
});
