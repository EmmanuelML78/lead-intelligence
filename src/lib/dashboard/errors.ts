export const DASHBOARD_UNAVAILABLE_MESSAGE =
  "The dashboard could not load this view. Try again in a moment.";

/**
 * User-visible dashboard errors must never include Prisma messages,
 * connection strings, stack traces, or environment values.
 */
export function publicDashboardError(_error: unknown): string {
  return DASHBOARD_UNAVAILABLE_MESSAGE;
}
