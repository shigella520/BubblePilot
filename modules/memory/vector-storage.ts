import {
  embeddingPrecisionLimits,
  type EmbeddingPrecision,
} from "./embedding-client.js";

/**
 * Where a generation's vectors live in memory_embeddings. float32 rows use
 * `embedding` (vector), float16 rows use `embedding_half` (halfvec). The
 * columns are untyped so several generations can coexist; search and the
 * HNSW index both use the same typed expression, e.g.
 * `(embedding::vector(1024))`, restricted to rows of that dimension.
 */
export interface VectorLayout {
  precision: EmbeddingPrecision;
  dimensions: number;
  column: "embedding" | "embedding_half";
  type: "vector" | "halfvec";
  /** Typed expression shared by the index and the search query. */
  expression: string;
  /** Rows this layout covers (the partial index predicate). */
  predicate: string;
  indexName: string;
  /** HNSW supports this dimension for this precision. */
  indexable: boolean;
}

export function vectorLayout(config: {
  dimensions: number;
  precision?: EmbeddingPrecision | undefined;
}): VectorLayout {
  const precision: EmbeddingPrecision =
    config.precision === "float16" ? "float16" : "float32";
  const dimensions = Number(config.dimensions);
  // Interpolated into SQL: only plain integers in the stored range pass.
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000)
    throw new Error("MEMORY_DIMENSIONS_INVALID");
  const column = precision === "float16" ? "embedding_half" : "embedding";
  const type = precision === "float16" ? "halfvec" : "vector";
  return {
    precision,
    dimensions,
    column,
    type,
    expression: `${column}::${type}(${dimensions})`,
    predicate: `dimensions = ${dimensions} AND ${column} IS NOT NULL`,
    indexName: `memory_embeddings_hnsw_${precision === "float16" ? "f16" : "f32"}_${dimensions}`,
    indexable: dimensions <= embeddingPrecisionLimits[precision],
  };
}

/** HNSW (cosine) index for one layout; null when pgvector cannot index it. */
export function vectorIndexSql(layout: VectorLayout): string | null {
  if (!layout.indexable) return null;
  return `CREATE INDEX IF NOT EXISTS ${layout.indexName} ON memory_embeddings
    USING hnsw ((${layout.expression}) ${layout.type}_cosine_ops)
    WHERE ${layout.predicate}`;
}
