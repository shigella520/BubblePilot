import { createHmac, timingSafeEqual } from "node:crypto";

import { z, type ZodError } from "zod";

import { hashJson } from "../../app/canonical-json.js";
import type { WorkflowDefinition } from "./workflow-definition.js";
import { parseWorkflowDefinition } from "./workflow-definition.js";
import { validateWorkflowGraph } from "./workflow-graph.js";

export const workflowManifestKind = "BubblePilotWorkflow" as const;
export const workflowManifestApiVersion = "bubblepilot.io/v1" as const;

export const workflowCapabilitySchema = z.enum([
  "text",
  "function-calling",
  "hosted-search",
  "image-input",
]);
export type WorkflowCapability = z.infer<typeof workflowCapabilitySchema>;

const bindingSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    requiredCapabilities: z.array(workflowCapabilitySchema).default([]),
    instanceId: z.string().min(1).max(500).optional(),
  })
  .strict();

const manifestNodeSchema = z.looseObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  type: z.enum([
    "message-trigger",
    "condition",
    "log",
    "set-variable",
    "render-text",
    "load-context",
    "ai-chat",
    "reply",
    "end",
  ]),
  version: z.literal(1),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  config: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()).optional(),
  onSuccess: z.string().optional(),
  onFailure: z.string().optional(),
  onTrue: z.string().optional(),
  onFalse: z.string().optional(),
});

export const workflowManifestSchema = z
  .object({
    $schema: z.string().optional(),
    kind: z.literal(workflowManifestKind),
    apiVersion: z.literal(workflowManifestApiVersion),
    metadata: z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(2_000).default(""),
      })
      .strict(),
    spec: z
      .object({
        maxSteps: z.number().int().min(1).max(128).default(64),
        startNodeId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        nodes: z.array(manifestNodeSchema).min(1).max(64),
        edges: z.array(z.record(z.string(), z.unknown())).max(256).optional(),
      })
      .strict(),
    bindings: z
      .object({
        aiRoutes: z.record(z.string(), bindingSchema).default({}),
        chats: z.record(z.string(), bindingSchema).default({}),
      })
      .strict()
      .default({ aiRoutes: {}, chats: {} }),
  })
  .strict();

export type WorkflowManifest = z.infer<typeof workflowManifestSchema>;

export interface WorkflowBindingResource {
  id: string;
  name: string;
  capabilities: readonly WorkflowCapability[];
}

export interface WorkflowBindingCatalog {
  aiRoutes: readonly WorkflowBindingResource[];
  chats: readonly WorkflowBindingResource[];
}

export interface WorkflowManifestIssue {
  path: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  suggestion: string;
}

export interface WorkflowBindingResolution {
  ref: string;
  kind: "aiRoute" | "chat";
  name: string;
  selectedId: string | null;
  candidates: readonly WorkflowBindingResource[];
  status: "resolved" | "missing" | "ambiguous" | "incompatible";
}

export type WorkflowBindingSelections = Readonly<Record<string, string>>;

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issuePath(path: readonly PropertyKey[]): string {
  return `/${path.map((part) => escapePointer(String(part))).join("/")}`;
}

