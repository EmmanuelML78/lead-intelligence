import assert from "node:assert/strict";
import test from "node:test";
import { assertTarget, describeTarget, formatTarget, hostMatches, parseArgs, TargetError } from "../scripts/ops/target";

const DIRECT = "postgresql://app_user:s3cret-value@ep-cool-rain-123456.us-east-2.aws.neon.tech/leads?sslmode=require";
const POOLED = "postgresql://app_user:s3cret-value@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/leads?sslmode=require";

test("describeTarget exposes host, database and connection type, never credentials", () => {
  const target = describeTarget(DIRECT);
  assert.equal(target.host, "ep-cool-rain-123456.us-east-2.aws.neon.tech");
  assert.equal(target.database, "leads");
  assert.equal(target.pooled, false);
  assert.match(target.fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(describeTarget(POOLED).pooled, true);

  const printed = `${formatTarget(target)} ${JSON.stringify(target)}`;
  assert.ok(!printed.includes("s3cret-value"), "the password must never be printed");
  assert.ok(!printed.includes("app_user"), "the user name must never be printed");
  assert.ok(!printed.includes("sslmode"), "the query string must never be printed");
});

test("different URLs produce different fingerprints and the same URL a stable one", () => {
  assert.equal(describeTarget(DIRECT).fingerprint, describeTarget(` ${DIRECT} `).fingerprint);
  assert.notEqual(describeTarget(DIRECT).fingerprint, describeTarget(POOLED).fingerprint);
});

test("describeTarget rejects a missing, malformed or non-PostgreSQL URL without echoing it", () => {
  for (const value of [undefined, "", "   ", "not a url", "mysql://user:s3cret-value@host/db", "postgresql://user:s3cret-value@host/"]) {
    assert.throws(
      () => describeTarget(value),
      (error: unknown) => error instanceof TargetError && !error.message.includes("s3cret-value")
    );
  }
});

test("hostMatches accepts the full host or whole leading labels only", () => {
  const host = "ep-cool-rain-123456.us-east-2.aws.neon.tech";
  assert.equal(hostMatches(host, host), true);
  assert.equal(hostMatches(host, "EP-COOL-RAIN-123456"), true);
  assert.equal(hostMatches(host, "ep-cool-rain-123456.us-east-2"), true);
  assert.equal(hostMatches(host, "ep-cool-rain-1234"), false, "a partial label must not match");
  assert.equal(hostMatches("ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech", "ep-cool-rain-123456"), false);
  assert.equal(hostMatches(host, "neon.tech"), false);
  assert.equal(hostMatches(host, ""), false);
});

test("assertTarget refuses to run without an expected host or against another database", () => {
  assert.throws(() => assertTarget(DIRECT, undefined), /--expect-host is required/);
  assert.throws(() => assertTarget(DIRECT, "  "), /--expect-host is required/);
  assert.throws(
    () => assertTarget(DIRECT, "ep-other-branch-999999"),
    (error: unknown) =>
      error instanceof TargetError && /Refusing to run/.test(error.message) && !error.message.includes("s3cret-value")
  );
  assert.equal(assertTarget(DIRECT, "ep-cool-rain-123456").database, "leads");
});

test("parseArgs separates flags, flag values and positional arguments", () => {
  const { flags, positional } = parseArgs(["compare", "before.json", "--expect-host", "ep-x", "--apply", "--must-match", "all"]);
  assert.deepEqual(positional, ["compare", "before.json"]);
  assert.equal(flags.get("expect-host"), "ep-x");
  assert.equal(flags.get("apply"), true);
  assert.equal(flags.get("must-match"), "all");
});
