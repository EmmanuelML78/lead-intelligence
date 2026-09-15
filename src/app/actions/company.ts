"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/db/client";
import { listDemoCompanies } from "../../lib/dashboard/queries";
import { DEMO_COMPANY_COOKIE, requireCompanyId } from "../../lib/dashboard/tenant";

export async function setDemoCompany(formData: FormData): Promise<void> {
  const companyId = requireCompanyId(String(formData.get("companyId") ?? ""));
  const companies = await listDemoCompanies(prisma);
  if (!companies.some((company) => company.id === companyId)) {
    throw new Error("Unknown company for demo tenant context");
  }
  const store = await cookies();
  store.set(DEMO_COMPANY_COOKIE, companyId, {
    path: "/",
    sameSite: "lax",
    httpOnly: true
  });
  revalidatePath("/", "layout");
}