function zodIssues(error: ZodError): WorkflowManifestIssue[] {
  return error.issues.map((issue) => ({
    path: issuePath(issue.path),
    severity: "error",
    code: "MANIFEST_SCHEMA_INVALID",
    message: issue.message,
    suggestion: "按工作流 JSON Schema 修正此字段后重新预览。",
  }));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requiredRouteCapabilities(
  node: Record<string, unknown>,
  resource?: WorkflowBindingResource,
): WorkflowCapability[] {
  const config = node.config as Record<string, unknown> | undefined;
  const capabilities: WorkflowCapability[] = ["text"];
  if (config?.webSearch === "auto" || config?.webSearch === "required") {
    capabilities.push(
      resource?.capabilities.includes("hosted-search")
        ? "hosted-search"
        : "function-calling",
    );
  }
  return capabilities;
}

function mergeCapabilities(
  left: readonly WorkflowCapability[],
  right: readonly WorkflowCapability[],
): WorkflowCapability[] {
  return [...new Set([...left, ...right])];
}

export function exportWorkflowManifest(input: {
  definition: WorkflowDefinition | Record<string, unknown>;
  description?: string;
  mode: "portable" | "instance-bound";
  catalog: WorkflowBindingCatalog;
  schemaUrl?: string;
}): WorkflowManifest {
  const definition = clone(input.definition) as Record<string, unknown>;
  const nodes = clone(definition.nodes) as Array<Record<string, unknown>>;
  const aiRoutes: Record<string, z.infer<typeof bindingSchema>> = {};
  const chats: Record<string, z.infer<typeof bindingSchema>> = {};
  const routeRefs = new Map<string, string>();
  const chatRefs = new Map<string, string>();

  const routeRef = (
    id: string,
    capabilities: readonly WorkflowCapability[],
  ) => {
    let ref = routeRefs.get(id);
    if (ref === undefined) {
      ref = `ai-route-${routeRefs.size + 1}`;
      routeRefs.set(id, ref);
      const resource = input.catalog.aiRoutes.find((item) => item.id === id);
      aiRoutes[ref] = {
        name: resource?.name ?? `Unknown AI route ${routeRefs.size}`,
        requiredCapabilities: [...capabilities],
        ...(input.mode === "instance-bound" ? { instanceId: id } : {}),
      };
    } else {
      aiRoutes[ref]!.requiredCapabilities = mergeCapabilities(
        aiRoutes[ref]!.requiredCapabilities,
        capabilities,
      );
    }
    return ref;
  };
  const chatRef = (id: string) => {
    let ref = chatRefs.get(id);
    if (ref === undefined) {
      ref = `chat-${chatRefs.size + 1}`;
      chatRefs.set(id, ref);
      const resource = input.catalog.chats.find((item) => item.id === id);
      chats[ref] = {
        name: resource?.name ?? `Unknown chat ${chatRefs.size}`,
        requiredCapabilities: [],
        ...(input.mode === "instance-bound" ? { instanceId: id } : {}),
      };
    }
    return ref;
  };

  for (const node of nodes) {
    const config = clone((node.config ?? {}) as Record<string, unknown>);
    if (node.type === "ai-chat" && typeof config.providerRouteId === "string") {
      const resource = input.catalog.aiRoutes.find(
        (item) => item.id === config.providerRouteId,
      );
      config.providerRouteRef = routeRef(
        config.providerRouteId,
        requiredRouteCapabilities(node, resource),
      );
      delete config.providerRouteId;
    }
    if (node.type === "message-trigger" && Array.isArray(config.chatIds)) {
      config.chatRefs = config.chatIds
        .filter((id): id is string => typeof id === "string")
        .map(chatRef);
      delete config.chatIds;
    }
    node.config = config;
  }

  const parsed = workflowManifestSchema.parse({
    $schema: input.schemaUrl ?? "/api/v1/workflows/schema",
    kind: workflowManifestKind,
    apiVersion: workflowManifestApiVersion,
    metadata: {
      name:
        typeof definition.name === "string"
          ? definition.name
          : "Imported workflow",
      description: input.description ?? "",
    },
    spec: {
      maxSteps: definition.maxSteps ?? 64,
      startNodeId: definition.startNodeId,
      nodes,
      ...(Array.isArray(definition.edges)
        ? { edges: clone(definition.edges) }
        : {}),
    },
    bindings: { aiRoutes, chats },
  });
  return parsed;
}

function compatible(
  resource: WorkflowBindingResource,
  required: readonly WorkflowCapability[],
): boolean {
  return required.every((capability) =>
    resource.capabilities.includes(capability),
  );
}

export function resolveWorkflowBindings(
  manifest: WorkflowManifest,
  catalog: WorkflowBindingCatalog,
  selections: WorkflowBindingSelections = {},
): {
  resolutions: WorkflowBindingResolution[];
  issues: WorkflowManifestIssue[];
} {
  const resolutions: WorkflowBindingResolution[] = [];
  const issues: WorkflowManifestIssue[] = [];
  for (const [kind, definitions, resources] of [
    ["aiRoute", manifest.bindings.aiRoutes, catalog.aiRoutes],
    ["chat", manifest.bindings.chats, catalog.chats],
  ] as const) {
    for (const [ref, binding] of Object.entries(definitions)) {
      const explicitId = selections[ref] ?? binding.instanceId;
      const explicit = explicitId
        ? resources.filter((resource) => resource.id === explicitId)
        : [];
      const named = resources.filter(
        (resource) => resource.name === binding.name,
      );
      const capable = resources.filter((resource) =>
        compatible(resource, binding.requiredCapabilities),
      );
      const candidates =
        explicitId !== undefined
          ? explicit
          : named.length === 1
            ? named
            : capable;
      const compatibleCandidates = candidates.filter((resource) =>
        compatible(resource, binding.requiredCapabilities),
      );
      const status =
        candidates.length > 0 && compatibleCandidates.length === 0
          ? "incompatible"
          : compatibleCandidates.length === 0
            ? "missing"
            : compatibleCandidates.length > 1
              ? "ambiguous"
              : "resolved";
      const selectedId =
        status === "resolved" ? compatibleCandidates[0]!.id : null;
      resolutions.push({
        ref,
        kind,
        name: binding.name,
        selectedId,
        candidates: compatibleCandidates,
        status,
      });
      if (status !== "resolved") {
        issues.push({
          path: `/bindings/${kind === "aiRoute" ? "aiRoutes" : "chats"}/${escapePointer(ref)}`,
          severity: "error",
          code: `BINDING_${status.toUpperCase()}`,
          message: `Binding '${ref}' is ${status}.`,
          suggestion: "在导入预览中选择一个满足要求的实例资源。",
        });
      }
    }
  }
  return { resolutions, issues };
}

export function importWorkflowManifest(input: {
  manifest: unknown;
  catalog: WorkflowBindingCatalog;
  selections?: WorkflowBindingSelections;
}): {
  manifest: WorkflowManifest | null;
  definition: WorkflowDefinition | Record<string, unknown> | null;
  resolutions: WorkflowBindingResolution[];
  issues: WorkflowManifestIssue[];
} {
  const parsed = workflowManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    return {
      manifest: null,
      definition: null,
      resolutions: [],
      issues: zodIssues(parsed.error),
    };
  }
  const manifest = parsed.data;
  const binding = resolveWorkflowBindings(
    manifest,
    input.catalog,
    input.selections,
  );
  if (binding.issues.length > 0) {
    return {
      manifest,
      definition: null,
      resolutions: binding.resolutions,
      issues: binding.issues,
    };
  }
  const selected = new Map(
    binding.resolutions.map((item) => [item.ref, item.selectedId!]),
  );
  const nodes = clone(manifest.spec.nodes);
  for (const node of nodes) {
    const config = clone(node.config);
    if (typeof config.providerRouteRef === "string") {
      config.providerRouteId = selected.get(config.providerRouteRef);
      delete config.providerRouteRef;
    }
    if (Array.isArray(config.chatRefs)) {
      config.chatIds = config.chatRefs.map((ref) => selected.get(String(ref)));
      delete config.chatRefs;
    }
    node.config = config;
  }
  const raw = {
    schemaVersion: "1",
    name: manifest.metadata.name,
    startNodeId: manifest.spec.startNodeId,
    maxSteps: manifest.spec.maxSteps,
    nodes,
    ...(manifest.spec.edges === undefined
      ? {}
      : { edges: clone(manifest.spec.edges) }),
  };
  try {
    const definition =
      manifest.spec.edges === undefined
        ? parseWorkflowDefinition(raw)
        : validateWorkflowGraph(raw);
    return {
      manifest,
      definition,
      resolutions: binding.resolutions,
      issues: [],
    };
  } catch (error) {
    return {
      manifest,
      definition: null,
      resolutions: binding.resolutions,
      issues: [
        {
          path: "/spec",
          severity: "error",
          code: "WORKFLOW_SEMANTICS_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "Workflow semantics are invalid.",
          suggestion: "修正节点连接、模板路径或跨字段配置后重新预览。",
        },
      ],
    };
  }
}

interface PreviewTokenPayload {
  manifestHash: string;
  catalogHash: string;
  issuedAt: number;
  expiresAt: number;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export class WorkflowManifestPreviewSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = 300_000,
  ) {}

  issue(
    manifest: WorkflowManifest,
    catalog: WorkflowBindingCatalog,
    now = Date.now(),
  ) {
    const payload: PreviewTokenPayload = {
      manifestHash: hashJson(manifest),
      catalogHash: hashJson(catalog),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
    };
    const encoded = base64url(JSON.stringify(payload));
    const signature = createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
    return {
      token: `${encoded}.${signature}`,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  verify(
    token: string,
    manifest: WorkflowManifest,
    catalog: WorkflowBindingCatalog,
    now = Date.now(),
  ): "valid" | "expired" | "invalid" {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) return "invalid";
    const expected = createHmac("sha256", this.secret).update(encoded).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      return "invalid";
    }
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return "invalid";
    try {
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as PreviewTokenPayload;
      if (payload.expiresAt < now) return "expired";
      return payload.manifestHash === hashJson(manifest) &&
        payload.catalogHash === hashJson(catalog)
        ? "valid"
        : "invalid";
    } catch {
      return "invalid";
    }
  }
}
