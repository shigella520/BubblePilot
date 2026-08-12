import { writeFile } from "node:fs/promises";

import { z } from "zod";

const [{ workflowDefinitionSchema }, { workflowGraphSchema }] =
  await Promise.all([
    import("../dist/modules/workflow/workflow-definition.js"),
    import("../dist/modules/workflow/workflow-graph.js"),
  ]);

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
