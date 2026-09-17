import { DataQualityPanel } from "../../components/dashboard/data-quality-panel";
import { ErrorState } from "../../components/dashboard/states";
import { publicDashboardError } from "../../lib/dashboard/errors";
import { prisma } from "../../lib/db/client";
import { getDataQuality } from "../../lib/dashboard/queries";

export const dynamic = "force-dynamic";

export default async function DataQualityPage() {
  try {
    const data = await getDataQuality(prisma);
    return (
      <>
        <header className="page-header">
          <h1>Observabilidad del pipeline</h1>
          <p>
            Estado de la última corrida y huellas únicas de calidad de datos. Esta pantalla es
            operativa, no una cola comercial por empresa; los hallazgos se cuentan por tipo, nunca
            por reobservaciones del pipeline.
          </p>
        </header>
        <DataQualityPanel data={data} />
      </>
    );
  } catch (error) {
    return <ErrorState message={publicDashboardError(error)} />;
  }
}
