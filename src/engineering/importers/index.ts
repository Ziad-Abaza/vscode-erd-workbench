import { buildDiagramFromImport } from './buildDiagramFromImport';
import { parseDbml } from './parseDbml';
import { parseJsonPackage } from './parseJsonPackage';
import { parseSqlDdl } from './parseSqlDdl';
import type { ImportFormat, ImportOptions, SchemaImportResult } from './types';

export type { ImportFormat, ImportOptions, SchemaImportResult } from './types';
export { buildDiagramFromImport } from './buildDiagramFromImport';
export { parseDbml } from './parseDbml';
export { parseJsonPackage } from './parseJsonPackage';
export { parseSqlDdl } from './parseSqlDdl';

export function detectImportFormat(
  content: string,
  fileNameHint?: string
): ImportFormat | undefined {
  const name = (fileNameHint ?? '').toLowerCase();
  if (name.endsWith('.sql')) {
    return 'sql';
  }
  if (name.endsWith('.dbml')) {
    return 'dbml';
  }
  if (name.endsWith('.json') || name.endsWith('.erd.json')) {
    return 'json';
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (/^\s*Table\s+/im.test(trimmed) || /^\s*Ref\s*:/im.test(trimmed)) {
    return 'dbml';
  }
  if (
    /^\s*(CREATE|ALTER|DROP|USE|SET|INSERT|REPLACE)\b/im.test(trimmed) ||
    /`?\w+`?\s*\.\s*`?\w+`?/m.test(trimmed) && /CREATE\s+TABLE/i.test(trimmed)
  ) {
    return 'sql';
  }
  return undefined;
}

export function importSchemaContent(
  content: string,
  format: ImportFormat,
  options: ImportOptions = {}
): SchemaImportResult {
  switch (format) {
    case 'json':
      return parseJsonPackage(content, options);
    case 'sql':
      return parseSqlDdl(content, options);
    case 'dbml':
      return parseDbml(content, options);
    default:
      throw new Error(`Unsupported import format: ${String(format)}`);
  }
}

export function importAndBuildDiagram(
  content: string,
  format: ImportFormat,
  options: ImportOptions & { name?: string; pageSize?: number } = {}
) {
  const imported = importSchemaContent(content, format, options);
  const document = buildDiagramFromImport(imported, {
    connectionId: options.connectionId,
    name: options.name,
    pageSize: options.pageSize,
  });
  return { imported, document };
}
