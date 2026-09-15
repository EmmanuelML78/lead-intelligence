/**
 * Demo tenant context — not production IAM.
 *
 * The assessment demo uses a controlled company cookie so a commercial
 * manager can operate inside one company. Every tenant-facing query still
 * requires companyId in the server/data-access layer; the cookie is only
 * how the UI remembers the selected company.
 */

export const DEMO_COMPANY_COOKIE = "demo_company_id";

export class MissingCompanyIdError extends Error {
  constructor() {
    super("companyId is required for tenant-scoped dashboard queries");
    this.name = "MissingCompanyIdError";
  }
}

export function requireCompanyId(companyId: string | null | undefined): string {
  const value = companyId?.trim();
  if (!value) throw new MissingCompanyIdError();
  return value;
}

export type DemoCompany = {
  id: string;
  name: string | null;
};

export function displayCompanyName(company: DemoCompany): string {
  return company.name?.trim() || company.id;
}
