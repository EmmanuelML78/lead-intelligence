export const DASHBOARD_UNAVAILABLE_MESSAGE =
  "No se pudo cargar esta vista. Inténtalo de nuevo en un momento.";

/**
 * User-visible dashboard errors must never include Prisma messages,
 * connection strings, stack traces, or environment values.
 */
export function publicDashboardError(_error: unknown): string {
  return DASHBOARD_UNAVAILABLE_MESSAGE;
}
