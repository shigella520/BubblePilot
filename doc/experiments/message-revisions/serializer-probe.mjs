// Research only: execute two hash-pinned upstream modules with fictional data.
// All gateway, database and attachment dependencies are stubs. No network calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const directory = process.argv[2];
assert.ok(directory, "Pass the directory containing pinned upstream sources");
const hashes = {
  "serializer.ts":
    "801707c1fcdbd032816606e6162977e38b66cee95c92e54f2e07bcf63ce31e57",
  "constants.ts":
    "b298b7ca4b2417e031037eb6323d4beeca3e4e5d00b00737f5135e3f6ffbf895",
};
function load(name, dependencies) {
  const source = readFileSync(join(directory, name), "utf8");
  assert.equal(createHash("sha256").update(source).digest("hex"), hashes[name]);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    Buffer,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected import: ${id}`);
      return dependencies[id];
    },
  });
  return exports;
}
const empty = (value) =>
  value == null || value === "" || (Array.isArray(value) && !value.length);
const constants = load("constants.ts", {});
const { MessageSerializer } = load("serializer.ts", {
  "./constants": constants,
  "@server": {
    Server() {
      throw new Error("Unexpected gateway access");
    },
  },
  "@server/helpers/utils": {
    isEmpty: empty,
    isNotEmpty: (value) => !empty(value),
  },
  "@server/env": {
    isMinHighSierra: true,
    isMinMonterey: true,
    isMinVentura: true,
  },
  "./AttachmentSerializer": {
    AttachmentSerializer: {
      serializeList: async ({ attachments }) => attachments,
    },
  },
  "./ChatSerializer": {
    ChatSerializer: { serializeList: async ({ chats }) => chats },
  },
  "./HandleSerializer": {
    HandleSerializer: { serialize: async ({ handle }) => handle },
  },
});
const message = {
  guid: "fictional-message-102",
  universalText: () => "改成十点吧",
  attributedBody: [{ string: "改成十点吧" }],
  messageSummaryInfo: [{ retractedParts: [1] }],
  threadOriginatorGuid: "fictional-message-098",
  threadOriginatorPart: "fictional-part-0",
  dateCreated: new Date("2026-11-11T01:00:00Z"),
  dateEdited: new Date("2026-11-11T01:01:00Z"),
  partCount: 1,
  attachments: [],
  chats: [{ guid: "fictional-chat", style: 45 }],
  isFromMe: false,
};
const serialize = (options) =>
  MessageSerializer.serialize({ message, ...options });
// Configurations copied from the pinned server handleNew/UpdatedMessage paths.
const webhookNew = await serialize({
  config: { enforceMaxSize: true },
  isForNotification: true,
});
const webhookUpdate = await serialize({
  config: { loadChatParticipants: false, includeChats: false },
  isForNotification: true,
});
const socketUpdate = await serialize({
  config: {
    parseAttributedBody: true,
    parseMessageSummary: true,
    parsePayloadData: true,
    loadChatParticipants: false,
    includeChats: true,
  },
});
// Serializer portion of REST find with explicit detail selections, not HTTP E2E.
const restDetail = await serialize({
  config: { parseAttributedBody: true, parseMessageSummary: true },
});
assert.equal(webhookNew.threadOriginatorGuid, message.threadOriginatorGuid);
assert.equal(webhookNew.threadOriginatorPart, undefined);
assert.equal(webhookNew.messageSummaryInfo, null);
assert.equal(webhookUpdate.chats, undefined);
assert.equal(webhookUpdate.messageSummaryInfo, null);
assert.equal(webhookUpdate.attributedBody, null);
assert.equal(webhookUpdate.threadOriginatorPart, undefined);
assert.equal(webhookUpdate.dateEdited, message.dateEdited.getTime());
assert.equal(webhookUpdate.partCount, 1);
for (const detail of [socketUpdate, restDetail]) {
  assert.equal(detail.messageSummaryInfo[0].retractedParts[0], 1);
  assert.equal(detail.threadOriginatorPart, message.threadOriginatorPart);
  assert.equal(detail.attributedBody[0].string, "改成十点吧");
}
console.log(
  "PASS: 15 assertions on pinned upstream serializer; synthetic data only.",
);
console.log("Webhook omits summary/part; updated webhook omits chats.");
console.log(
  "Socket/REST detail serializer retains explicitly requested fields.",
);
