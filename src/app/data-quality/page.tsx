import { DataQualityPanel } from "../../components/dashboard/data-quality-panel";
import { ErrorState } from "../../components/dashboard/states";
import { prisma } from "../../lib/db/client";
import { getDataQuality } from "../../lib/dashboard/queries";

export const dynamic = "force-dynamic";

export default async function DataQualityPage() {
  try {
    const data = await getDataQuality(prisma);
    return (
      <>
        <header className="page-header">
          <h1>Pipeline observability</h1>
          <p>
            Latest run status and unique data-quality fingerprints. This screen is operational, not
            a tenant commercial queue; issue rows are counted by type, never by reobservedRunCount.
          </p>
        </header>
        <DataQualityPanel data={data} />
      </>
    );
  } catch (error) {
    return <ErrorState message={error instanceof Error ? error.message : "Database unavailable."} />;
  }
}
