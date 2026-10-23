import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{id:string,package:string,version:string,severity:string,type:string}} Entry
 * @typedef {{schemaVersion:number,expiresAt:string,sourceHashes:Record<string,string>,entries:Entry[]}} Baseline
 * @typedef {{VulnerabilityID:string,PkgName:string,InstalledVersion:string,Severity:string,FixedVersion?:string}} Finding
 * @typedef {{SchemaVersion:number,Metadata?:{ImageConfig?:{architecture?:string},OS?:{Family?:string}},Results?:{Class?:string,Type:string,Vulnerabilities?:Finding[]}[]}} Report
 */
/**
 * @param {Report} report
 * @param {Baseline} baseline
 * @param {Record<string,string>} hashes
 * @param {Date} now
 */
export function checkScan(report, baseline, hashes, now = new Date()) {
  if (
    baseline.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(baseline.expiresAt)) ||
    now.getTime() >= Date.parse(baseline.expiresAt)
  )
    throw new Error("Risk baseline expired or invalid");
  for (const [file, hash] of Object.entries(baseline.sourceHashes)) {
    if (hashes[file] !== hash)
      throw new Error("Runtime source changed: " + file);
  }
  if (
    report.SchemaVersion !== 2 ||
    report.Metadata?.ImageConfig?.architecture !== "amd64" ||
    report.Metadata?.OS?.Family !== "debian" ||
    !report.Results?.some(
      (r) => r.Class === "os-pkgs" && r.Type === "debian",
    ) ||
    !report.Results?.some((r) => r.Type === "python-pkg")
  )
    throw new Error("Incomplete or incompatible scan");
  /** @param {Entry} v */
  const key = (v) =>
    JSON.stringify([v.id, v.package, v.version, v.severity, v.type]);
  const allowed = new Set(baseline.entries.map(key));
  const blocked = [];
  let accepted = 0;
  for (const result of report.Results) {
    for (const v of result.Vulnerabilities ?? []) {
      if (!["HIGH", "CRITICAL"].includes(v.Severity)) continue;
      const entry = {
        id: v.VulnerabilityID,
        package: v.PkgName,
        version: v.InstalledVersion,
        severity: v.Severity,
        type: result.Type,
      };
      if (
        v.Severity === "CRITICAL" ||
        v.FixedVersion ||
        !allowed.has(key(entry))
      )
        blocked.push(entry);
      else accepted++;
    }
  }
  if (blocked.length)
    throw new Error(
      "Unapproved or fixable vulnerabilities: " + JSON.stringify(blocked),
    );
  return { acceptedRecords: accepted, expiresAt: baseline.expiresAt };
}

/** @param {string} text @returns {unknown} */
function parseJson(text) {
  return JSON.parse(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("./", import.meta.url);
  const baseline = /** @type {Baseline} */ (
    parseJson(readFileSync(new URL("risk-baseline.json", root), "utf8"))
  );
  const hashes = Object.fromEntries(
    Object.keys(baseline.sourceHashes).map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(new URL(file, root)))
        .digest("hex"),
    ]),
  );
  console.log(
    JSON.stringify(
      checkScan(
        /** @type {Report} */ (
          parseJson(readFileSync(process.argv[2], "utf8"))
        ),
        baseline,
        hashes,
      ),
    ),
  );
}
