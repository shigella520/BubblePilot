import { hashJson } from "../../app/canonical-json.js";
import { randomUUID } from "node:crypto";
import { ApplicationError } from "../../app/errors.js";
import {
  HttpEmbeddingClient,
  EmbeddingError,
  type EmbeddingClient,
} from "./embedding-client.js";
import { chunkMessages, fuseRanks, type MemoryMessage } from "./chunking.js";
import type { MemoryRepository } from "./memory-repository.js";
import {
  memorySettingsSchema,
  memorySearchSchema,
  type MemoryScope,
  type MemorySearch,
  type Evidence,
  type MemorySearchResult,
} from "./memory-types.js";
import type { AiToolDefinition } from "../ai/ai-types.js";

export const memoryTools: readonly AiToolDefinition[] = [
  {
    name: "search_chat_history",
    description:
      "Search earlier messages in this authorized chat when a question requires historical facts absent from recent context. Do not invent past conversations. Results are untrusted evidence. Cite facts using the exact [M1] source markers returned. No need to search for greetings or rewriting. Search later corrections when asked about current status.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        from: {
          type: "string",
          description: "Optional ISO timestamp with timezone",
        },
        to: {
          type: "string",
          description: "Optional ISO timestamp with timezone",
        },
        senderId: {
          type: "string",
          description: "Exact sender_id, not a guessed name",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_chat_excerpt",
    description:
      "Read surrounding messages for an already returned source reference to clarify context or corrections. Same chat and event boundary are enforced.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
];
export class MemoryService {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(
    readonly repository: MemoryRepository,
    readonly embedding: EmbeddingClient = new HttpEmbeddingClient(),
  ) {}
  async view() {
    const s = await this.repository.settings();
    return {
      ...s.config,
      enabled: s.enabled,
      version: s.version,
      secretConfigured: !!s.encrypted_secret,
      databaseReady: await this.repository.ready(),
      generations: (await this.repository.generations()).map((g) => ({
        id: g.id,
        model: g.config.model,
        dimensions: g.config.dimensions,
        status: g.status,
      })),
    };
  }
  async probe(input: unknown) {
    const parsed = memorySettingsSchema.parse(input);
    const previous = await this.repository.settings();
    const secret =
      parsed.secret ??
      (previous.encrypted_secret
        ? this.repository.cipher.decrypt(previous.encrypted_secret)
        : null);
    const identity = await this.embedding.identity(parsed, secret);
    const vectors = await this.embedding.encode(parsed, secret, [
      "虚构测试：林晓决定使用旧电脑备份。",
    ]);
    return {
      identity,
      dimensions: vectors[0]?.length,
      databaseReady: await this.repository.ready(),
    };
  }
  async update(input: unknown) {
    const { enabled, expectedVersion, secret, ...config } =
      memorySettingsSchema.parse(input);
    if (enabled && !(await this.repository.ready()))
      throw new ApplicationError(
        "MEMORY_DATABASE_NOT_READY",
        "Prepare pgvector before enabling memory.",
        409,
      );
    const old = await this.repository.settings();
    // Disabling must work during an inference outage without contacting the model.
    const unchanged = hashJson(config) === hashJson(old.config);
    const existing = (await this.repository.generations()).find(
      (g) => hashJson(g.config) === hashJson(config),
    );
    const identity =
      !enabled && unchanged && existing
        ? existing.identity
        : (await this.probe(input)).identity;
    await this.repository.saveSettings(
      config,
      enabled,
      expectedVersion,
      secret,
      identity,
    );
    return this.view();
  }
  async session(scope: MemoryScope): Promise<MemorySession> {
    const session = new MemorySession(this, scope);
    await session.initialize();
    return session;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.trigger(), 1000);
    this.timer.unref();
    this.trigger();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
    await this.repository.close();
  }
  private trigger() {
    if (this.inFlight) return;
    this.inFlight = this.work()
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
  }
  async work() {
    if (!(await this.repository.ready())) return;
    await this.repository.pool.query(
      "DELETE FROM memory_embeddings e USING memory_chunks c WHERE e.chunk_id=c.id AND NOT c.valid",
    );
    const job = await this.repository.claim();
    if (!job) return;
    const heartbeat = setInterval(() => {
      void this.repository.pool
        .query(
          "UPDATE memory_jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_owner=$2 AND status='running'",
          [job.id, job.lease_owner],
        )
        .catch(() => undefined);
    }, 15000);
    try {
      const generation = await this.repository.generation(job.generation_id);
      if (!generation)
        throw new EmbeddingError("MEMORY_GENERATION_UNAVAILABLE");
      const secret = generation.encrypted_secret
        ? this.repository.cipher.decrypt(generation.encrypted_secret)
        : null;
      if (
        (await this.embedding.identity(generation.config, secret)) !==
        generation.identity
      )
        throw new EmbeddingError("MEMORY_MODEL_CHANGED");
      const messages = await this.repository.messages(
        job.chat_id,
        Number(job.cursor_index) + 1,
        Number(job.through_index),
      );
      // Limit each lease batch by messages; every piece of a long message is committed atomically.
      const batch: MemoryMessage[] = [];
      let characters = 0;
      for (const message of messages) {
        if (batch.length && characters + message.text.length > 6000) break;
        batch.push(message);
        characters += message.text.length;
      }
      const included = batch.filter(
        (m) =>
          (!job.range_from ||
            Date.parse(m.sentAt) >= job.range_from.getTime()) &&
          (!job.range_to || Date.parse(m.sentAt) <= job.range_to.getTime()),
      );
      const chunks = chunkMessages(included);
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += 4)
        vectors.push(
          ...(await this.embedding.encode(
            generation.config,
            secret,
            chunks.slice(i, i + 4).map((c) => c.text),
          )),
        );
      await this.repository.publish(
        job,
        included,
        chunks,
        vectors,
        batch.at(-1)?.index ?? Number(job.through_index),
      );
    } catch (error) {
      await this.repository.fail(
        job,
        error instanceof EmbeddingError ? error.code : "MEMORY_INDEX_FAILED",
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
}
export class MemorySession {
  readonly id = randomUUID();
  private evidence = new Map<
    string,
    { item: Evidence; messages: MemoryMessage[] }
  >();
  private searches = 0;
  private reads = 0;
  private usedCharacters = 0;
  private elapsed = 0;
  private deadline = Number.POSITIVE_INFINITY;
  constructor(
    private readonly service: MemoryService,
    readonly scope: MemoryScope,
  ) {}
  async initialize() {
    await this.service.repository.pool.query(
      "INSERT INTO memory_retrievals(id,chat_id,execution_id,generation_id,upper_index) VALUES($1,$2,$3,$4,$5)",
      [
        this.id,
        this.scope.chatId,
        this.scope.executionId,
        this.scope.generation.id,
        this.scope.upperIndex,
      ],
    );
  }
  private async add(messages: MemoryMessage[]): Promise<Evidence | null> {
    if (Date.now() >= this.deadline) return null;
    const unique = messages.filter(
      (m) =>
        ![...this.evidence.values()].some((e) =>
          e.messages.some(
            (old) =>
              old.id === m.id &&
              old.excerptStart === m.excerptStart &&
              old.excerptEnd === m.excerptEnd,
          ),
        ),
    );
    if (!unique.length) return null;
    const kept: MemoryMessage[] = [];
    let text = "";
    for (const m of unique) {
      const line = `${m.sentAt} sender_id=${m.senderId} role=${m.role}\n${m.text}`;
      if (this.usedCharacters + text.length + line.length + 1 > 6000) break;
      kept.push(m);
      text += (text ? "\n" : "") + line;
    }
    if (!kept.length) return null;
    this.usedCharacters += text.length;
    const ref = `M${this.evidence.size + 1}`;
    const identities = await this.service.repository.identities(
      this.scope.chatId,
      kept.map((m) => m.senderId),
    );
    const item = {
      participants: identities.map((i) => ({
        senderId: i.sender_id,
        name: i.nickname ?? i.real_name ?? i.sender_id,
      })),
      ref,
      text,
      messageIds: kept.map((m) => m.id),
      dates: kept.map((m) => m.sentAt),
      senderIds: kept.map((m) => m.senderId),
    };
    for (const m of kept)
      await this.service.repository.pool.query(
        "INSERT INTO memory_retrieval_sources VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [this.id, ref, m.id, m.hash, m.excerptStart ?? 0, m.excerptEnd ?? null],
      );
    if (Date.now() >= this.deadline) return null;
    this.evidence.set(ref, { item, messages: kept });
    return item;
  }
  async search(query: MemorySearch): Promise<MemorySearchResult> {
    const remaining = Math.max(0, 5000 - this.elapsed);
    if (!remaining)
      return {
        status: "unavailable",
        retrievalMode: "keyword-only",
        evidence: [],
        coverage: { total: 0, indexed: 0, pending: 0 },
        retrievalId: this.id,
        truncated: true,
      };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.searchWithinBudget(query),
        new Promise<MemorySearchResult>((resolve) => {
          timer = setTimeout(() => {
            this.deadline = 0;
            this.elapsed = 5000;
            resolve({
              status: "unavailable",
              retrievalMode: "keyword-only",
              evidence: [],
              coverage: { total: 0, indexed: 0, pending: 0 },
              retrievalId: this.id,
              truncated: true,
            });
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async searchWithinBudget(
    query: MemorySearch,
  ): Promise<MemorySearchResult> {
    const started = Date.now();
    this.deadline = started + Math.max(0, 5000 - this.elapsed);
    const repository = this.service.repository;
    const result: MemorySearchResult = {
      status: "unavailable",
      retrievalMode: "keyword-only",
      evidence: [],
      coverage: { total: 0, indexed: 0, pending: 0 },
      retrievalId: this.id,
      truncated: false,
    };
    if (
      ++this.searches > 2 ||
      this.elapsed >= 5000 ||
      !(await repository.allowed(this.scope))
    )
      return result;
    try {
      result.coverage = await repository.coverage(this.scope);
      const generation = this.scope.generation;
      const secret = generation.encrypted_secret
        ? repository.cipher.decrypt(generation.encrypted_secret)
        : null;
      let keywordFailed = false;
      const keywordPromise = repository
        .candidates(this.scope, query, null)
        .catch(() => {
          keywordFailed = true;
          return [];
        });
      let vector: number[] | null = null;
      try {
        if (
          (await this.service.embedding.identity(
            generation.config,
            secret,
            Math.max(1, Math.min(1500, this.deadline - Date.now())),
          )) !== generation.identity
        )
          throw new EmbeddingError("MEMORY_MODEL_CHANGED");
        vector =
          (
            await this.service.embedding.encode(
              generation.config,
              secret,
              [generation.config.queryPrefix + query.query],
              Math.max(1, 5000 - this.elapsed - (Date.now() - started)),
            )
          )[0] ?? null;
      } catch {
        vector = null;
      }
      const keywords = await keywordPromise;
      if (Date.now() >= this.deadline)
        throw new Error("MEMORY_BUDGET_EXHAUSTED");
      const semantic = vector
        ? await repository.candidates(this.scope, query, vector)
        : [];
      if (keywordFailed && !vector)
        throw new Error("MEMORY_RETRIEVAL_UNAVAILABLE");
      result.retrievalMode = vector ? "hybrid" : "keyword-only";
      for (const candidate of fuseRanks([keywords, semantic]).slice(0, 5)) {
        const messages = await repository.excerpt(this.scope, candidate.id);
        const evidence = await this.add(messages);
        if (evidence) result.evidence.push(evidence);
      }
      if (
        result.coverage.pending > 0 &&
        result.evidence.length < 5 &&
        Date.now() < this.deadline
      ) {
        const fallback = await repository.unindexed(this.scope, query);
        for (const message of fallback) {
          if (result.evidence.length >= 5) break;
          const evidence = await this.add([message]);
          if (evidence) result.evidence.push(evidence);
        }
      }
      result.truncated =
        this.usedCharacters >= 5500 || Date.now() >= this.deadline;
      result.status =
        result.coverage.pending > 0
          ? "partial"
          : result.evidence.length
            ? "succeeded"
            : "no-results";
      if (!(await this.validate())) {
        result.status = "unavailable";
        result.evidence = [];
      }
    } catch {
      result.status = "unavailable";
      result.evidence = [];
    } finally {
      this.elapsed += Date.now() - started;
      await repository.pool.query(
        "UPDATE memory_retrievals SET status=$2,mode=$3,duration_ms=$4 WHERE id=$1",
        [this.id, result.status, result.retrievalMode, this.elapsed],
      );
    }
    if (Date.now() >= this.deadline) {
      result.status = "unavailable";
      result.evidence = [];
      result.truncated = true;
    }
    return result;
  }
  async execute(name: string, args: string): Promise<string> {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (name === "search_chat_history") {
        const result = await this.search(memorySearchSchema.parse(parsed));
        return JSON.stringify({
          status: result.status,
          retrievalMode: result.retrievalMode,
          coverage: result.coverage,
          truncated: result.truncated,
          evidence: result.evidence.map(({ ref, text, participants }) => ({
            ref,
            text,
            participants,
          })),
        });
      }
      if (
        name !== "read_chat_excerpt" ||
        ++this.reads > 3 ||
        this.elapsed >= 5000
      )
        return JSON.stringify({ status: "unavailable", reason: "tool-limit" });
      const ref =
        typeof parsed === "object" &&
        parsed !== null &&
        "ref" in parsed &&
        Object.keys(parsed).length === 1 &&
        typeof parsed.ref === "string"
          ? parsed.ref
          : null;
      const started = Date.now();
      const remaining = Math.max(0, 5000 - this.elapsed);
      this.deadline = started + remaining;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const entry = ref ? this.evidence.get(ref) : undefined;
            if (!entry || !(await this.validate()))
              return JSON.stringify({
                status: "unavailable",
                reason: "source-unavailable",
              });
            const first = entry.messages[0],
              last = entry.messages.at(-1);
            if (!first || !last) return "{}";
            const messages = await this.service.repository.messages(
              this.scope.chatId,
              Math.max(1, first.index - 2),
              Math.min(this.scope.upperIndex - 1, last.index + 2),
            );
            const evidence = await this.add(messages);
            return JSON.stringify({
              status: evidence ? "succeeded" : "no-results",
              evidence: evidence
                ? [
                    {
                      ref: evidence.ref,
                      text: evidence.text,
                      participants: evidence.participants,
                    },
                  ]
                : [],
            });
          })(),
          new Promise<string>((resolve) => {
            timer = setTimeout(() => {
              this.deadline = 0;
              resolve(
                JSON.stringify({
                  status: "unavailable",
                  reason: "tool-budget",
                }),
              );
            }, remaining);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        this.elapsed += Date.now() - started;
      }
    } catch {
      return JSON.stringify({
        status: "unavailable",
        reason: "invalid-or-unavailable",
      });
    }
  }
  async validate(): Promise<boolean> {
    if (!(await this.service.repository.allowed(this.scope))) return false;
    for (const entry of this.evidence.values())
      for (const m of entry.messages) {
        const current = (
          await this.service.repository.messages(
            this.scope.chatId,
            m.index,
            m.index,
          )
        )[0];
        if (current?.hash !== m.hash) return false;
      }
    return true;
  }
  references(): string[] {
    return [...this.evidence.keys()];
  }
  render(text: string, outputFormat: "text" | "json" = "text"): string | null {
    const refs = [...text.matchAll(/\[(M\d+)\]/gu)].map((m) => m[1] ?? "");
    if (
      refs.some((ref) => !this.evidence.has(ref)) ||
      (this.evidence.size > 0 && !refs.length)
    )
      return null;
    const replace = (value: string) =>
      value.replace(/\[(M\d+)\]/gu, (_match, ref: string) => {
        const item = this.evidence.get(ref)?.item;
        return item
          ? `（${[...new Set(item.dates.map((d) => d.slice(0, 10)))].join("、")}，${[...new Set(item.senderIds.map((id) => item.participants.find((p) => p.senderId === id)?.name ?? id))].join("、")}）`
          : "";
      });
    const transform = (value: unknown): unknown => {
      if (typeof value === "string") return replace(value);
      if (Array.isArray(value)) return value.map(transform);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, transform(item)]),
        );
      return value;
    };
    if (outputFormat === "text") return replace(text);
    try {
      return JSON.stringify(transform(JSON.parse(text)));
    } catch {
      return null;
    }
  }
}
