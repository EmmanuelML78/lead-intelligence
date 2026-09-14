export type HybridScoreInput = {
  propensity: number; // 0..1 calibrated historical probability signal
  intent: number; // 0..1 structured conversation signal
  ageMinutes: number;
  inventoryAvailable: boolean | null;
};

export type HybridScore = {
  total: number;
  propensityPoints: number;
  intentPoints: number;
  urgencyPoints: number;
  inventoryBonus: number;
  temperature: "VERY_HOT" | "HOT" | "WARM" | "LOW";
};

export function urgencyFromAge(ageMinutes: number): number {
  if (ageMinutes >= 24 * 60) return 25;
  if (ageMinutes >= 8 * 60) return 20;
  if (ageMinutes >= 4 * 60) return 15;
  if (ageMinutes >= 60) return 10;
  if (ageMinutes >= 30) return 5;
  return 0;
}

export function calculateHybridScore(input: HybridScoreInput): HybridScore {
  const propensityPoints = Math.max(0, Math.min(40, input.propensity * 40));
  const intentPoints = Math.max(0, Math.min(30, input.intent * 30));
  const urgencyPoints = urgencyFromAge(input.ageMinutes);
  const inventoryBonus = input.inventoryAvailable === true ? 5 : 0;
  const total = Math.round(Math.min(100, propensityPoints + intentPoints + urgencyPoints + inventoryBonus));

  const temperature = total >= 85 ? "VERY_HOT" : total >= 70 ? "HOT" : total >= 50 ? "WARM" : "LOW";
  return { total, propensityPoints, intentPoints, urgencyPoints, inventoryBonus, temperature };
}
