/**
 * End-to-end dashboard smoke check against a running server and a populated
 * database. Covers the health endpoint, pages rendering persisted data, the
 * company switch server action, and per-company query isolation.
 * Prints only ids and status codes.
 *
 * Usage: SMOKE_BASE_URL=http://127.0.0.1:3000 bun run scripts/ci-dashboard-smoke.ts
 */
import assert from "node:assert/strict";
import { prisma } from "../src/lib/db/client";
import { getLeadDetail } from "../src/lib/dashboard/queries";
import { DEMO_COMPANY_COOKIE } from "../src/lib/dashboard/tenant";

const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const ERROR_STATE_MARKER = "Panel no disponible";
const NOT_FOUND_MARKER = '<meta name="robots" content="noindex"';
const DASHBOARD_PAGES = ["/", "/leads", "/capacity", "/data-quality"];

const results: Array<{ check: string; outcome: string }> = [];

async function check(name: string, run: () => Promise<string | void>) {
  try {
    const detail = await run();
    results.push({ check: name, outcome: detail ? `ok (${detail})` : "ok" });
  } catch (error) {
    results.push({ check: name, outcome: `FAILED: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function get(path: string, companyId?: string) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    headers: companyId ? { cookie: `${DEMO_COMPANY_COOKIE}=${companyId}` } : {}
  });
}

function leadIdsIn(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(/href="\/leads\/([^"?#/]+)"/g)) ids.add(decodeURIComponent(match[1]!));
  return [...ids];
}

function selectedCompanyIn(html: string): string | null {
  const select = html.match(/<select[^>]*name="companyId"[^>]*>[\s\S]*?<\/select>/)?.[0];
  return select?.match(/<option[^>]*value="([^"]+)"[^>]*\sselected(?:=""|\s|>)/)?.[1] ?? null;
}

/** Submits the company selector form the way a browser without JavaScript would. */
async function submitCompanyForm(companyId: string): Promise<Response> {
  const html = await (await get("/")).text();
  const form = html.match(/<form[^>]*class="company-selector"[\s\S]*?<\/form>/)?.[0];
  assert.ok(form, "company selector form not found in the rendered page");
  const body = new FormData();
  for (const input of form.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = input[0].match(/name="([^"]*)"/)?.[1];
    if (name) body.append(name, input[0].match(/value="([^"]*)"/)?.[1] ?? "");
  }
  assert.ok([...body.keys()].some((key) => key.startsWith("$ACTION")), "server action reference not found in the form");
  body.append("companyId", companyId);
  return fetch(`${baseUrl}/`, { method: "POST", body, redirect: "manual" });
}

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  assert.ok(companies.length >= 2, "need at least two companies in the database");
  const [first, second] = [companies[0]!.id, companies[1]!.id];

  await check("health endpoint reports a reachable database", async () => {
    const response = await get("/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", database: "reachable" });
  });

  for (const page of DASHBOARD_PAGES) {
    await check(`GET ${page} renders without the error state`, async () => {
      const response = await get(page, first);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.ok(!html.includes(ERROR_STATE_MARKER), "page rendered the dashboard error state");
    });
  }

  for (const companyId of [first, second]) {
    await check(`lead queue for ${companyId} lists only that company's persisted leads`, async () => {
      const html = await (await get("/leads", companyId)).text();
      assert.equal(selectedCompanyIn(html), companyId, "company selector does not reflect the cookie");
      const ids = leadIdsIn(html);
      assert.ok(ids.length > 0, "no lead links rendered");
      const owners = await prisma.lead.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true } });
      assert.equal(owners.length, ids.length, "rendered lead ids that do not exist in the database");
      const foreign = owners.filter((lead) => lead.companyId !== companyId).map((lead) => lead.id);
      assert.deepEqual(foreign, [], "rendered leads owned by another company");
      return `${ids.length} leads`;
    });
  }

  // The route streams behind loading.tsx, so notFound() cannot change the
  // already-sent 200 status. Isolation is asserted on the rendered content:
  // Next.js marks not-found responses with a robots noindex meta tag.
  await check("lead detail is visible to its owner and not found for another company", async () => {
    const lead = await prisma.lead.findFirst({ where: { companyId: second }, select: { id: true }, orderBy: { id: "asc" } });
    assert.ok(lead, `no lead found for ${second}`);
    const detail = await getLeadDetail(prisma, second, lead.id);
    assert.ok(detail?.customerName, "sample lead has no customer name to look for");
    const path = `/leads/${encodeURIComponent(lead.id)}`;

    const own = await get(path, second);
    const ownHtml = await own.text();
    assert.equal(own.status, 200, "owner could not open its own lead");
    assert.ok(ownHtml.includes(detail.customerName), "owner page does not show the persisted lead");
    assert.ok(!ownHtml.includes(NOT_FOUND_MARKER), "owner page was rendered as not found");

    const foreign = await get(path, first);
    const foreignHtml = await foreign.text();
    assert.ok(!foreignHtml.includes(detail.customerName), "another company received the lead's data");
    assert.ok(foreignHtml.includes(NOT_FOUND_MARKER), "another company did not get the not-found response");
    return `${lead.id}, cross-company HTTP ${foreign.status}`;
  });

  await check("company switch action sets the tenant cookie and changes the rendered company", async () => {
    const response = await submitCompanyForm(second);
    assert.ok(response.status < 400, `unexpected status ${response.status}`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${DEMO_COMPANY_COOKIE}=`));
    assert.ok(cookie, "response did not set the tenant cookie");
    assert.equal(decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!), second);
    assert.match(cookie, /HttpOnly/i);
    const html = await (await get("/leads", second)).text();
    assert.equal(selectedCompanyIn(html), second);
    return `HTTP ${response.status}`;
  });

  await check("company switch action rejects an unknown company", async () => {
    const response = await submitCompanyForm("EMP-DOES-NOT-EXIST");
    assert.ok(response.status >= 400, `expected an error status, got ${response.status}`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${DEMO_COMPANY_COOKIE}=`));
    assert.equal(cookie, undefined, "tenant cookie was set for an unknown company");
    return `HTTP ${response.status}`;
  });

  console.table(results);
  if (results.some((row) => row.outcome.startsWith("FAILED"))) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
