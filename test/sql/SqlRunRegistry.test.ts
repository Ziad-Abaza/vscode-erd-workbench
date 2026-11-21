import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqlRunRegistry } from '../../src/sql/execution/SqlRunRegistry';
import { QueryCancelledError, isQueryCancelledError } from '../../src/sql/execution/QueryCancelledError';

describe('SqlRunRegistry', () => {
  it('creates, tracks, and completes runs', () => {
    const registry = new SqlRunRegistry();
    const run = registry.create('conn_a');
    assert.equal(registry.size, 1);
    assert.equal(registry.get(run.runId)?.connectionId, 'conn_a');
    assert.equal(registry.getLatest()?.runId, run.runId);
    registry.complete(run.runId);
    assert.equal(registry.size, 0);
  });

  it('cancels the latest run via AbortController', () => {
    const registry = new SqlRunRegistry();
    const first = registry.create('conn_a');
    const second = registry.create('conn_b');
    assert.equal(registry.cancelLatest(), true);
    assert.equal(second.controller.signal.aborted, true);
    assert.equal(first.controller.signal.aborted, false);
    assert.equal(registry.cancel(first.runId), true);
    assert.equal(first.controller.signal.aborted, true);
    registry.dispose();
    assert.equal(registry.size, 0);
  });

  it('returns false when nothing to cancel', () => {
    const registry = new SqlRunRegistry();
    assert.equal(registry.cancelLatest(), false);
    assert.equal(registry.cancel('missing'), false);
  });
});

describe('QueryCancelledError', () => {
  it('is detected by type guard', () => {
    assert.equal(isQueryCancelledError(new QueryCancelledError()), true);
    assert.equal(isQueryCancelledError(new Error('other')), false);
    assert.equal(isQueryCancelledError({ code: 'QUERY_CANCELLED', name: 'QueryCancelledError', message: 'x' }), false);
  });
});
