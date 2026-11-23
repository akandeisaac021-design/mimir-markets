import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID,
  ReleaseEvidenceArtifactPathError,
  buildReleaseEvidenceManifest,
  evaluateReleaseEvidenceManifest,
  parseReleaseEvidenceManifest,
  resolveEvidenceArtifactPath,
  type ReleaseEvidenceManifest,
} from "../../lib/ops/release-evidence-manifest";
import { RELEASE_GATE_IDS } from "../../lib/ops/release-readiness";

const REPO_ROOT = process.cwd();
const REVISION = "a".repeat(40);
const ARTIFACT_RELATIVE = "evidence/provenance.txt";
const ARTIFACT_CONTENT = "synthetic release evidence";

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function temporaryRoot(): { parent: string; root: string } {
  const parent = mkdtempSync(path.join(tmpdir(), "mimir-evidence-"));
  const root = path.join(parent, "root");
  mkdirSync(root);
  return { parent, root };
}

function writeArtifact(root: string, relative: string, content: string): string {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  return digest(content);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildValidManifest(root: string): ReleaseEvidenceManifest {
  const sha256 = writeArtifact(root, ARTIFACT_RELATIVE, ARTIFACT_CONTENT);
  const results = Object.fromEntries(
    RELEASE_GATE_IDS.map((id) => [
      id,
      {
        status: "pass" as const,
        detail: `${id} passed the recorded check`,
      },
    ]),
  );
  return buildReleaseEvidenceManifest({
    repoRoot: REPO_ROOT,
    artifactRoot: root,
    revision: REVISION,
    results,
    artifactPaths: { "deployment-verification": [ARTIFACT_RELATIVE] },
  });
}

function evaluate(
  manifest: unknown,
  artifactRoot: string,
  overrides: Record<string, unknown> = {},
) {
  return evaluateReleaseEvidenceManifest(manifest, {
    repoRoot: REPO_ROOT,
    artifactRoot,
    mode: "release",
    expectedRevision: REVISION,
    ...overrides,
  });
}

function findingCodes(report: {
  findings: Array<{ code: string; gateId?: string }>;
}): string[] {
  return report.findings.map((finding) => finding.code);
}

test("positive: a revision-bound manifest with artifact digests is ready", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = buildValidManifest(root);
  const parsed = parseReleaseEvidenceManifest(clone(manifest));
  const report = evaluate(parsed, root);

  assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
  assert.equal(report.releaseReady, true);
  assert.deepEqual(findingCodes(report), []);
  assert.equal(report.revision, REVISION);
  assert.equal(report.artifactCount, 1);
  assert.match(report.schemaIdentityDigest ?? "", /^[0-9a-f]{64}$/);
});

test("negative: mixed-revision gate results are refused", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  manifest.results["onchain-smoke"]!.revision = "b".repeat(40);
  const report = evaluate(manifest, root);

  assert.equal(report.ok, false);
  assert.equal(report.releaseReady, false);
  const finding = report.findings.find(
    (entry) => entry.code === "EVIDENCE_MIXED_REVISION",
  );
  assert.equal(finding?.gateId, "onchain-smoke");
  assert.match(finding?.message ?? "", /mixed-revision evidence is refused/);
});

test("negative: a required gate result cannot be omitted", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  delete manifest.results["deployment-verification"];
  delete manifest.commands["deployment-verification"];
  delete manifest.artifacts["deployment-verification"];
  const report = evaluate(manifest, root);

  const finding = report.findings.find(
    (entry) => entry.code === "EVIDENCE_MISSING_RESULT",
  );
  assert.equal(finding?.gateId, "deployment-verification");
  assert.equal(report.releaseReady, false);
});

test("negative: a stale manifest revision is refused against HEAD", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = buildValidManifest(root);
  const report = evaluate(manifest, root, {
    expectedRevision: "c".repeat(40),
  });

  assert.ok(
    report.findings.some((finding) => finding.code === "EVIDENCE_REVISION_MISMATCH"),
  );
});

test("negative: check commands must match the reviewed registry", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  manifest.commands["typecheck"] = "echo not-the-review-check";
  const report = evaluate(manifest, root);

  assert.ok(
    report.findings.some(
      (finding) =>
        finding.code === "EVIDENCE_COMMAND_MISMATCH" &&
        finding.gateId === "typecheck",
    ),
  );
});

test("negative: a stale schema identity is refused", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  manifest.schemaIdentity.schemaSnapshot.fingerprint = "0".repeat(64);
  const report = evaluate(manifest, root);

  assert.ok(
    report.findings.some(
      (finding) => finding.code === "EVIDENCE_SCHEMA_IDENTITY_MISMATCH",
    ),
  );
});

test("negative: a digest mismatch fails closed", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  manifest.results["deployment-verification"]!.artifacts[0]!.sha256 =
    "0".repeat(64);
  const report = evaluate(manifest, root);

  assert.ok(
    report.findings.some(
      (finding) => finding.code === "EVIDENCE_ARTIFACT_DIGEST_MISMATCH",
    ),
  );
});

test("failure: an artifact path escaping the root is refused before reading", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const outside = "outside-evidence.txt";
  const sha256 = writeArtifact(parent, outside, "outside root content");
  const manifest = clone(buildValidManifest(root));
  manifest.artifacts["deployment-verification"] = [];
  manifest.results["deployment-verification"]!.artifacts = [
    { path: `../${outside}`, sha256 },
  ];

  assert.throws(
    () => resolveEvidenceArtifactPath(root, `../${outside}`),
    (error: unknown) =>
      error instanceof ReleaseEvidenceArtifactPathError &&
      error.code === RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID &&
      error.reason === "parent-segment",
  );

  const report = evaluate(manifest, root);
  const finding = report.findings.find(
    (entry) => entry.code === RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID,
  );
  assert.equal(finding?.gateId, "deployment-verification");
  assert.match(finding?.message ?? "", /escapes the explicit evidence root/);
});

test("failure: a symlinked artifact path is refused before reading", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const outside = path.join(parent, "symlink-target.txt");
  const sha256 = writeArtifact(parent, "symlink-target.txt", "symlink target");
  mkdirSync(path.join(root, "evidence"), { recursive: true });
  symlinkSync(outside, path.join(root, "evidence", "linked.txt"), "file");

  assert.throws(
    () => resolveEvidenceArtifactPath(root, "evidence/linked.txt"),
    (error: unknown) =>
      error instanceof ReleaseEvidenceArtifactPathError &&
      error.code === RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID &&
      error.reason === "symlink",
  );

  const manifest = clone(buildValidManifest(root));
  manifest.artifacts["deployment-verification"] = [];
  manifest.results["deployment-verification"]!.artifacts = [
    { path: "evidence/linked.txt", sha256 },
  ];
  const report = evaluate(manifest, root);
  assert.ok(
    report.findings.some(
      (finding) => finding.code === RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID,
    ),
  );
});

test("failure: a manifest without artifact digests is refused", (t) => {
  const { parent, root } = temporaryRoot();
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const manifest = clone(buildValidManifest(root));
  manifest.artifacts = {};
  for (const result of Object.values(manifest.results)) {
    result.artifacts = [];
  }
  const report = evaluate(manifest, root);

  assert.ok(
    report.findings.some(
      (finding) => finding.code === "EVIDENCE_ARTIFACT_DIGEST_MISSING",
    ),
  );
});

test("negative: a legacy evidence document is not a manifest", () => {
  assert.throws(
    () =>
      parseReleaseEvidenceManifest({
        schemaVersion: 1,
        kind: "mimir-release-readiness",
        results: {},
      }),
    /kind must be/,
  );
});
