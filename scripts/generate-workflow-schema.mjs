import { writeFile } from "node:fs/promises";

import { z } from "zod";

const definitionModule = /** @type {unknown} */ (
  await import("../dist/modules/workflow/workflow-definition.js")
);
const graphModule = /** @type {unknown} */ (
  await import("../dist/modules/workflow/workflow-graph.js")
);
if (
  definitionModule === null ||
  typeof definitionModule !== "object" ||
  !("workflowDefinitionSchema" in definitionModule) ||
  graphModule === null ||
  typeof graphModule !== "object" ||
  !("workflowGraphSchema" in graphModule)
) {
  throw new Error("The compiled workflow schemas are unavailable.");
}
const workflowDefinitionSchema = definitionModule.workflowDefinitionSchema;
const workflowGraphSchema = graphModule.workflowGraphSchema;

const schema = z.toJSONSchema(
  z.union([workflowDefinitionSchema, workflowGraphSchema]),
  {
    target: "draft-2020-12",
    unrepresentable: "any",
  },
);
schema.$id = "https://bubblepilot.local/contracts/workflow.schema.json";
schema.title = "BubblePilot Workflow Definition";

await writeFile(
  "contracts/workflow.schema.json",
  `${JSON.stringify(schema, null, 2)}\n`,
);
