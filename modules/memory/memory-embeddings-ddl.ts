/**
 * memory_embeddings lives outside the migrations because it needs pgvector,
 * which is optional (app/prepare-memory.ts). Each row stores float32
 * (`embedding`) or float16 (`embedding_half`) by its generation's precision;
 * chat and generation are copied from the chunk for filtered vector search.
 * Migration 0083 upgrades tables created by the earlier definition.
 */
export const memoryEmbeddingsDdl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memory_embeddings (
    chunk_id UUID PRIMARY KEY REFERENCES memory_chunks(id) ON DELETE CASCADE,
    dimensions INTEGER NOT NULL,
    embedding vector,
    embedding_half halfvec,
    chat_id UUID NOT NULL,
    generation_id UUID NOT NULL,
    CONSTRAINT memory_embeddings_vector_check CHECK (
      (embedding IS NULL) <> (embedding_half IS NULL)
      AND dimensions BETWEEN 1 AND 16000
      AND dimensions = CASE WHEN embedding IS NOT NULL THEN vector_dims(embedding) ELSE vector_dims(embedding_half) END)
  )`,
  "CREATE INDEX IF NOT EXISTS memory_embeddings_scope_idx ON memory_embeddings (generation_id, chat_id)",
];
