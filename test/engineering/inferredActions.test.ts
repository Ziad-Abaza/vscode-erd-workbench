import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyInferredAcceptVisual,
  applyInferredReject,
  countVisibleInferred,
  findInferredEdge,
  formatInferredMapping,
} from '../../shared/inferredActions';
import {
  ERD_FORMAT_VERSION,
  type DiagramEdge,
  type ErdDocument,
} from '../../shared/types';

function sampleDoc(edges: DiagramEdge[]): ErdDocument {
  return {
    erdFormatVersion: ERD_FORMAT_VERSION,
    diagramId: 'test',
    name: 'test',
    connectionId: 'conn-1',
    schemas: ['app'],
    nodes: [
      { tableId: 'app.orders', x: 0, y: 0 },
      { tableId: 'app.users', x: 200, y: 0 },
    ],
    edges,
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    filters: {},
    updatedAt: '2020-01-01T00:00:00.000Z',
  };
}

const inferredEdge: DiagramEdge = {
  id: 'inferred:app.orders:user_id:app.users',
  sourceTableId: 'app.orders',
  targetTableId: 'app.users',
  sourceColumns: ['user_id'],
  targetColumns: ['id'],
  cardinality: '1:N',
  relationshipKind: 'inferred',
  label: 'suggested: user_id',
};

describe('inferredActions', () => {
  it('findInferredEdge only returns inferred edges', () => {
    const physical: DiagramEdge = {
      ...inferredEdge,
      id: 'fk:app.orders:fk_orders_users',
      relationshipKind: 'physical',
      label: 'user_id',
    };
    const doc = sampleDoc([inferredEdge, physical]);
    assert.equal(findInferredEdge(doc, inferredEdge.id)?.id, inferredEdge.id);
    assert.equal(findInferredEdge(doc, physical.id), undefined);
    assert.equal(findInferredEdge(doc, 'missing'), undefined);
  });

  it('accept-visual promotes kind and strips suggested: prefix', () => {
    const next = applyInferredAcceptVisual(sampleDoc([inferredEdge]), inferredEdge.id);
    const edge = next.edges[0];
    assert.equal(edge.relationshipKind, 'visual');
    assert.equal(edge.label, 'user_id');
    assert.ok(next.updatedAt !== '2020-01-01T00:00:00.000Z');
  });

  it('accept-visual is a no-op for non-matching ids', () => {
    const doc = sampleDoc([inferredEdge]);
    const next = applyInferredAcceptVisual(doc, 'other-id');
    assert.equal(next.edges[0].relationshipKind, 'inferred');
  });

  it('reject hides the inferred edge', () => {
    const next = applyInferredReject(sampleDoc([inferredEdge]), inferredEdge.id);
    assert.equal(next.edges[0].hidden, true);
    assert.equal(next.edges[0].relationshipKind, 'inferred');
  });

  it('countVisibleInferred ignores hidden and non-inferred', () => {
    const doc = sampleDoc([
      inferredEdge,
      { ...inferredEdge, id: 'inf-2', hidden: true },
      {
        ...inferredEdge,
        id: 'vis-1',
        relationshipKind: 'visual',
        label: 'user_id',
      },
    ]);
    assert.equal(countVisibleInferred(doc), 1);
  });

  it('formatInferredMapping uses short table.column form', () => {
    assert.equal(formatInferredMapping(inferredEdge), 'orders.user_id → users.id');
  });
});
