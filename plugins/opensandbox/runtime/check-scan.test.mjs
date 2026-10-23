import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScan } from "./check-scan.mjs";
const entry = {
  id: "CVE-fictional",
  package: "fictional-base",
  version: "1",
  severity: "HIGH",
  type: "debian",
};
const baseline = {
  schemaVersion: 1,
  expiresAt: "2026-11-22T00:00:00Z",
  sourceHashes: { Dockerfile: "hash" },
  entries: [entry],
};
const report = () => ({
  SchemaVersion: 2,
  Metadata: {
    ImageConfig: { architecture: "amd64" },
    OS: { Family: "debian" },
  },
  Results: [
    {
      Class: "os-pkgs",
      Type: "debian",
      Vulnerabilities: [
        {
          VulnerabilityID: entry.id,
          PkgName: entry.package,
          InstalledVersion: "1",
          Severity: "HIGH",
        },
      ],
    },
    { Type: "python-pkg", Vulnerabilities: [] },
  ],
});
const check = (
  r,
  b = baseline,
  h = { Dockerfile: "hash" },
  d = new Date("2026-10-23"),
) => checkScan(r, b, h, d);
test("accepts only reviewed records and allows resolved findings to disappear", () => {
  assert.equal(check(report()).acceptedRecords, 1);
  const r = report();
  r.Results[0].Vulnerabilities = [];
  assert.equal(check(r).acceptedRecords, 0);
});
test("blocks new CVE, package version, critical, and available fix", () => {
  for (const patch of [
    { VulnerabilityID: "CVE-new" },
    { InstalledVersion: "2" },
    { Severity: "CRITICAL" },
    { FixedVersion: "2" },
  ]) {
    const r = report();
    Object.assign(r.Results[0].Vulnerabilities[0], patch);
    assert.throws(() => check(r));
  }
});
test("blocks expiry, changed sources and incomplete or wrong architecture scans", () => {
  assert.throws(() => check(report(), baseline, { Dockerfile: "changed" }));
  assert.throws(() =>
    check(report(), baseline, { Dockerfile: "hash" }, new Date("2026-11-22")),
  );
  const r = report();
  r.Results.pop();
  assert.throws(() => check(r));
  r.Metadata.ImageConfig.architecture = "arm64";
  assert.throws(() => check(r));
});
