import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  autoGroupBySchema,
  createGroup,
  dissolveGroup,
  groupNodeId,
  isHiddenByCollapsedGroup,
  layoutSwimlanes,
  remapEdgeForCollapse,
  toggleGroupCollapsed,
} from '../../shared/groups';
import {
  ERD_FORMAT_VERSION,
  type DiagramEdge,
  type ErdDocument,
} from '../../shared/types';

function doc(partial?: Partial<ErdDocument>): ErdDocument {
  return {
    erdFormatVersion: ERD_FORMAT_VERSION,
    diagramId: 'd1',
    name: 'test',
    connectionId: 'c1',
    schemas: ['app', 'auth'],
    nodes: [
      { tableId: 'app.orders', x: 0, y: 0 },
      { tableId: 'app.items', x: 260, y: 0 },
      { tableId: 'auth.users', x: 0, y: 200 },
    ],
    edges: [
      {
        id: 'e1',
        sourceTableId: 'app.orders',
        targetTableId: 'auth.users',
        sourceColumns: ['user_id'],
        targetColumns: ['id'],
        cardinality: '1:N',
        relationshipKind: 'physical',
      },
      {
        id: 'e2',
        sourceTableId: 'app.items',
        targetTableId: 'app.orders',
        sourceColumns: ['order_id'],
        targetColumns: ['id'],
        cardinality: '1:N',
        relationshipKind: 'physical',
      },
    ],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    filters: {},
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('diagram groups / swimlanes', () => {
  it('createGroup assigns members and computes bounds', () => {
    const next = createGroup(doc(), 'Orders', ['app.orders', 'app.items']);
    assert.equal(next.groups.length, 1);
    assert.equal(next.groups[0].name, 'Orders');
    assert.equal(next.groups[0].collapsed, false);
    assert.ok((next.groups[0].width ?? 0) > 0);
    assert.equal(next.nodes.filter((n) => n.groupId === next.groups[0].id).length, 2);
  });

  it('toggle collapse hides members and remaps cross-group edges', () => {
    let next = createGroup(doc(), 'App', ['app.orders', 'app.items']);
    const gid = next.groups[0].id;
    next = toggleGroupCollapsed(next, gid);
    assert.equal(next.groups[0].collapsed, true);
    assert.equal(isHiddenByCollapsedGroup(next, 'app.orders'), true);
    assert.equal(isHiddenByCollapsedGroup(next, 'auth.users'), false);

    const cross = remapEdgeForCollapse(next, next.edges[0]);
    assert.equal(cross.hide, false);
    assert.equal(cross.sourceId, groupNodeId(gid));
    assert.equal(cross.targetId, 'auth.users');

    const internal = remapEdgeForCollapse(next, next.edges[1]);
    assert.equal(internal.hide, true);
  });

  it('dissolveGroup clears membership', () => {
    let next = createGroup(doc(), 'App', ['app.orders']);
    const gid = next.groups[0].id;
    next = dissolveGroup(next, gid);
    assert.equal(next.groups.length, 0);
    assert.equal(next.nodes.find((n) => n.tableId === 'app.orders')?.groupId, undefined);
  });

  it('autoGroupBySchema creates one lane per schema', () => {
    const next = autoGroupBySchema(doc());
    assert.equal(next.groups.length, 2);
    assert.ok(next.groups.every((g) => g.id.startsWith('grp_schema_')));
    assert.equal(next.nodes.find((n) => n.tableId === 'auth.users')?.groupId, 'grp_schema_auth');
  });

  it('layoutSwimlanes stacks groups vertically', () => {
    let next = autoGroupBySchema(doc());
    next = layoutSwimlanes(next);
    const appY = next.groups.find((g) => g.name === 'app')?.y ?? 0;
    const authY = next.groups.find((g) => g.name === 'auth')?.y ?? 0;
    assert.ok(appY !== authY || next.groups.length < 2);
    // Members moved into lane bands
    const orders = next.nodes.find((n) => n.tableId === 'app.orders')!;
    const users = next.nodes.find((n) => n.tableId === 'auth.users')!;
    assert.ok(orders.y !== users.y);
  });

  it('remap hides self-loop when both ends collapse to same proxy', () => {
    const edge: DiagramEdge = {
      id: 'loop',
      sourceTableId: 'app.orders',
      targetTableId: 'app.items',
      sourceColumns: [],
      targetColumns: [],
      cardinality: '1:N',
      relationshipKind: 'visual',
    };
    let next = createGroup(doc({ edges: [edge] }), 'G', ['app.orders', 'app.items']);
    next = toggleGroupCollapsed(next, next.groups[0].id);
    assert.equal(remapEdgeForCollapse(next, edge).hide, true);
  });
});
