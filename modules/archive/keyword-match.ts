/**
 * Substring keyword matching on message bodies.
 *
 * messages_body_trgm_idx (pg_trgm) only helps when every keyword has at
 * least three characters: shorter patterns contain no complete trigram, so
 * the planner falls back to a full scan and loses the recent-first early
 * stop. Measured on production (48k messages, 2026-11-27): 3+ character
 * terms 0.2–10 ms with the index vs up to 140 ms without; two-character
 * Chinese terms such as 周报 4–49 ms with the plain form vs 170–225 ms with
 * the index form. Pick the form per query.
 */
export const trigramMinCharacters = 3;

export function trigramUsable(words: readonly string[]): boolean {
  return (
    words.length > 0 &&
    words.every((word) => [...word.trim()].length >= trigramMinCharacters)
  );
}

/** SQL condition for one keyword parameter (already a placeholder). */
export function keywordCondition(parameter: string, trigram: boolean): string {
  return trigram
    ? `(m.content_redacted_at IS NULL AND lower(m.body) LIKE '%'||replace(replace(replace(lower(${parameter}::text),'\\','\\\\'),'%','\\%'),'_','\\_')||'%' ESCAPE '\\')`
    : `strpos(lower(coalesce(m.body,'')),lower(${parameter}::text))>0`;
}
