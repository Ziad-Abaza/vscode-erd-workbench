import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAddFkColumnsAndConstraintSql,
  buildNmJunctionSql,
  buildPhysicalFkSql,
  defaultReferencedColumns,
  suggestFkColumnName,
  suggestJunctionName,
} from '../../src/mutation/relationshipDdl';
import { SqlParserService } from '../../src/sql/parser/SqlParserService';

describe('relationshipDdl', () => {
  it('suggests FK and junction names', () => {
    assert.equal(suggestFkColumnName('users', 'id'), 'users_id');
    assert.equal(suggestFkColumnName('users', 'uuid'), 'users_uuid');
    assert.equal(suggestJunctionName('students', 'courses'), 'students_courses');
  });

  it('defaults to primary key columns', () => {
    assert.deepEqual(
      defaultReferencedColumns({
        indexes: [{ primary: true, unique: true, columns: ['id'] }],
        columns: [{ name: 'id', columnKey: 'PRI' }],
      }),
      ['id']
    );
  });

  it('builds physical FK with referential actions', () => {
    const sql = buildPhysicalFkSql({
      schema: 'app',
      table: 'orders',
      constraintName: 'fk_orders_users',
      columns: ['user_id'],
      refSchema: 'app',
      refTable: 'users',
      refColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'RESTRICT',
    });
    assert.match(sql, /ALTER TABLE `app`\.`orders`/);
    assert.match(sql, /FOREIGN KEY \(`user_id`\) REFERENCES `app`\.`users` \(`id`\)/);
    assert.match(sql, /ON DELETE CASCADE ON UPDATE RESTRICT;/);
  });

  it('builds ADD COLUMN + FK in one ALTER', () => {
    const sql = buildAddFkColumnsAndConstraintSql({
      schema: 'app',
      table: 'orders',
      newColumns: [{ name: 'user_id', columnType: 'INT UNSIGNED', isNullable: false }],
      constraintName: 'fk_orders_users_user_id',
      fkColumns: ['user_id'],
      refSchema: 'app',
      refTable: 'users',
      refColumns: ['id'],
      onDelete: 'RESTRICT',
    });
    assert.match(sql, /ADD COLUMN `user_id` INT UNSIGNED NOT NULL/);
    assert.match(sql, /ADD CONSTRAINT `fk_orders_users_user_id`/);
    assert.match(sql, /FOREIGN KEY \(`user_id`\)/);
  });

  it('builds N:M junction with catalog column types (not hardcoded INT)', () => {
    const sql = buildNmJunctionSql({
      schema: 'app',
      junctionName: 'students_courses',
      left: {
        columns: ['student_id'],
        refColumns: ['id'],
        columnTypes: ['BIGINT UNSIGNED'],
        refSchema: 'app',
        refTable: 'students',
        constraintName: 'fk_students_courses_students',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      right: {
        columns: ['course_uuid'],
        refColumns: ['uuid'],
        columnTypes: ['CHAR(36)'],
        refSchema: 'app',
        refTable: 'courses',
        constraintName: 'fk_students_courses_courses',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
    });
    assert.match(sql, /CREATE TABLE `app`\.`students_courses`/);
    assert.match(sql, /`student_id` BIGINT UNSIGNED NOT NULL/);
    assert.match(sql, /`course_uuid` CHAR\(36\) NOT NULL/);
    assert.match(sql, /PRIMARY KEY \(`student_id`, `course_uuid`\)/);
    assert.match(sql, /REFERENCES `app`\.`students` \(`id`\) ON DELETE CASCADE ON UPDATE CASCADE/);
    assert.match(sql, /REFERENCES `app`\.`courses` \(`uuid`\) ON DELETE CASCADE ON UPDATE CASCADE/);
    assert.doesNotMatch(sql, /`student_id` INT NOT NULL/);
  });

  it('classifies FK ALTER as write and CREATE junction as write', () => {
    const parser = new SqlParserService();
    const fk = parser.splitAndClassify(
      buildPhysicalFkSql({
        schema: 's',
        table: 'a',
        constraintName: 'fk_a_b',
        columns: ['b_id'],
        refSchema: 's',
        refTable: 'b',
        refColumns: ['id'],
      })
    );
    assert.equal(fk.ok, true);
    assert.equal(fk.statements[0]?.risk, 'write');

    const nm = parser.splitAndClassify(
      buildNmJunctionSql({
        schema: 's',
        junctionName: 'a_b',
        left: {
          columns: ['a_id'],
          refColumns: ['id'],
          columnTypes: ['INT'],
          refSchema: 's',
          refTable: 'a',
          constraintName: 'fk_a_b_a',
        },
        right: {
          columns: ['b_id'],
          refColumns: ['id'],
          columnTypes: ['INT'],
          refSchema: 's',
          refTable: 'b',
          constraintName: 'fk_a_b_b',
        },
      })
    );
    assert.equal(nm.ok, true);
    assert.equal(nm.statements[0]?.risk, 'write');
  });
});
