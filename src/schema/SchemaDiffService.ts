import type {
  CatalogSnapshot,
  ErdDocument,
  SchemaDiff,
  SchemaDiffItem,
  SchemaObjectSnapshot,
  TableMeta,
} from '../../shared/types';

export class SchemaDiffService {
  diffCatalogs(connectionId: string, before: TableMeta[], after: TableMeta[]): SchemaDiff {
    const beforeMap = new Map(before.map((t) => [t.id, t]));
    const afterMap = new Map(after.map((t) => [t.id, t]));
    const items: SchemaDiffItem[] = [];

    for (const [id, a] of afterMap) {
      const b = beforeMap.get(id);
      if (!b) {
        items.push({
          objectType: a.kind === 'view' ? 'view' : 'table',
          objectId: id,
          change: 'added',
          after: a,
          summary: `Added ${a.kind} ${id}`,
        });
        continue;
      }
      items.push(...diffTable(b, a));
    }
    for (const [id, b] of beforeMap) {
      if (!afterMap.has(id)) {
        items.push({
          objectType: b.kind === 'view' ? 'view' : 'table',
          objectId: id,
          change: 'removed',
          before: b,
          summary: `Removed ${b.kind} ${id}`,
        });
      }
    }

    return {
      connectionId,
      comparedAt: new Date().toISOString(),
      items,
    };
  }

  diffAgainstSnapshot(doc: ErdDocument, catalog: CatalogSnapshot): SchemaDiff {
    const snap: SchemaObjectSnapshot = doc.schemaSnapshot ?? {
      tables: [],
      capturedAt: doc.updatedAt,
    };
    const relevant = catalog.tables.filter(
      (t) => !doc.schemas.length || doc.schemas.includes(t.schema)
    );
    return this.diffCatalogs(doc.connectionId, snap.tables, relevant);
  }
}

function diffTable(before: TableMeta, after: TableMeta): SchemaDiffItem[] {
  const items: SchemaDiffItem[] = [];
  if (before.contentHash && after.contentHash && before.contentHash === after.contentHash) {
    return items;
  }

  const bc = new Map((before.columns ?? []).map((c) => [c.name, c]));
  const ac = new Map((after.columns ?? []).map((c) => [c.name, c]));
  for (const [name, col] of ac) {
    const prev = bc.get(name);
    if (!prev) {
      items.push({
        objectType: 'column',
        objectId: `${after.id}.${name}`,
        change: 'added',
        after: col,
        summary: `Added column ${after.id}.${name}`,
      });
    } else if (JSON.stringify(prev) !== JSON.stringify(col)) {
      items.push({
        objectType: 'column',
        objectId: `${after.id}.${name}`,
        change: 'changed',
        before: prev,
        after: col,
        summary: `Changed column ${after.id}.${name}`,
      });
    }
  }
  for (const [name, col] of bc) {
    if (!ac.has(name)) {
      items.push({
        objectType: 'column',
        objectId: `${before.id}.${name}`,
        change: 'removed',
        before: col,
        summary: `Removed column ${before.id}.${name}`,
      });
    }
  }

  const bf = new Map((before.foreignKeys ?? []).map((f) => [f.name, f]));
  const af = new Map((after.foreignKeys ?? []).map((f) => [f.name, f]));
  for (const [name, fk] of af) {
    const prev = bf.get(name);
    if (!prev) {
      items.push({
        objectType: 'fk',
        objectId: `${after.id}.${name}`,
        change: 'added',
        after: fk,
        summary: `Added FK ${name} on ${after.id}`,
      });
    } else if (JSON.stringify(prev) !== JSON.stringify(fk)) {
      items.push({
        objectType: 'fk',
        objectId: `${after.id}.${name}`,
        change: 'changed',
        before: prev,
        after: fk,
        summary: `Changed FK ${name} on ${after.id}`,
      });
    }
  }
  for (const [name, fk] of bf) {
    if (!af.has(name)) {
      items.push({
        objectType: 'fk',
        objectId: `${before.id}.${name}`,
        change: 'removed',
        before: fk,
        summary: `Removed FK ${name} on ${before.id}`,
      });
    }
  }

  const bi = new Map((before.indexes ?? []).map((i) => [i.name, i]));
  const ai = new Map((after.indexes ?? []).map((i) => [i.name, i]));
  for (const [name, idx] of ai) {
    const prev = bi.get(name);
    if (!prev) {
      items.push({
        objectType: idx.primary ? 'pk' : 'index',
        objectId: `${after.id}.${name}`,
        change: 'added',
        after: idx,
        summary: `Added ${idx.primary ? 'PK' : 'index'} ${name} on ${after.id}`,
      });
    } else if (JSON.stringify(prev) !== JSON.stringify(idx)) {
      items.push({
        objectType: idx.primary ? 'pk' : 'index',
        objectId: `${after.id}.${name}`,
        change: 'changed',
        before: prev,
        after: idx,
        summary: `Changed ${idx.primary ? 'PK' : 'index'} ${name} on ${after.id}`,
      });
    }
  }
  for (const [name, idx] of bi) {
    if (!ai.has(name)) {
      items.push({
        objectType: idx.primary ? 'pk' : 'index',
        objectId: `${before.id}.${name}`,
        change: 'removed',
        before: idx,
        summary: `Removed ${idx.primary ? 'PK' : 'index'} ${name} on ${before.id}`,
      });
    }
  }

  if (!items.length && before.contentHash !== after.contentHash) {
    items.push({
      objectType: before.kind === 'view' ? 'view' : 'table',
      objectId: after.id,
      change: 'changed',
      before,
      after,
      summary: `Changed ${after.kind} ${after.id}`,
    });
  }
  return items;
}
