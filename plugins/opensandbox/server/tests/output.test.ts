import { it, expect } from "vitest";
import { collectOutput, type OutputEvent } from "../src/backend.js";
async function* events(values: OutputEvent[]) {
  for (const value of values) yield await Promise.resolve(value);
}
it("captures only bounded output and marks an unknown result, not success", async () => {
  const result = await collectOutput(
    events([{ type: "stdout", text: "猫猫" }, { type: "execution_complete" }]),
    4,
  );
  expect(result).toMatchObject({
    stdout: "猫",
    truncated: true,
    exitCode: null,
  });
});
it("requires completion and preserves nonzero command failure", async () => {
  expect(
    await collectOutput(events([{ type: "stdout", text: "partial" }])),
  ).toMatchObject({ status: "result_unknown", exitCode: null });
  expect(
    await collectOutput(
      events([
        { type: "error", error: { evalue: "7" } },
        { type: "execution_complete" },
      ]),
    ),
  ).toMatchObject({ status: "command_failed", exitCode: 7 });
  expect(
    await collectOutput(events([{ type: "execution_complete" }])),
  ).toMatchObject({ status: "completed", exitCode: 0 });
});
