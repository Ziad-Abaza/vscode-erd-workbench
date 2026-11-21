import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqlParserService } from '../../src/sql/parser/SqlParserService';

describe('SqlParserService', () => {
  const parser = new SqlParserService();

  it('classifies SELECT as read', () => {
    const r = parser.splitAndClassify('SELECT id FROM users WHERE active = 1');
    assert.equal(r.ok, true);
    assert.equal(r.statements[0]?.risk, 'read');
  });

  it('classifies DELETE as destructive even with WHERE', () => {
    const r = parser.splitAndClassify('DELETE FROM users WHERE id = 1');
    assert.equal(r.ok, true);
    assert.equal(r.statements[0]?.risk, 'destructive');
  });

  it('does not treat commented DROP as executable DROP', () => {
    const r = parser.splitAndClassify('SELECT 1; -- DROP TABLE users');
    assert.equal(r.ok, true);
    assert.ok(r.statements.every((s) => s.risk === 'read'));
  });

  it('fail-closes on unparseable SQL', () => {
    const r = parser.splitAndClassify('NOT VALID SQL ((((');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /fail-closed|parse failed/i);
  });

  it('classifies DROP as destructive', () => {
    const r = parser.splitAndClassify('DROP TABLE users');
    assert.equal(r.ok, true);
    assert.equal(r.statements[0]?.risk, 'destructive');
  });

  it('classifies INSERT as write', () => {
    const r = parser.splitAndClassify("INSERT INTO users (name) VALUES ('a')");
    assert.equal(r.ok, true);
    assert.equal(r.statements[0]?.risk, 'write');
  });

  it('classifies PREPARE as unknown / fail-closed', () => {
    const r = parser.splitAndClassify("PREPARE stmt FROM 'SELECT 1'");
    // Either unparseable or unknown risk → ok false
    if (r.ok) {
      assert.equal(r.statements[0]?.risk, 'unknown');
    } else {
      assert.equal(r.ok, false);
    }
  });
});
