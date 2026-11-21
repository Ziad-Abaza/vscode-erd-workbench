import * as crypto from 'crypto';
import type { ApprovalRecord, MutationPlan } from '../../shared/types';
import { sha256 } from '../schema/hash';

export function contentHashForPlan(plan: Pick<MutationPlan, 'proposalId' | 'sql' | 'connectionId'>): string {
  return sha256(`${plan.proposalId}\n${plan.connectionId}\n${plan.sql}`);
}

export class ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRecord>();

  issue(plan: MutationPlan): ApprovalRecord {
    const contentHash = contentHashForPlan(plan);
    const record: ApprovalRecord = {
      approvalToken: `appr_${crypto.randomBytes(16).toString('hex')}`,
      proposalId: plan.proposalId,
      contentHash,
      connectionId: plan.connectionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used: false,
    };
    this.approvals.set(record.approvalToken, record);
    return record;
  }

  /**
   * Validates token is unused, unexpired, and bound to exact plan content.
   * Marks used on success (single-use).
   */
  consume(token: string, plan: MutationPlan): { ok: true } | { ok: false; reason: string } {
    const record = this.approvals.get(token);
    if (!record) {
      return { ok: false, reason: 'Unknown approval token' };
    }
    if (record.used) {
      return { ok: false, reason: 'Approval token already used' };
    }
    if (Date.parse(record.expiresAt) < Date.now()) {
      return { ok: false, reason: 'Approval token expired' };
    }
    if (record.proposalId !== plan.proposalId) {
      return { ok: false, reason: 'Approval token not bound to this proposal' };
    }
    const expected = contentHashForPlan(plan);
    if (record.contentHash !== expected || record.connectionId !== plan.connectionId) {
      return { ok: false, reason: 'Approval invalidated: SQL or parameters changed' };
    }
    record.used = true;
    return { ok: true };
  }

  get(token: string): ApprovalRecord | undefined {
    return this.approvals.get(token);
  }
}
