import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  RELEASE_GATE_IDS,
  RELEASE_READINESS_KIND,
  RELEASE_READINESS_SCHEMA_VERSION,
  canonicalJson,
  evaluateReleaseReadiness,
  getReleaseGate,
  isReleaseGateId,
  releaseReadinessFingerprint,
  type ReleaseEvidence,
  type ReleaseFinding,
  type ReleaseGateEvidence,
  type ReleaseReadinessReport,
} from "./release-readiness";
import {
  DEFAULT_SCHEMA_SNAPSHOT_RELATIVE,
  loadSchemaSnapshot,
  sha256Hex,
  type SchemaSnapshot,
} from "./schema-snapshot";

export const RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RELEASE_EVIDENCE_MANIFEST_KIND = "mimir-release-evidence-manifest" as const;
export const RELEASE_EVIDENCE_MANIFEST_HASH_ALGORITHM = "sha256" as const;

export const RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID = "EVIDENCE_ARTIFACT_PATH_INVALID" as const;

export type ReleaseEvidenceArtifactPathReason =
  | "empty"
  | "absolute"
  | "parent-segment"
  | "outside-root"
  | "symlink"
  | "not-a-file"
  | "invalid";

export interface ReleaseEvidenceArtifact {
  path: string;
  sha256: string;
}

export interface ReleaseEvidenceSchemaIdentity {
  readinessFingerprint: string;
  schemaSnapshot: {
    schemaVersion: number;
    hashAlgorithm: string;
    source: string;
    fingerprint: string;
  };
  digest: string;
}

export interface ReleaseEvidenceManifestResult extends ReleaseGateEvidence {
  revision?: string;
  command?: string;
  artifacts: ReleaseEvidenceArtifact[];
}

export interface ReleaseEvidenceManifest {
  schemaVersion: typeof RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION;
  kind: typeof RELEASE_EVIDENCE_MANIFEST_KIND;
  revision: string;
  schemaIdentity: ReleaseEvidenceSchemaIdentity;
  commands: Record<string, string>;
  artifacts: Record<string, ReleaseEvidenceArtifact[]>;
  results: Record<string, ReleaseEvidenceManifestResult>;
}

export interface ReleaseEvidenceManifestReport extends ReleaseReadinessReport {
  revision: string | null;
  artifactCount: number;
  schemaIdentityDigest: string | null;
}

export interface EvaluateReleaseEvidenceManifestOptions {
  repoRoot: string;
  artifactRoot?: string;
  mode?: ReleaseReadinessReport["mode"];
  expectedRevision?: string;
  schemaIdentity?: ReleaseEvidenceSchemaIdentity;
  snapshotPath?: string;
}

export class ReleaseEvidenceArtifactPathError extends Error {
  readonly code = RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID;
  readonly reason: ReleaseEvidenceArtifactPathReason;
  readonly artifactPath: string;

  constructor(
    reason: ReleaseEvidenceArtifactPathReason,
    artifactPath: string,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseEvidenceArtifactPathError";
    this.reason = reason;
    this.artifactPath = artifactPath;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{7,64}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeRevision(value: string): string {
  return value.toLowerCase();
}

function parseArtifact(value: unknown, field: string): ReleaseEvidenceArtifact {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const digest = value.sha256 ?? value.digest;
  return {
    path: asNonEmptyString(value.path, `${field}.path`),
    sha256: asNonEmptyString(digest, `${field}.sha256`),
  };
}

function parseArtifacts(value: unknown, field: string): ReleaseEvidenceArtifact[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) =>
    parseArtifact(entry, `${field}[${index}]`),
  );
}

function parseArtifactMap(
  value: unknown,
  field: string,
): Record<string, ReleaseEvidenceArtifact[]> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const parsed: Record<string, ReleaseEvidenceArtifact[]> = {};
  for (const [gateId, artifacts] of Object.entries(value)) {
    if (!isReleaseGateId(gateId)) {
      throw new Error(`${field} references unknown release gate "${gateId}"`);
    }
    parsed[gateId] = parseArtifacts(artifacts, `${field}.${gateId}`);
  }
  return parsed;
}

function parseCommandMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const parsed: Record<string, string> = {};
  for (const [gateId, command] of Object.entries(value)) {
    if (!isReleaseGateId(gateId)) {
      throw new Error(`${field} references unknown release gate "${gateId}"`);
    }
    parsed[gateId] = asNonEmptyString(command, `${field}.${gateId}`);
  }
  return parsed;
}

function parseSchemaIdentity(value: unknown): ReleaseEvidenceSchemaIdentity {
  if (!isPlainObject(value)) {
    throw new Error("schemaIdentity must be an object");
  }
  const snapshot = value.schemaSnapshot ?? value.snapshot;
  if (!isPlainObject(snapshot)) {
    throw new Error("schemaIdentity.schemaSnapshot must be an object");
  }
  return {
    readinessFingerprint: asNonEmptyString(
      value.readinessFingerprint,
      "schemaIdentity.readinessFingerprint",
    ).toLowerCase(),
    schemaSnapshot: {
      schemaVersion: snapshot.schemaVersion as number,
      hashAlgorithm: asNonEmptyString(
        snapshot.hashAlgorithm,
        "schemaIdentity.schemaSnapshot.hashAlgorithm",
      ),
      source: asNonEmptyString(
        snapshot.source,
        "schemaIdentity.schemaSnapshot.source",
      ),
      fingerprint: asNonEmptyString(
        snapshot.fingerprint,
        "schemaIdentity.schemaSnapshot.fingerprint",
      ).toLowerCase(),
    },
    digest: asNonEmptyString(value.digest, "schemaIdentity.digest").toLowerCase(),
  };
}

function parseManifestResult(
  value: unknown,
  gateId: string,
): ReleaseEvidenceManifestResult {
  if (!isPlainObject(value)) throw new Error(`results.${gateId} must be an object`);
  for (const key of Object.keys(value)) {
    if (
      !["status", "detail", "artifact", "revision", "command", "artifacts"].includes(key)
    ) {
      throw new Error(
        `results.${gateId}.${key} is not allowed — a manifest records pass/fail evidence only`,
      );
    }
  }
  const status = value.status;
  if (status !== "pass" && status !== "fail") {
    throw new Error(
      `results.${gateId}.status must be "pass" or "fail" (got ${JSON.stringify(status)})`,
    );
  }
  const result: ReleaseEvidenceManifestResult = {
    status,
    artifacts: parseArtifacts(value.artifacts, `results.${gateId}.artifacts`),
  };
  if (value.detail !== undefined) {
    result.detail = asNonEmptyString(value.detail, `results.${gateId}.detail`);
  }
  if (value.artifact !== undefined) {
    result.artifact = asNonEmptyString(value.artifact, `results.${gateId}.artifact`);
  }
  if (value.revision !== undefined) {
    result.revision = normalizeRevision(
      asNonEmptyString(value.revision, `results.${gateId}.revision`),
    );
  }
  if (value.command !== undefined) {
    result.command = asNonEmptyString(value.command, `results.${gateId}.command`);
  }
  return result;
}

export function isReleaseEvidenceManifest(raw: unknown): boolean {
  return isPlainObject(raw) && raw.kind === RELEASE_EVIDENCE_MANIFEST_KIND;
}

