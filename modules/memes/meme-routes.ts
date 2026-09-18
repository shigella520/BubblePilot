import {
  collectionSchema,
  memeFilterSchema,
  memeBatchSchema,
} from "./meme-collection-types.js";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationError } from "../../app/errors.js";
import { memeEditSchema, memeLimits } from "./meme-types.js";
import type { MemeService } from "./meme-service.js";
export function registerMemeRoutes(
  app: FastifyInstance,
  service: MemeService,
  admin: (request: FastifyRequest) => Promise<void>,
  audit: (
    action: string,
    target: string,
  ) => (request: FastifyRequest) => Promise<void>,
) {
  app.register(multipart, {
    limits: { fileSize: memeLimits.fileBytes, files: 1, fields: 4, parts: 5 },
  });
  const id = (request: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(request.params).id;
  const conflict = () =>
    new ApplicationError(
      "MEME_CONFLICT",
      "素材已更新或不存在，请刷新后重试。",
      409,
    );
  const asset = async (request: FastifyRequest) => {
    const item = await service.repository.get(id(request));
    if (!item)
      throw new ApplicationError("MEME_NOT_FOUND", "素材不存在。", 404);
    return item;
  };
  const view = (item: Awaited<ReturnType<typeof asset>>) => {
    const { storageKey: _key, ...rest } = item;
    void _key;
    return rest;
  };
  app.get("/api/v1/meme-collections", { preHandler: admin }, async () => ({
    data: await service.repository.listCollections(),
  }));
  app.post(
    "/api/v1/meme-collections",
    { preHandler: audit("meme.collection.create", "meme-collection") },
    async (request) => ({
      data: await service.repository.createCollection(
        collectionSchema.parse(request.body),
      ),
    }),
  );
  app.put(
    "/api/v1/meme-collections/:id",
    { preHandler: audit("meme.collection.update", "meme-collection") },
    async (request) => {
      const updated = await service.repository.editCollection(
        id(request),
        collectionSchema
          .extend({ expectedVersion: z.number().int().positive() })
          .parse(request.body),
      );
      if (!updated) throw conflict();
      return { data: updated };
    },
  );
  app.delete(
    "/api/v1/meme-collections/:id",
    { preHandler: audit("meme.collection.delete", "meme-collection") },
    async (request) => {
      const { expectedVersion } = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      if (
        !(await service.repository.removeCollection(
          id(request),
          expectedVersion,
        ))
      )
        throw conflict();
      return { data: { deleted: true } };
    },
  );
  app.post(
    "/api/v1/memes/selection",
    { preHandler: admin },
    async (request) => ({
      data: {
        items: await service.repository.selection(
          memeFilterSchema.parse(request.body),
        ),
      },
    }),
  );
  app.post(
    "/api/v1/memes/batch",
    { preHandler: audit("meme.batch", "meme") },
    async (request) => ({
      data: {
        items: await service.repository.batch(
          memeBatchSchema.parse(request.body),
        ),
      },
    }),
  );
  app.get("/api/v1/memes", { preHandler: admin }, async (request) => {
    const input = z
      .object({
        collection: memeFilterSchema.shape.collection,
        query: z.string().max(200).optional(),
        enabled: z.enum(["true", "false"]).optional(),
        status: z
          .enum(["pending", "processing", "succeeded", "failed"])
          .optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(24),
      })
      .parse(request.query);
    const page = await service.repository.list({
      ...input,
      ...(input.enabled === undefined
        ? {}
        : { enabled: input.enabled === "true" }),
    } as Parameters<typeof service.repository.list>[0]);
    return { data: { ...page, items: page.items.map(view) } };
  });
  app.post(
    "/api/v1/memes",
    { preHandler: audit("meme.upload", "meme") },
    async (request) => {
      const fields: Record<string, string> = {};
      let bytes: Buffer | undefined;
      for await (const part of request.parts()) {
        if (part.type === "file") bytes = await part.toBuffer();
        else fields[part.fieldname] = String(part.value);
      }
      if (!bytes)
        throw new ApplicationError("MEME_FILE_REQUIRED", "请选择图片。", 400);
      let tags: unknown = [];
      try {
        tags = JSON.parse(fields.tags ?? "[]");
      } catch {
        throw new ApplicationError("MEME_TAGS_INVALID", "标签格式无效。", 400);
      }
      const result = await service.upload(bytes, {
        collectionId: fields.collectionId ? fields.collectionId : null,
        name: fields.name,
        description: fields.description ?? "",
        tags,
      });
      return { data: { ...result, asset: view(result.asset) } };
    },
  );
  app.get("/api/v1/memes/:id", { preHandler: admin }, async (request) => ({
    data: view(await asset(request)),
  }));
  app.put(
    "/api/v1/memes/:id",
    { preHandler: audit("meme.update", "meme") },
    async (request) => {
      const updated = await service.repository.edit(
        id(request),
        memeEditSchema.parse(request.body),
      );
      if (!updated) throw conflict();
      return { data: view(updated) };
    },
  );
  app.delete(
    "/api/v1/memes/:id",
    { preHandler: audit("meme.delete", "meme") },
    async (request) => {
      const input = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      if (
        !(await service.repository.remove(id(request), input.expectedVersion))
      )
        throw conflict();
      return { data: { deleted: true } };
    },
  );
  app.get(
    "/api/v1/memes/:id/thumbnail",
    { preHandler: admin },
    async (request, reply) => {
      const item = await asset(request);
      return reply
        .header("Cache-Control", "private, no-store")
        .type("image/png")
        .send(await service.files.read(item.storageKey, true));
    },
  );
  app.get(
    "/api/v1/memes/:id/file",
    { preHandler: admin },
    async (request, reply) => {
      const item = await asset(request);
      return reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type(item.mimeType)
        .send(await service.files.read(item.storageKey));
    },
  );
  app.post(
    "/api/v1/memes/:id/summary",
    { preHandler: audit("meme.summary.generate", "meme") },
    async (request) => {
      const input = z
        .object({
          expectedVersion: z.number().int().positive(),
          candidate: z.boolean().default(true),
        })
        .parse(request.body);
      if (
        !(await service.repository.enqueue(
          id(request),
          input.expectedVersion,
          input.candidate,
        ))
      )
        throw conflict();
      return { data: view(await asset(request)) };
    },
  );
  app.post(
    "/api/v1/memes/:id/summary/adopt",
    { preHandler: audit("meme.summary.adopt", "meme") },
    async (request) => {
      const input = z
        .object({ expectedVersion: z.number().int().positive() })
        .parse(request.body);
      const updated = await service.repository.adopt(
        id(request),
        input.expectedVersion,
      );
      if (!updated) throw conflict();
      return { data: view(updated) };
    },
  );
}
