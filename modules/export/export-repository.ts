import type {
  DataExportJob,
  DataExportMutationResult,
  DataExportOwner,
  DataExportPreviewResult,
  DataExportReadResult,
  DataExportScope,
} from "./export-types.js";

export interface DataExportRepository {
  createPreview(input: {
    id: string;
    owner: DataExportOwner;
    scope: DataExportScope;
    snapshotAt: Date;
    expiresAt: Date;
    maxRecords: number;
    maxEstimatedBytes: number;
  }): Promise<DataExportPreviewResult>;
  listJobs(
    owner: DataExportOwner,
    now: Date,
    limit: number,
  ): Promise<readonly DataExportJob[]>;
  confirmJob(input: {
    id: string;
    owner: DataExportOwner;
    expectedRecordCount: number;
    expectedSnapshotAt: Date;
    now: Date;
    expiresAt: Date;
  }): Promise<DataExportMutationResult>;
  revokeJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportMutationResult>;
  readJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportReadResult>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
