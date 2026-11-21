import type { DiagramEdge, TableMeta } from '../../shared/types';
import { tableId } from '../../shared/types';

/**
 * Suggests possible relationships when no FK exists.
 * Always marked relationshipKind: 'inferred' — never auto-applied as physical.
 */
export function suggestInferredRelationships(
  tables: TableMeta[],
  existing: DiagramEdge[]
): DiagramEdge[] {
  const existingKeys = new Set(
    existing.map(
      (e) => `${e.sourceTableId}->${e.targetTableId}:${e.sourceColumns.join(',')}`
    )
  );
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const suggestions: DiagramEdge[] = [];

  for (const t of tables) {
    for (const col of t.columns ?? []) {
      if (col.columnKey === 'PRI') {
        continue;
      }
      const m = /^(.*?)_id$/i.exec(col.name);
      if (!m) {
        continue;
      }
      const base = m[1].toLowerCase();
      const candidates = [
        byName.get(base),
        byName.get(`${base}s`),
        byName.get(pluralize(base)),
      ].filter(Boolean) as TableMeta[];

      for (const target of candidates) {
        if (target.id === t.id) {
          continue;
        }
        const pk = target.columns?.find((c) => c.columnKey === 'PRI' || c.name === 'id');
        if (!pk) {
          continue;
        }
        // Type compatibility (loose)
        if (normalizeType(col.dataType) !== normalizeType(pk.dataType)) {
          continue;
        }
        const key = `${t.id}->${target.id}:${col.name}`;
        if (existingKeys.has(key)) {
          continue;
        }
        // Skip if physical FK already covers
        if (
          (t.foreignKeys ?? []).some(
            (fk) =>
              tableId(fk.referencedSchema, fk.referencedTable) === target.id &&
              fk.columns.includes(col.name)
          )
        ) {
          continue;
        }
        suggestions.push({
          id: `inferred:${t.id}:${col.name}:${target.id}`,
          sourceTableId: t.id,
          targetTableId: target.id,
          sourceColumns: [col.name],
          targetColumns: [pk.name],
          cardinality: '1:N',
          relationshipKind: 'inferred',
          label: `suggested: ${col.name}`,
        });
        existingKeys.add(key);
      }
    }
  }
  return suggestions;
}

function pluralize(s: string): string {
  if (s.endsWith('y')) {
    return `${s.slice(0, -1)}ies`;
  }
  if (s.endsWith('s')) {
    return s;
  }
  return `${s}s`;
}

function normalizeType(t: string): string {
  const x = t.toLowerCase();
  if (x.includes('int')) {
    return 'int';
  }
  if (x.includes('char') || x.includes('text')) {
    return 'string';
  }
  if (x.includes('uuid')) {
    return 'uuid';
  }
  return x;
}
