// Local cached-Docker benchmark, not an OpenSandbox/NAS latency measurement.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const images = process.argv.slice(2);
if (!images.length) throw new Error("Pass baseline and/or runtime image names");
for (const image of images) {
  const report = {
    image,
    platform: "linux/amd64",
    scope: "local cached Docker; may be emulated",
    expandedBytes: Number(
      docker("image", "inspect", "--format", "{{.Size}}", image),
    ),
    startsMs: [],
  };
  for (let i = 0; i < 3; i++) {
    let id;
    try {
      const start = performance.now();
      id = docker(
        "run",
        "-d",
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
        "--mount",
        `type=bind,src=${resolve("plugins/opensandbox/runtime/smoke.py")},dst=/tmp/smoke.py,readonly`,
        image,
        "sleep",
        "120",
      );
      docker("exec", id, "python", "-c", "print(42)");
      report.startsMs.push(Math.round(performance.now() - start));
      if (i === 0) {
        report.idleMemory = docker(
          "stats",
          "--no-stream",
          "--format",
          "{{.MemUsage}}",
          id,
        );
        if (image.includes("bubblepilot-sandbox-python")) {
          report.workload = docker("exec", id, "python", "/tmp/smoke.py");
          report.postWorkloadMemory = docker(
            "stats",
            "--no-stream",
            "--format",
            "{{.MemUsage}}",
            id,
          );
        }
      }
      if (docker("inspect", "--format", "{{.State.OOMKilled}}", id) !== "false")
        throw new Error("OOM");
    } finally {
      if (id) docker("rm", "-f", id);
    }
  }
  console.log(JSON.stringify(report));
}
