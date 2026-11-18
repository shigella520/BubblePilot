// Actual local OpenSandbox proxy + MCP + binary export. Never use production URLs.
import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {randomUUID,createHash} from "node:crypto";
const {Sandbox}=await import(new URL("../../../plugins/opensandbox/server/node_modules/@alibaba-group/opensandbox/dist/index.js",import.meta.url).href);
import {sdkBackend} from "../../../plugins/opensandbox/server/src/backend.js";
import {SandboxPool} from "../../../plugins/opensandbox/server/src/lifecycle.js";
import {createMcpHttp} from "../../../plugins/opensandbox/server/src/http.js";
import {configSchema} from "../../../plugins/opensandbox/server/src/config.js";
import {PluginMcp} from "../../../modules/plugins/plugin-mcp.js";
import {validateGeneratedPng} from "../../../modules/generated-images/image-store.js";
const url=process.env.SPIKE_URL;
assert(url && new URL(url).hostname==="127.0.0.1");
assert(process.env.SPIKE_KEY_FILE);
const key=(await readFile(process.env.SPIKE_KEY_FILE,"utf8")).trim();
const config=configSchema.parse({OPENSANDBOX_URL:url,SANDBOX_IMAGE:"python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704",ADAPTER_INSTANCE_ID:`svg-probe-${randomUUID()}`,MCP_TOKEN_FILE:"unused",OPENSANDBOX_API_KEY_FILE:"unused",SANDBOX_CREATE_TIMEOUT_SECONDS:120});
// Only this local experiment may use a just-built tag and select amd64 on a Mac.
config.SANDBOX_IMAGE="bubblepilot-sandbox-python:svg-test";
const create=Sandbox.create;
Sandbox.create=(options)=>create.call(Sandbox,{...options,platform:{os:"linux",arch:"amd64"}});
const backend=sdkBackend(config,key),pool=new SandboxPool(backend,1,300_000,{createSeconds:120,importSeconds:45});
const token=randomUUID(),server=createMcpHttp(pool,token),client=new PluginMcp();
await new Promise<void>((resolve)=>server.http.listen(0,"127.0.0.1",resolve));
const address=server.http.address();assert(address && typeof address!=="string");
const signal=AbortSignal.timeout(180_000);
try {
  await client.connect({url:`http://127.0.0.1:${address.port}/mcp`,auth:"bearer",secret:token,allowPrivate:true,header:"X-Key",callTimeoutSeconds:120},signal);
  const tools=await client.discover("sandbox",signal);
  const prepare=tools.find((t)=>t.definition.name==="prepare_sandbox")!;
  const run=tools.find((t)=>t.definition.name==="run_command")!;
  assert.equal(prepare.imageExportVersion,1);
  const prepared=await client.call(prepare,{},signal,120_000);assert.equal(prepared.status,"success");
  const svg=(await readFile(new URL("./chart.svg",import.meta.url))).toString("base64");
  const command=`python - <<'PY'\nimport base64,subprocess,hashlib,json\nfrom pathlib import Path\nPath('/workspace/chart.svg').write_bytes(base64.b64decode('${svg}'))\nsubprocess.run(['bp-render-svg','/workspace/chart.svg','/workspace/chart.png','--width','2400'],check=True)\nprint(json.dumps({'sha256':hashlib.sha256(Path('/workspace/chart.png').read_bytes()).hexdigest()}))\nPY`;
  const rendered=await client.call(run,{command,timeout_seconds:30},signal,35_000);
  assert.equal(rendered.status,"success",JSON.stringify(rendered.content));
  const bytes=await client.exportImage("/workspace/chart.png",signal);
  const metadata=await validateGeneratedPng(bytes);
  assert.equal(metadata.width,2400);assert.equal(metadata.height,1520);
  assert(JSON.stringify(rendered.content).includes(metadata.sha256));
  await client.call(run,{command:"ln -s /workspace/chart.png /workspace/link.png",timeout_seconds:10},signal,15_000);
  await assert.rejects(client.exportImage("/workspace/link.png",signal));
  await assert.rejects(client.exportImage("/workspace/../etc/passwd",signal));
  // Invalid export does not invalidate an otherwise healthy sandbox.
  assert.equal(createHash("sha256").update(await client.exportImage("/workspace/chart.png",signal)).digest("hex"),metadata.sha256);
  await mkdir(new URL("./output/",import.meta.url),{recursive:true});
  await writeFile(new URL("./output/runtime-chart.png",import.meta.url),bytes);
  console.log(JSON.stringify({status:"passed",...metadata,actualOpenSandboxProxy:true,actualMcpExport:true,sourceHashMatched:true}));
} finally {
  await client.close();await server.close();
  for(const session of pool.sessions) session.invalidate();
  await pool.sweep();
  const remaining=await backend.owned();
  for(const id of remaining) await backend.remove(id);
  assert.deepEqual(await backend.owned(),[]);
  await backend.close();Sandbox.create=create;
}
