import * as vscode from 'vscode';
import type { MutationPlan, SchemaDiff, SqlRiskClass } from '../../shared/types';
import { SchemaDiffService } from '../schema/SchemaDiffService';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { SqlExecutionService } from '../sql/execution/SqlExecutionService';
import { SqlParserService } from '../sql/parser/SqlParserService';
import { ApprovalStore, contentHashForPlan } from './ApprovalStore';

export class MutationPipeline {
  private readonly proposals = new Map<string, MutationPlan>();

  constructor(
    private readonly sql: SqlExecutionService,
    private readonly parser: SqlParserService,
    private readonly catalog: SchemaCatalogService,
    private readonly diff: SchemaDiffService,
    private readonly approvals: ApprovalStore
  ) {}

  getProposal(id: string): MutationPlan | undefined {
    return this.proposals.get(id);
  }

  propose(input: {
    connectionId: string;
    title: string;
    intent: string;
    sql: string;
    expectedDiff?: SchemaDiff;
  }): MutationPlan {
    const classified = this.parser.splitAndClassify(input.sql);
    if (!classified.ok) {
      throw new Error(classified.reason ?? 'Cannot propose unparseable SQL');
    }
    const risk = classified.statements.reduce<SqlRiskClass>((a, s) => {
      const order: SqlRiskClass[] = ['read', 'write', 'destructive', 'unknown'];
      return order.indexOf(s.risk) > order.indexOf(a) ? s.risk : a;
    }, 'read');
    if (risk === 'unknown') {
      throw new Error('Cannot propose SQL with unknown risk');
    }
    if (risk === 'read') {
      throw new Error('MutationPipeline is for write/destructive plans only');
    }

    const plan: MutationPlan = {
      proposalId: `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      connectionId: input.connectionId,
      title: input.title,
      intent: input.intent,
      sql: classified.statements.map((s) => s.sql).join(';\n') + ';',
      risk,
      expectedDiff: input.expectedDiff ?? {
        connectionId: input.connectionId,
        comparedAt: new Date().toISOString(),
        items: [],
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    this.proposals.set(plan.proposalId, plan);
    return plan;
  }

  /**
   * Host UI confirmation → issues approval token bound to exact SQL.
   */
  async confirmWithUser(plan: MutationPlan): Promise<string | undefined> {
    const detail = [
      plan.title,
      `Risk: ${plan.risk}`,
      `Intent: ${plan.intent}`,
      '',
      plan.sql.slice(0, 3000),
    ].join('\n');
    const pick = await vscode.window.showWarningMessage(
      'Approve schema modification?',
      { modal: true, detail },
      'Approve',
      'Cancel'
    );
    if (pick !== 'Approve') {
      return undefined;
    }
    const record = this.approvals.issue(plan);
    return record.approvalToken;
  }

  async executeApproved(proposalId: string, approvalToken: string): Promise<void> {
    const plan = this.proposals.get(proposalId);
    if (!plan) {
      throw new Error('Unknown proposal');
    }
    if (Date.parse(plan.expiresAt) < Date.now()) {
      throw new Error('Proposal expired');
    }
    const consumed = this.approvals.consume(approvalToken, plan);
    if (!consumed.ok) {
      throw new Error(consumed.reason);
    }

    await this.sql.execute(plan.connectionId, plan.sql, 'mcp', {
      approvalContentHash: contentHashForPlan(plan),
    });

    await this.catalog.refresh(plan.connectionId, { full: false });
  }

  /**
   * Interactive path for UI (non-MCP): confirm then execute via mutation-pipeline source.
   */
  async proposePreviewConfirmExecute(input: {
    connectionId: string;
    title: string;
    intent: string;
    sql: string;
  }): Promise<boolean> {
    const plan = this.propose(input);
    const token = await this.confirmWithUser(plan);
    if (!token) {
      return false;
    }
    const consumed = this.approvals.consume(token, plan);
    if (!consumed.ok) {
      throw new Error(consumed.reason);
    }
    await this.sql.execute(plan.connectionId, plan.sql, 'mutation-pipeline', {
      approvalContentHash: contentHashForPlan(plan),
    });
    await this.catalog.refresh(plan.connectionId, { full: false });
    return true;
  }

  buildPhysicalFkSql(input: {
    schema: string;
    table: string;
    constraintName: string;
    columns: string[];
    refSchema: string;
    refTable: string;
    refColumns: string[];
  }): string {
    const cols = input.columns.map(q).join(', ');
    const refs = input.refColumns.map(q).join(', ');
    return `ALTER TABLE ${q(input.schema)}.${q(input.table)}
  ADD CONSTRAINT ${q(input.constraintName)}
  FOREIGN KEY (${cols}) REFERENCES ${q(input.refSchema)}.${q(input.refTable)} (${refs});`;
  }

  buildNmJunctionSql(input: {
    schema: string;
    leftTable: string;
    rightTable: string;
    leftCols: string[];
    rightCols: string[];
    leftRefCols: string[];
    rightRefCols: string[];
    junctionName?: string;
  }): string {
    const jName =
      input.junctionName ??
      `${input.leftTable}_${input.rightTable}`;
    const leftFk = input.leftCols.map((c, i) => `${q(c)} INT NOT NULL`).join(',\n  ');
    // Simplified generation — production path should use referenced column types from catalog
    const rightFk = input.rightCols.map((c) => `${q(c)} INT NOT NULL`).join(',\n  ');
    return `CREATE TABLE ${q(input.schema)}.${q(jName)} (
  ${leftFk},
  ${rightFk},
  PRIMARY KEY (${input.leftCols.concat(input.rightCols).map(q).join(', ')}),
  CONSTRAINT ${q(`fk_${jName}_${input.leftTable}`)} FOREIGN KEY (${input.leftCols.map(q).join(', ')})
    REFERENCES ${q(input.schema)}.${q(input.leftTable)} (${input.leftRefCols.map(q).join(', ')}),
  CONSTRAINT ${q(`fk_${jName}_${input.rightTable}`)} FOREIGN KEY (${input.rightCols.map(q).join(', ')})
    REFERENCES ${q(input.schema)}.${q(input.rightTable)} (${input.rightRefCols.map(q).join(', ')})
);`;
  }
}

function q(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}
