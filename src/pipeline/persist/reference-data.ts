import type { PrismaClient } from "@prisma/client";
import type { RawAdvisor, RawMotorcycle } from "../types";

export type ReferenceDataInput = {
  companyIds: Set<string>;
  salesPoints: Map<string, string>; // salesPointId -> companyId
  advisors: RawAdvisor[];
  motorcycles: RawMotorcycle[];
};

// Reference data (Company / SalesPoint / Advisor / Motorcycle /
// MotorcycleInventory) is small and interdependent (SalesPoint needs its
// Company row, Advisor needs both, MotorcycleInventory needs Motorcycle +
// SalesPoint), so it is persisted as one logical transaction: either the
// whole reference snapshot lands, or none of it does, leaving Lead/
// Conversation persistence (which run afterwards) to fail fast on missing
// foreign keys rather than half-apply.
export async function persistReferenceData(db: PrismaClient, input: ReferenceDataInput): Promise<void> {
  await db.$transaction(
    async (tx) => {
      for (const companyId of input.companyIds) {
        await tx.company.upsert({
          where: { id: companyId },
          update: {},
          create: { id: companyId }
        });
      }

      for (const [salesPointId, companyId] of input.salesPoints) {
        await tx.salesPoint.upsert({
          where: { id: salesPointId },
          update: { companyId },
          create: { id: salesPointId, companyId }
        });
      }

      for (const advisor of input.advisors) {
        const id = advisor.asesor_id.trim();
        if (!id) continue;
        const data = {
          name: advisor.nombre.trim(),
          companyId: advisor.empresa_id.trim(),
          salesPointId: advisor.punto_venta_id.trim(),
          dailyCapacity: Number.parseInt(advisor.capacidad_diaria_leads, 10) || 0,
          active: advisor.activo.trim().toUpperCase() === "SI",
          joinedAt: advisor.fecha_ingreso.trim() ? new Date(advisor.fecha_ingreso.trim()) : null
        };
        await tx.advisor.upsert({ where: { id }, update: data, create: { id, ...data } });
      }

      for (const moto of input.motorcycles) {
        const sku = moto.sku.trim();
        if (!sku) continue;
        const motoData = {
          brand: moto.marca.trim(),
          line: moto.linea.trim(),
          displacement: Number.parseInt(moto.cilindraje, 10) || 0,
          segment: moto.segmento.trim(),
          listPrice: Number.parseInt(moto.precio_lista, 10) || 0
        };
        await tx.motorcycle.upsert({ where: { sku }, update: motoData, create: { sku, ...motoData } });

        // Catalog listing only: one row per puntos_venta_disponibles entry,
        // all sharing the same global unidades_disponibles. This is not
        // store stock and not company inventory. Scoring reads units by SKU.
        const unitsGlobal = Number.parseInt(moto.unidades_disponibles, 10) || 0;
        const salesPointIds = moto.puntos_venta_disponibles
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);

        for (const salesPointId of salesPointIds) {
          await tx.motorcycleInventory.upsert({
            where: { motorcycleSku_salesPointId: { motorcycleSku: sku, salesPointId } },
            update: { available: true, unitsGlobal },
            create: { motorcycleSku: sku, salesPointId, available: true, unitsGlobal }
          });
        }
      }
    },
    { timeout: 30_000, maxWait: 15_000 }
  );
}
