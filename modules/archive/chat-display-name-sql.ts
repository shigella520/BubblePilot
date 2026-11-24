/** Shared read-time name for admin views; never rewrite gateway metadata. */
export function chatDisplayNameSql(alias: "c" | "source_chat"): string {
  const peer = `NULLIF(BTRIM(split_part(${alias}.provider_chat_id, ';', 3)), '')`;
  return `CASE WHEN ${alias}.provider='bluebubbles' AND ${alias}.type='direct'
    THEN COALESCE(
      (SELECT COALESCE(NULLIF(BTRIM(identity.real_name), ''), NULLIF(BTRIM(identity.nickname), ''))
       FROM chat_participant_identities identity
       WHERE identity.chat_id=${alias}.id AND identity.sender_id=${peer}
         AND identity.sender_id<>'self'),
      ${peer}, NULLIF(BTRIM(${alias}.display_name), ''), ${alias}.provider_chat_id)
    ELSE ${alias}.display_name END`;
}
