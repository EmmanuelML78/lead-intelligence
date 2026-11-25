import { assertTarget, hostMatches, TargetError } from "./target";

/** The production endpoint is a deny-list, never a connection to production. */
export function rehearsalEnvironment(url: string | undefined, expectedHost: string | undefined, productionHost: string | undefined) {
  const target = assertTarget(url, expectedHost);
  if (!productionHost?.trim()) throw new TargetError("--production-host is required to exclude production.");
  if (target.pooled) throw new TargetError("Rehearsal requires a direct connection.");
  if (hostMatches(target.host, productionHost) || hostMatches(productionHost, target.host)) {
    throw new TargetError("Refusing to rehearse against the production endpoint.");
  }
  return { AI_API_KEY: "", AI_MAX_CONVERSATIONS: "0", PIPELINE_SKIP_ASSIGNMENT: "1", PIPELINE_SKIP_SCORING: "1" };
}
