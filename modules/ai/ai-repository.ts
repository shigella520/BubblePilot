import type {
  AiAttemptRecordInput,
  AiCandidateSelection,
  AiProviderAttemptView,
  AiProviderConfiguration,
  AiProviderCapabilityProbe,
  AiProviderHealth,
  AiProviderRecord,
  AiProviderRouteRecord,
  AiRouteConfiguration,
  AiRouteSnapshot,
} from "./ai-types.js";

export type AiMutationResult<T> =
  | { status: "ok"; value: T }
  | { status: "not-found" }
  | { status: "conflict"; reason: string };

export interface AiRepository {
  listProviders(): Promise<readonly AiProviderRecord[]>;
  getProvider(providerId: string): Promise<AiProviderRecord | null>;
  createProvider(
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>>;
  updateProvider(
    providerId: string,
    expectedVersion: number,
    configuration: AiProviderConfiguration,
  ): Promise<AiMutationResult<AiProviderRecord>>;
  setProviderEnabled(
    providerId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRecord>>;
  reorderProviders(
    providers: readonly { id: string; expectedVersion: number }[],
  ): Promise<AiMutationResult<readonly AiProviderRecord[]>>;
  deleteProvider(
    providerId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRecord>>;
  getProviderHealth(providerId: string): Promise<AiProviderHealth | null>;
  resetProviderHealth(providerId: string): Promise<AiProviderHealth | null>;
  updateProviderCapabilityProbe(
    providerId: string,
    probe: AiProviderCapabilityProbe,
  ): Promise<AiProviderRecord | null>;
  recordProviderSuccess(providerId: string): Promise<AiProviderHealth>;
  recordProviderFailure(input: {
    providerId: string;
    errorCode: string;
    countsForDegrade: boolean;
    failureThreshold: number;
    cooldownMs: number;
  }): Promise<AiProviderHealth>;

  listRoutes(): Promise<readonly AiProviderRouteRecord[]>;
  getRoute(routeId: string): Promise<AiProviderRouteRecord | null>;
  createRoute(
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>>;
  updateRoute(
    routeId: string,
    expectedVersion: number,
    configuration: AiRouteConfiguration,
  ): Promise<AiMutationResult<AiProviderRouteRecord>>;
  setRouteEnabled(
    routeId: string,
    expectedVersion: number,
    enabled: boolean,
  ): Promise<AiMutationResult<AiProviderRouteRecord>>;
  deleteRoute(
    routeId: string,
    expectedVersion: number,
  ): Promise<AiMutationResult<AiProviderRouteRecord>>;
  getRouteSnapshot(routeId: string): Promise<AiRouteSnapshot | null>;
  selectCandidates(snapshot: AiRouteSnapshot): Promise<AiCandidateSelection>;
  claimProviderProbe(
    providerId: string,
    candidateProviderIds: readonly string[],
  ): Promise<AiProviderHealth | null>;
  recordAttempt(input: AiAttemptRecordInput): Promise<void>;
  listAttempts(
    executionId: string,
    nodeId?: string,
  ): Promise<readonly AiProviderAttemptView[]>;
  isReady(): Promise<boolean>;
  close(): Promise<void>;
}
