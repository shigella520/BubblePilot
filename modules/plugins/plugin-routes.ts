import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PluginService } from "./plugin-service.js";
import {
  connectionSchema,
  importSchema,
  pluginError,
  pluginLimits,
} from "./plugin-types.js";
const connections = z.record(z.string(), connectionSchema);
export function registerPluginRoutes(
  app: FastifyInstance,
  service: PluginService,
  admin: (r: FastifyRequest) => Promise<void>,
  sensitive: (
    action: string,
    target: string,
  ) => (r: FastifyRequest) => Promise<void>,
) {
  const id = (r: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(r.params).id;
  app.get("/api/v1/plugins", { preHandler: admin }, async () => ({
    data: await service.list(),
  }));
  app.post(
    "/api/v1/plugins/imports",
    {
      preHandler: sensitive("plugin.import", "plugin"),
      bodyLimit: pluginLimits.archiveBytes,
    },
    async (r) => {
      if (r.isMultipart()) {
        const file = await r.file({
          limits: { fileSize: pluginLimits.archiveBytes, files: 1, fields: 0 },
        });
        if (!file) pluginError("FILE_REQUIRED");
        return {
          data: await service.stage({ type: "zip" }, await file.toBuffer()),
        };
      }
      const body = importSchema.parse(r.body);
      return { data: await service.stage({ type: "git", ...body }) };
    },
  );
  app.get("/api/v1/plugins/imports/:id", { preHandler: admin }, async (r) => ({
    data: await service.importView(id(r)),
  }));
  app.post(
    "/api/v1/plugins/imports/:id/inspect",
    { preHandler: admin },
    async (r) => {
      const { directory } = z.object({ directory: z.string() }).parse(r.body);
      const pkg = await service.inspect(id(r), directory);
      return {
        data: {
          ...pkg,
          files: undefined,
          skills: pkg.skills.map((s) => ({ ...s, body: pkg.files[s.file] })),
        },
      };
    },
  );
  app.post(
    "/api/v1/plugins/connections/test",
    { preHandler: sensitive("plugin.connection.test", "plugin") },
    async (r) => {
      const b = z
        .object({ connections, pluginId: z.string().uuid().optional() })
        .parse(r.body);
      if (b.pluginId) {
        const p = await service.get(b.pluginId);
        for (const [name, c] of Object.entries(b.connections)) {
          const old = p.config.connections[name];
          if (
            c.secret === undefined &&
            old?.url === c.url &&
            old.auth === c.auth &&
            old.header === c.header
          )
            c.secret = old.secret;
        }
      }
      return { data: await service.discover(b.connections) };
    },
  );
  app.post(
    "/api/v1/plugins/imports/:id/install",
    { preHandler: sensitive("plugin.install", "plugin") },
    async (r) => {
      const b = z
        .object({
          directory: z.string(),
          connections,
          approved: z.array(z.string()),
          expectedVersion: z.number().int().positive().optional(),
        })
        .parse(r.body);
      return {
        data: await service.install(
          id(r),
          b.directory,
          b.connections,
          b.approved,
          b.expectedVersion,
        ),
      };
    },
  );
  app.get("/api/v1/plugins/:id", { preHandler: admin }, async (r) => ({
    data: await service.detail(id(r)),
  }));
  app.get("/api/v1/plugins/:id/content", { preHandler: admin }, async (r) => {
    const q = z.object({ file: z.string() }).parse(r.query);
    const p = await service.get(id(r));
    if (
      !p.package.skills.some(
        (s) => s.file === q.file || s.references.includes(q.file),
      )
    )
      pluginError("REFERENCE_UNAVAILABLE", 404);
    return { data: { text: p.package.files[q.file] } };
  });
  app.put(
    "/api/v1/plugins/:id",
    { preHandler: sensitive("plugin.update", "plugin") },
    async (r) => {
      const b = z
        .object({
          expectedVersion: z.number().int().positive(),
          enabled: z.boolean().optional(),
          revision: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(r.body);
      return {
        data: await service.mutate(id(r), b.expectedVersion, {
          ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
          ...(b.revision ? { revision: b.revision } : {}),
        }),
      };
    },
  );
  app.put(
    "/api/v1/plugins/:id/config",
    { preHandler: sensitive("plugin.configure", "plugin") },
    async (r) => {
      const b = z
        .object({
          expectedVersion: z.number().int().positive(),
          connections,
          approved: z.array(z.string()),
          disabledSkills: z.array(z.string()),
          disabledTools: z.array(z.string()),
        })
        .strict()
        .parse(r.body);
      return {
        data: await service.configure(
          id(r),
          b.expectedVersion,
          b.connections,
          b.approved,
          b.disabledSkills,
          b.disabledTools,
        ),
      };
    },
  );
  app.delete(
    "/api/v1/plugins/:id",
    { preHandler: sensitive("plugin.uninstall", "plugin") },
    async (r) => {
      await service.remove(
        id(r),
        z.object({ expectedVersion: z.number().int().positive() }).parse(r.body)
          .expectedVersion,
      );
      return { data: { deleted: true } };
    },
  );
}
