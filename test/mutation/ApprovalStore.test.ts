import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalStore, contentHashForPlan } from '../../src/mutation/ApprovalStore';
import type { MutationPlan } from '../../shared/types';

function plan(sql: string): MutationPlan {
  return {
    proposalId: 'prop_1',
    connectionId: 'conn_1',
    title: 't',
    intent: 'i',
    sql,
    risk: 'destructive',
    expectedDiff: { connectionId: 'conn_1', comparedAt: new Date().toISOString(), items: [] },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('ApprovalStore', () => {
  it('binds approval to exact SQL content', () => {
    const store = new ApprovalStore();
    const p = plan('DROP TABLE users;');
    const token = store.issue(p).approvalToken;
    const ok = store.consume(token, p);
    assert.equal(ok.ok, true);
  });

  it('invalidates when SQL changes', () => {
    const store = new ApprovalStore();
    const p = plan('DROP TABLE users;');
    const token = store.issue(p).approvalToken;
    const changed = { ...p, sql: 'DROP TABLE orders;' };
    assert.notEqual(contentHashForPlan(p), contentHashForPlan(changed));
    const result = store.consume(token, changed);
    assert.equal(result.ok, false);
  });

  it('is single-use', () => {
    const store = new ApprovalStore();
    const p = plan('DROP TABLE users;');
    const token = store.issue(p).approvalToken;
    assert.equal(store.consume(token, p).ok, true);
    assert.equal(store.consume(token, p).ok, false);
  });
});
