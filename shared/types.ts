/** Shared types between extension host and webview. */

export const ERD_FORMAT_VERSION = 1 as const;

export type SslMode =
  | 'disable'
  | 'preferred'
  | 'required'
  | 'verify-ca'
  | 'verify-identity';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  sslMode: SslMode;
  sslCaPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  defaultSchema?: string;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface ColumnMeta {
  name: string;
  ordinalPosition: number;
  dataType: string;
  columnType: string;
  isNullable: boolean;
  columnKey: string;
  extra: string;
  columnDefault: string | null;
  comment?: string;
}

export interface IndexMeta {
  name: string;
  tableId: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  type?: string;
}

export interface ForeignKeyMeta {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface ConstraintMeta {
  name: string;
  tableId: string;
  type: string;
  columns: string[];
  checkClause?: string;
}

export interface TableMeta {
  id: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
  engine?: string;
  comment?: string;
  columns?: ColumnMeta[];
  indexes?: IndexMeta[];
  foreignKeys?: ForeignKeyMeta[];
  constraints?: ConstraintMeta[];
  contentHash?: string;
  columnsHydrated?: boolean;
}

export type SyncStatus = 'pristine' | 'stale' | 'incomplete' | 'error' | 'syncing';

export interface CatalogSnapshot {
  connectionId: string;
  fetchedAt: string;
  schemas: string[];
  tables: TableMeta[];
  syncStatus: SyncStatus;
  syncMessage?: string;
  /** Per-object content hashes keyed by table id */
  hashes: Record<string, string>;
}

export type RelationshipKind = 'physical' | 'visual' | 'inferred';
export type Cardinality = '1:1' | '1:N' | 'N:M';

export interface DiagramEdge {
  id: string;
  sourceTableId: string;
  targetTableId: string;
  sourceColumns: string[];
  targetColumns: string[];
  cardinality: Cardinality;
  relationshipKind: RelationshipKind;
  constraintName?: string;
  junctionTableId?: string;
  label?: string;
  hidden?: boolean;
}

export interface DiagramNodeLayout {
  tableId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  pinned?: boolean;
  groupId?: string;
  orphaned?: boolean;
}

export interface DiagramGroup {
  id: string;
  name: string;
  collapsed: boolean;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DiagramViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface DiagramFilters {
  schemas?: string[];
  search?: string;
  hideUnconnected?: boolean;
  showInferred?: boolean;
  showViews?: boolean;
  groupIds?: string[];
  /** Large-schema paging: show one page of tables at a time */
  pageIndex?: number;
  pageSize?: number;
  /** When true, only nodes on the active page are considered "focused" */
  pageMode?: boolean;
}

export interface SchemaObjectSnapshot {
  tables: TableMeta[];
  capturedAt: string;
}

export interface ErdDocument {
  erdFormatVersion: typeof ERD_FORMAT_VERSION;
  diagramId: string;
  name: string;
  connectionId: string;
  schemas: string[];
  nodes: DiagramNodeLayout[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  viewport: DiagramViewport;
  filters: DiagramFilters;
  /** Last known schema snapshot for diff */
  schemaSnapshot?: SchemaObjectSnapshot;
  updatedAt: string;
}

export type SqlRiskClass = 'read' | 'write' | 'destructive' | 'unknown';

export interface ClassifiedStatement {
  index: number;
  sql: string;
  risk: SqlRiskClass;
  statementType?: string;
  affectedObjects: string[];
  notes?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  risk: SqlRiskClass;
  statements: ClassifiedStatement[];
  reason?: string;
  previewSql: string;
}

export interface MutationPlan {
  proposalId: string;
  connectionId: string;
  title: string;
  intent: string;
  sql: string;
  risk: SqlRiskClass;
  expectedDiff: SchemaDiff;
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalRecord {
  approvalToken: string;
  proposalId: string;
  contentHash: string;
  connectionId: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

export type DiffChangeType = 'added' | 'removed' | 'changed';

export interface SchemaDiffItem {
  objectType: 'table' | 'view' | 'column' | 'pk' | 'fk' | 'index' | 'constraint';
  objectId: string;
  change: DiffChangeType;
  before?: unknown;
  after?: unknown;
  summary: string;
}

export interface SchemaDiff {
  connectionId: string;
  comparedAt: string;
  items: SchemaDiffItem[];
}

/** Structured SQL runner result (host + results webview). */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  affectedRows?: number;
  truncated: boolean;
  risk: SqlRiskClass;
  statementSql?: string;
  durationMs?: number;
}

export type SqlRunStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface SqlRunSnapshot {
  runId: string;
  connectionId: string;
  connectionName: string;
  sqlPreview: string;
  status: SqlRunStatus;
  startedAt: string;
  finishedAt?: string;
  results: QueryResult[];
  error?: string;
  totalDurationMs?: number;
}

/** Host ↔ SQL Results webview protocol (separate from ERD editor). */
export type SqlResultsHostMessage =
  | { type: 'init'; theme: 'light' | 'dark'; run?: SqlRunSnapshot }
  | { type: 'runStarted'; run: SqlRunSnapshot }
  | { type: 'runProgress'; runId: string; message: string }
  | { type: 'runCompleted'; run: SqlRunSnapshot }
  | { type: 'runError'; run: SqlRunSnapshot }
  | { type: 'runCancelled'; run: SqlRunSnapshot }
  | { type: 'theme'; theme: 'light' | 'dark' };

export type SqlResultsWebviewMessage =
  | { type: 'ready' }
  | { type: 'cancelRun'; runId: string }
  | { type: 'copyTsv'; resultIndex: number };

/** Host ↔ webview protocol */
export type HostToWebviewMessage =
  | { type: 'init'; document: ErdDocument; catalogSummary: CatalogTableSummary[]; theme: 'light' | 'dark' }
  | { type: 'documentChanged'; document: ErdDocument; version: number }
  | { type: 'catalogPatch'; patch: CatalogPatch }
  | { type: 'hydrateColumns'; tableId: string; columns: ColumnMeta[]; indexes: IndexMeta[]; foreignKeys: ForeignKeyMeta[] }
  | { type: 'layoutResult'; nodes: DiagramNodeLayout[] }
  | { type: 'error'; message: string };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'updateDocument'; document: ErdDocument; reason: string }
  | { type: 'requestHydrate'; tableId: string }
  | { type: 'requestAutoLayout'; tableIds: string[] }
  | { type: 'createRelationship'; edge: Omit<DiagramEdge, 'id'>; mode: 'visual' | 'physical' }
  | { type: 'editTable'; tableId: string; action: string; payload: unknown }
  | { type: 'proposeInferredAction'; edgeId: string; action: 'accept-visual' | 'promote-physical' | 'reject' }
  | { type: 'exportRequest'; format: 'json' | 'sql' | 'dbml' };

export interface CatalogTableSummary {
  id: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
  pkCols: string[];
  fkCount: number;
  columnCount: number;
}

export interface CatalogPatch {
  tablesAdded: CatalogTableSummary[];
  tablesRemoved: string[];
  tablesChanged: CatalogTableSummary[];
  edgesAdded: DiagramEdge[];
  edgesRemoved: string[];
  edgesChanged: DiagramEdge[];
}

export function tableId(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export function createEmptyDiagram(
  connectionId: string,
  schemas: string[],
  name = 'Untitled Diagram'
): ErdDocument {
  const now = new Date().toISOString();
  return {
    erdFormatVersion: ERD_FORMAT_VERSION,
    diagramId: `diag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    connectionId,
    schemas,
    nodes: [],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    filters: { showViews: true, showInferred: false },
    updatedAt: now,
  };
}
