import { randomUUID } from "node:crypto";

import type { DataExportRepository } from "./export-repository.js";
import type {
  DataExportJob,
  DataExportMutationResult,
  DataExportOwner,
  DataExportPreviewResult,
  DataExportReadResult,
  DataExportScope,
} from "./export-types.js";

const previewTtlMs = 5 * 60 * 1_000;
const downloadTtlMs = 10 * 60 * 1_000;
const maxRecords = 10_000;
const maxEstimatedBytes = 25_000_000;

export class DataExportService {
  constructor(
    private readonly repository: DataExportRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  preview(
    owner: DataExportOwner,
    scope: DataExportScope,
  ): Promise<DataExportPreviewResult> {
    const snapshotAt = this.now();
    return this.repository.createPreview({
      id: randomUUID(),
      owner,
      scope,
      snapshotAt,
      expiresAt: new Date(snapshotAt.getTime() + previewTtlMs),
      maxRecords,
      maxEstimatedBytes,
    });
  }

  list(
    owner: DataExportOwner,
    limit: number,
  ): Promise<readonly DataExportJob[]> {
    return this.repository.listJobs(owner, this.now(), limit);
  }

  confirm(
    id: string,
    owner: DataExportOwner,
    expectedRecordCount: number,
    expectedSnapshotAt: Date,
  ): Promise<DataExportMutationResult> {
    const now = this.now();
    return this.repository.confirmJob({
      id,
      owner,
      expectedRecordCount,
      expectedSnapshotAt,
      now,
      expiresAt: new Date(now.getTime() + downloadTtlMs),
    });
  }

  revoke(
    id: string,
    owner: DataExportOwner,
  ): Promise<DataExportMutationResult> {
    return this.repository.revokeJob({ id, owner, now: this.now() });
  }

  read(id: string, owner: DataExportOwner): Promise<DataExportReadResult> {
    return this.repository.readJob({ id, owner, now: this.now() });
  }

  render(result: Extract<DataExportReadResult, { status: "ok" }>): string {
    const manifest = {
      type: "manifest",
      schemaVersion: "1",
      exportId: result.job.id,
      generatedAt: this.now().toISOString(),
      snapshotAt: result.job.snapshotAt,
      scope: result.job.scope,
      counts: {
        messages: result.job.messageCount,
        executions: result.job.executionCount,
        total: result.job.recordCount,
      },
    };
    return [
      JSON.stringify(manifest),
      ...result.content.messages.map((message) =>
        JSON.stringify({ type: "message", data: message }),
      ),
      ...result.content.executions.map((execution) =>
        JSON.stringify({ type: "execution", data: execution }),
      ),
      "",
    ].join("\n");
  }
}