export function parseReleaseEvidenceManifest(raw: unknown): ReleaseEvidenceManifest {
  if (!isPlainObject(raw)) {
    throw new Error("release evidence manifest must be a JSON object");
  }
  if (raw.kind !== RELEASE_EVIDENCE_MANIFEST_KIND) {
    throw new Error(`kind must be "${RELEASE_EVIDENCE_MANIFEST_KIND}"`);
  }
  if (raw.schemaVersion !== RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion must be ${RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  const revision = normalizeRevision(
    asNonEmptyString(raw.revision, "revision"),
  );
  const schemaIdentity = parseSchemaIdentity(raw.schemaIdentity);
  const commands = parseCommandMap(raw.commands ?? raw.checks, "commands");
  const artifacts = parseArtifactMap(raw.artifacts, "artifacts");
  if (!isPlainObject(raw.results)) {
    throw new Error("results must be an object keyed by gate id");
  }
  const results: Record<string, ReleaseEvidenceManifestResult> = {};
  for (const [gateId, entry] of Object.entries(raw.results)) {
    if (!isReleaseGateId(gateId)) {
      throw new Error(`unknown release gate "${gateId}"`);
    }
    const result = parseManifestResult(entry, gateId);
    const declared = artifacts[gateId] ?? [];
    const seen = new Set<string>();
    result.artifacts = [...declared, ...result.artifacts].filter((artifact) => {
      const key = `${artifact.path}::${artifact.sha256}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    results[gateId] = result;
  }
  return {
    schemaVersion: RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_EVIDENCE_MANIFEST_KIND,
    revision,
    schemaIdentity,
    commands,
    artifacts,
    results,
  };
}

export function schemaIdentityDigest(
  identity: Omit<ReleaseEvidenceSchemaIdentity, "digest">,
): string {
  return sha256Hex(canonicalJson(identity));
}

export function buildReleaseEvidenceSchemaIdentity(options: {
  repoRoot: string;
  snapshotPath?: string;
}): ReleaseEvidenceSchemaIdentity {
  const snapshotPath =
    options.snapshotPath ??
    path.join(options.repoRoot, DEFAULT_SCHEMA_SNAPSHOT_RELATIVE);
  const snapshot = loadSchemaSnapshot(snapshotPath);
  return releaseEvidenceSchemaIdentityFromSnapshot(snapshot);
}

export function releaseEvidenceSchemaIdentityFromSnapshot(
  snapshot: SchemaSnapshot,
): ReleaseEvidenceSchemaIdentity {
  const identity: Omit<ReleaseEvidenceSchemaIdentity, "digest"> = {
    readinessFingerprint: releaseReadinessFingerprint(),
    schemaSnapshot: {
      schemaVersion: snapshot.schemaVersion,
      hashAlgorithm: snapshot.hashAlgorithm,
      source: snapshot.source,
      fingerprint: snapshot.fingerprint,
    },
  };
  return { ...identity, digest: schemaIdentityDigest(identity) };
}

export function resolveEvidenceArtifactPath(
  root: string,
  relative: string,
): string {
  const rootAbsolute = path.resolve(root);
  if (typeof relative !== "string" || relative.trim() === "") {
    throw new ReleaseEvidenceArtifactPathError(
      "empty",
      relative,
      "artifact path must be a non-empty repo-relative path",
    );
  }
  if (
    relative.includes("\0") ||
    relative !== relative.trim() ||
    relative.includes("\\")
  ) {
    throw new ReleaseEvidenceArtifactPathError(
      "invalid",
      relative,
      `artifact path "${relative}" contains unsupported characters`,
    );
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new ReleaseEvidenceArtifactPathError(
      "absolute",
      relative,
      `artifact path "${relative}" must be relative to the explicit evidence root`,
    );
  }
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === ".")) {
    throw new ReleaseEvidenceArtifactPathError(
      "invalid",
      relative,
      `artifact path "${relative}" must use normalized repo-relative segments`,
    );
  }
  if (segments.includes("..")) {
    throw new ReleaseEvidenceArtifactPathError(
      "parent-segment",
      relative,
      `artifact path "${relative}" escapes the explicit evidence root`,
    );
  }
  const resolved = path.resolve(rootAbsolute, ...segments);
  const contained = path.relative(rootAbsolute, resolved);
  if (
    contained === "" ||
    contained === ".." ||
    contained.startsWith(`..${path.sep}`) ||
    path.isAbsolute(contained)
  ) {
    throw new ReleaseEvidenceArtifactPathError(
      "outside-root",
      relative,
      `artifact path "${relative}" resolves outside the explicit evidence root`,
    );
  }

  let current = rootAbsolute;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new ReleaseEvidenceArtifactPathError(
        "invalid",
        relative,
        `artifact path "${relative}" cannot be inspected: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new ReleaseEvidenceArtifactPathError(
        "symlink",
        relative,
        `artifact path "${relative}" is a symlink and is refused before reading`,
      );
    }
  }
  return resolved;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function invalidReport(
  raw: unknown,
  options: EvaluateReleaseEvidenceManifestOptions,
  error: unknown,
): ReleaseEvidenceManifestReport {
  const base = evaluateReleaseReadiness(null, { mode: options.mode });
  return {
    ...base,
    findings: [
      {
        code: "EVIDENCE_INVALID",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      },
      ...base.findings,
    ],
    revision: isPlainObject(raw) && typeof raw.revision === "string" ? raw.revision : null,
    artifactCount: 0,
    schemaIdentityDigest: null,
  };
}

export function evaluateReleaseEvidenceManifest(
  raw: unknown,
  options: EvaluateReleaseEvidenceManifestOptions,
): ReleaseEvidenceManifestReport {
  let manifest: ReleaseEvidenceManifest;
  try {
    manifest = parseReleaseEvidenceManifest(raw);
  } catch (error) {
    return invalidReport(raw, options, error);
  }

  const findings: ReleaseFinding[] = [];
  const artifactRoot = options.artifactRoot ?? options.repoRoot;
  const revision = normalizeRevision(manifest.revision);
  if (!REVISION.test(revision)) {
    findings.push({
      code: "EVIDENCE_INVALID_REVISION",
      severity: "error",
      message: `manifest revision "${revision}" must be a 7-64 character hex git revision`,
    });
  }
  if (options.expectedRevision) {
    const expected = normalizeRevision(options.expectedRevision);
    if (revision !== expected) {
      findings.push({
        code: "EVIDENCE_REVISION_MISMATCH",
        severity: "error",
        message: `manifest revision ${revision.slice(0, 12)} does not match expected revision ${expected.slice(0, 12)} — collect evidence for the revision being released`,
      });
    }
  }

  let expectedIdentity: ReleaseEvidenceSchemaIdentity | null = null;
  try {
    expectedIdentity =
      options.schemaIdentity ??
      buildReleaseEvidenceSchemaIdentity({
        repoRoot: options.repoRoot,
        snapshotPath: options.snapshotPath,
      });
  } catch (error) {
    findings.push({
      code: "EVIDENCE_SCHEMA_IDENTITY_MISMATCH",
      severity: "error",
      message: `cannot verify the checked-out schema identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  for (const gateId of Object.keys(manifest.results)) {
    if (!isReleaseGateId(gateId)) continue;
    const result = manifest.results[gateId]!;
    if (!result.revision) {
      findings.push({
        code: "EVIDENCE_MISSING_REVISION",
        severity: "error",
        gateId,
        message: `result for "${gateId}" has no revision, so it cannot be bound to the manifest revision`,
      });
    } else if (!REVISION.test(result.revision)) {
      findings.push({
        code: "EVIDENCE_INVALID_REVISION",
        severity: "error",
        gateId,
        message: `result for "${gateId}" has an invalid revision "${result.revision}"`,
      });
    } else if (result.revision !== revision) {
      findings.push({
        code: "EVIDENCE_MIXED_REVISION",
        severity: "error",
        gateId,
        message: `result for "${gateId}" was recorded at ${result.revision.slice(0, 12)} but the manifest is bound to ${revision.slice(0, 12)} — mixed-revision evidence is refused`,
      });
    }
  }

  const legacyResults: Record<string, ReleaseGateEvidence> = {};
  for (const gateId of Object.keys(manifest.results)) {
    const result = manifest.results[gateId]!;
    const legacy: ReleaseGateEvidence = { status: result.status };
    if (result.detail !== undefined) legacy.detail = result.detail;
    if (result.artifact !== undefined) legacy.artifact = result.artifact;
    legacyResults[gateId] = legacy;
  }

  const expectedCommands = new Map(
    Object.keys(manifest.results)
      .filter(isReleaseGateId)
      .map((gateId) => [gateId, getReleaseGate(gateId).command] as const),
  );

  for (const [gateId, command] of expectedCommands) {
    const result = manifest.results[gateId]!;
    const declaredCommand = manifest.commands[gateId];
    if (!result.command && !declaredCommand) {
      findings.push({
        code: "EVIDENCE_COMMAND_MISSING",
        severity: "error",
        gateId,
        message: `result for "${gateId}" does not record the exact check command`,
      });
      continue;
    }
    if (result.command && declaredCommand && result.command !== declaredCommand) {
      findings.push({
        code: "EVIDENCE_COMMAND_MISMATCH",
        severity: "error",
        gateId,
        message: `result and manifest commands disagree for "${gateId}"`,
      });
    }
    const recordedCommands = [result.command, declaredCommand].filter(
      (value): value is string => typeof value === "string",
    );
    for (const recorded of recordedCommands) {
      if (recorded !== command) {
        findings.push({
          code: "EVIDENCE_COMMAND_MISMATCH",
          severity: "error",
          gateId,
          message: `recorded command "${recorded}" does not match the reviewed command "${command}" for "${gateId}"`,
        });
      }
    }
  }

  for (const gateId of Object.keys(manifest.commands)) {
    if (!manifest.results[gateId]) {
      findings.push({
        code: "EVIDENCE_MISSING_RESULT",
        severity: "error",
        gateId,
        message: `manifest declares a command for "${gateId}" but has no required result for it`,
      });
    }
  }

  for (const gateId of Object.keys(manifest.artifacts)) {
    if (!manifest.results[gateId]) {
      findings.push({
        code: "EVIDENCE_MISSING_RESULT",
        severity: "error",
        gateId,
        message: `manifest declares artifacts for "${gateId}" but has no required result for it`,
      });
    }
  }

  for (const gateId of RELEASE_GATE_IDS) {
    if (!manifest.results[gateId]) {
      findings.push({
        code: "EVIDENCE_MISSING_RESULT",
        severity: "error",
        gateId,
        message: `manifest is missing the required result for "${gateId}" — every release gate must be bound to the same revision`,
      });
    }
  }

  const identityDigest = manifest.schemaIdentity.digest;
  const expectedDigest = expectedIdentity?.digest ?? null;
  if (
    expectedIdentity &&
    (identityDigest !== expectedDigest ||
      manifest.schemaIdentity.readinessFingerprint !==
        expectedIdentity.readinessFingerprint ||
      manifest.schemaIdentity.schemaSnapshot.schemaVersion !==
        expectedIdentity.schemaSnapshot.schemaVersion ||
      manifest.schemaIdentity.schemaSnapshot.hashAlgorithm !==
        expectedIdentity.schemaSnapshot.hashAlgorithm ||
      manifest.schemaIdentity.schemaSnapshot.source !==
        expectedIdentity.schemaSnapshot.source ||
      manifest.schemaIdentity.schemaSnapshot.fingerprint !==
        expectedIdentity.schemaSnapshot.fingerprint)
  ) {
    findings.push({
      code: "EVIDENCE_SCHEMA_IDENTITY_MISMATCH",
      severity: "error",
      message:
        `manifest schema identity ${identityDigest.slice(0, 12)} does not match ` +
        `the checked-out identity ${expectedIdentity.digest.slice(0, 12)} — regenerate the manifest on the released revision`,
    });
  }

  let artifactCount = 0;
  for (const gateId of RELEASE_GATE_IDS) {
    const artifacts = manifest.results[gateId]?.artifacts ?? [];
    for (const artifact of artifacts) {
      artifactCount += 1;
      if (!HEX64.test(artifact.sha256)) {
        findings.push({
          code: "EVIDENCE_ARTIFACT_DIGEST_INVALID",
          severity: "error",
          gateId,
          message: `artifact "${artifact.path}" for "${gateId}" must declare a sha256 hex digest`,
        });
        continue;
      }
      let resolved: string;
      try {
        resolved = resolveEvidenceArtifactPath(artifactRoot, artifact.path);
      } catch (error) {
        const pathError =
          error instanceof ReleaseEvidenceArtifactPathError
            ? error
            : undefined;
        findings.push({
          code: RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID,
          severity: "error",
          gateId,
          message: pathError?.message ?? `invalid artifact path "${artifact.path}"`,
        });
        continue;
      }
      let stat;
      try {
        stat = lstatSync(resolved);
      } catch {
        findings.push({
          code: "EVIDENCE_ARTIFACT_MISSING",
          severity: "error",
          gateId,
          message: `artifact "${artifact.path}" for "${gateId}" is missing under the explicit evidence root`,
        });
        continue;
      }
      if (!stat.isFile()) {
        findings.push({
          code: RELEASE_EVIDENCE_ARTIFACT_PATH_INVALID,
          severity: "error",
          gateId,
          message: `artifact "${artifact.path}" for "${gateId}" is not a regular file`,
        });
        continue;
      }
      const actual = sha256File(resolved);
      if (actual !== artifact.sha256) {
        findings.push({
          code: "EVIDENCE_ARTIFACT_DIGEST_MISMATCH",
          severity: "error",
          gateId,
          message:
            `artifact "${artifact.path}" for "${gateId}" digest ${actual.slice(0, 12)} ` +
            `does not match recorded ${artifact.sha256.slice(0, 12)}`,
        });
      }
    }
  }

  if (artifactCount === 0) {
    findings.push({
      code: "EVIDENCE_ARTIFACT_DIGEST_MISSING",
      severity: "error",
      message:
        "manifest contains no artifact digests — bind at least one retained artifact to the release revision",
    });
  }

  const evidence: ReleaseEvidence = {
    schemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    kind: RELEASE_READINESS_KIND,
    results: legacyResults,
  };
  const base = evaluateReleaseReadiness(evidence, { mode: options.mode });
  const semanticOk = findings.every((finding) => finding.severity !== "error");

  return {
    ...base,
    ok: base.ok && semanticOk,
    releaseReady: base.releaseReady && semanticOk,
    findings: [...findings, ...base.findings],
    revision,
    artifactCount,
    schemaIdentityDigest: expectedDigest,
  };
}

export function buildReleaseEvidenceManifest(options: {
  repoRoot: string;
  artifactRoot?: string;
  revision: string;
  results: Record<string, ReleaseGateEvidence>;
  artifactPaths?: Record<string, readonly string[]>;
  snapshotPath?: string;
}): ReleaseEvidenceManifest {
  const revision = normalizeRevision(asNonEmptyString(options.revision, "revision"));
  const identity = buildReleaseEvidenceSchemaIdentity({
    repoRoot: options.repoRoot,
    snapshotPath: options.snapshotPath,
  });
  const commands: Record<string, string> = {};
  const artifacts: Record<string, ReleaseEvidenceArtifact[]> = {};
  const results: Record<string, ReleaseEvidenceManifestResult> = {};
  const artifactRoot = options.artifactRoot ?? options.repoRoot;

  for (const [gateId, evidence] of Object.entries(options.results)) {
    if (!isReleaseGateId(gateId)) {
      throw new Error(`unknown release gate "${gateId}"`);
    }
    commands[gateId] = getReleaseGate(gateId).command;
    artifacts[gateId] = (options.artifactPaths?.[gateId] ?? []).map((relative) => {
      const resolved = resolveEvidenceArtifactPath(artifactRoot, relative);
      return { path: relative, sha256: sha256File(resolved) };
    });
    results[gateId] = {
      ...evidence,
      revision,
      command: commands[gateId]!,
      artifacts: artifacts[gateId]!,
    };
  }

  return {
    schemaVersion: RELEASE_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_EVIDENCE_MANIFEST_KIND,
    revision,
    schemaIdentity: identity,
    commands,
    artifacts,
    results,
  };
}
