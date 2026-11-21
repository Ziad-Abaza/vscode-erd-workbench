import * as vscode from 'vscode';
import type { MutationPlan, SchemaDiff, SchemaDiffItem, SqlRiskClass } from '../../shared/types';
import { SchemaDiffService } from '../schema/SchemaDiffService';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { SqlExecutionService } from '../sql/execution/SqlExecutionService';
import { SqlParserService } from '../sql/parser/SqlParserService';
import { ApprovalStore, contentHashForPlan } from './ApprovalStore';
import {
  buildAddColumnSql,
  buildDropColumnSql,
  buildModifyColumnSql,
  type AlterColumnInput,
  type ColumnDefinitionInput,
} from './columnDdl';
import {
  buildNmJunctionSql as nmJunctionSql,
  buildPhysicalFkSql as physicalFkSql,
  type NmJunctionInput,
  type PhysicalFkInput,
} from './relationshipDdl';

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
    expectedDiffItems?: SchemaDiffItem[];
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

    const expectedDiff: SchemaDiff = input.expectedDiff ?? {
      connectionId: input.connectionId,
      comparedAt: new Date().toISOString(),
      items: input.expectedDiffItems ?? [],
    };

    const plan: MutationPlan = {
      proposalId: `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      connectionId: input.connectionId,
      title: input.title,
      intent: input.intent,
      sql: classified.statements.map((s) => s.sql).join(';\n') + ';',
      risk,
      expectedDiff,
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
    const diffSummary =
      plan.expectedDiff.items.length > 0
        ? [
            '',
            'Expected changes:',
            ...plan.expectedDiff.items.map((i) => `  • ${i.summary}`),
          ]
        : [];
    const detail = [
      plan.title,
      `Risk: ${plan.risk}`,
      `Intent: ${plan.intent}`,
      ...diffSummary,
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
    expectedDiffItems?: SchemaDiffItem[];
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

  buildAddColumnSql(schema: string, table: string, col: ColumnDefinitionInput): string {
    return buildAddColumnSql(schema, table, col);
  }

  buildModifyColumnSql(schema: string, table: string, col: AlterColumnInput): string {
    return buildModifyColumnSql(schema, table, col);
  }

  buildDropColumnSql(schema: string, table: string, columnName: string): string {
    return buildDropColumnSql(schema, table, columnName);
  }

  buildPhysicalFkSql(input: PhysicalFkInput): string {
    return physicalFkSql(input);
  }

  buildNmJunctionSql(input: NmJunctionInput): string {
    return nmJunctionSql(input);
  }
}
