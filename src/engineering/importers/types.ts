import type { DiagramEdge, ErdDocument, TableMeta } from '../../../shared/types';

export type ImportFormat = 'json' | 'sql' | 'dbml';

export interface SchemaImportResult {
  format: ImportFormat;
  tables: TableMeta[];
  /** Physical (+ visual when present in source) */
  edges: DiagramEdge[];
  /** Full diagram when JSON package / .erd.json included one */
  diagram?: ErdDocument | null;
  schemas: string[];
  warnings: string[];
  nameHint?: string;
}

export interface ImportOptions {
  /** Schema for unqualified table names (SQL/DBML) */
  defaultSchema?: string;
  /** Override diagram connectionId when opening */
  connectionId?: string;
}
