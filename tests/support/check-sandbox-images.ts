import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { imageHelper } from "../../plugins/opensandbox/server/src/images.js";

// This probe is offline and uses fictional files only.
const image = process.argv[2];
if (!image)
  throw new Error(
    "Usage: pnpm exec tsx tests/support/check-sandbox-images.ts <runtime-image>",
  );
const probe = await readFile(
  new URL(
    "../../plugins/opensandbox/server/tests/image-preview-probe.py",
    import.meta.url,
  ),
  "utf8",
);
const helper = Buffer.from(imageHelper).toString("base64");
const source = `import base64,tempfile,os\nhelper_path=os.path.join(tempfile.mkdtemp(prefix='bp-image-probe-'),'helper.py')\nopen(helper_path,'wb').write(base64.b64decode('${helper}'))\n${probe}`;
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    image,
    "python",
    "-I",
    "-",
  ],
  { input: source, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
