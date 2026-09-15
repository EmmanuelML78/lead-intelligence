import { cookies } from "next/headers";
import { prisma } from "../db/client";
import { listDemoCompanies, resolveDemoCompany } from "./queries";
import { DEMO_COMPANY_COOKIE, type DemoCompany } from "./tenant";

export async function readDemoCompanyId(): Promise<string | null> {
  const store = await cookies();
  return store.get(DEMO_COMPANY_COOKIE)?.value ?? null;
}

export type DashboardTenant = {
  companies: DemoCompany[];
  selected: DemoCompany | null;
};

export async function loadDashboardTenant(): Promise<DashboardTenant> {
  const companies = await listDemoCompanies(prisma);
  const selected = await resolveDemoCompany(prisma, await readDemoCompanyId());
  return { companies, selected };
}
