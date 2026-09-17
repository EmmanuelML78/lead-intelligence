"use client";

import { setDemoCompany } from "../../app/actions/company";
import { displayCompanyName, type DemoCompany } from "../../lib/dashboard/tenant";

export function CompanySelector({
  companies,
  selectedId
}: {
  companies: DemoCompany[];
  selectedId: string;
}) {
  return (
    <form action={setDemoCompany} className="company-selector">
      <label className="field">
        Empresa (demo)
        <select
          key={selectedId}
          name="companyId"
          defaultValue={selectedId}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {displayCompanyName(company)}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit">Cambiar</button>
      </noscript>
    </form>
  );
}
