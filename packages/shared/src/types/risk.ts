import { z } from 'zod';

/**
 * Section 5.2 (Fast-Follow) / Section 12.4/12.9 - Risk-Grading Engine.
 * Auto-classify transactions by risk tier and track a rolling trust score per
 * agent sub-wallet, similar to OKX's risk-grading model.
 */

export const RiskTierSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskTier = z.infer<typeof RiskTierSchema>;

/** Named factor contributing to the overall risk score. Each has a weight and
 * a human-readable explanation so compliance can audit why a tier was assigned. */
export const RiskFactorSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  description: z.string(),
});
export type RiskFactor = z.infer<typeof RiskFactorSchema>;

/** Full risk assessment produced for every transaction. Embedded in
 * TransactionRecord so it's audit-logged and queryable. */
export const RiskAssessmentSchema = z.object({
  overallScore: z.number().min(0).max(100),
  tier: RiskTierSchema,
  factors: z.array(RiskFactorSchema),
  assessedAt: z.string(),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

/** Rolling trust score per agent sub-wallet (Section 12.4). Simple integer
 * 0-100 that reflects the sub-wallet's historical compliance behaviour.
 * Updated after every transaction attempt. */
export const TrustScoreSchema = z.object({
  score: z.number().int().min(0).max(100).default(100),
  lastUpdated: z.string(),
  /** Running count of events that shaped this score, for transparency. */
  totalTransactions: z.number().int().nonnegative().default(0),
  cleanAutoExecutes: z.number().int().nonnegative().default(0),
  policyViolations: z.number().int().nonnegative().default(0),
  screeningFlags: z.number().int().nonnegative().default(0),
  quarantineEvents: z.number().int().nonnegative().default(0),
  /** Pre-execution simulation failures (Section 6.3). Tracked separately from
   * policy violations: a reverted simulation is a technical failure (bad
   * calldata/destination), not a policy breach - conflating the two polluted
   * the compliance counters the risk engine reads. */
  simulationFailures: z.number().int().nonnegative().default(0),
});
export type TrustScore = z.infer<typeof TrustScoreSchema>;


/** Summary response for the risk dashboard endpoint. */
export const SubWalletRiskSummarySchema = z.object({
  subWalletId: z.string(),
  trustScore: TrustScoreSchema,
  recentAssessments: z.array(RiskAssessmentSchema).max(20).default([]),
});
export type SubWalletRiskSummary = z.infer<typeof SubWalletRiskSummarySchema>;

/** Section 12.4 - Adaptive Autonomy (graduation consumer).
 * A Strict-Mode agent with a sustained clean record becomes *eligible* for
 * graduation to Bounded Auto. Eligibility is a deterministic, auditable
 * checklist computed from the trust score counters - the actual mode change
 * remains a human-approved action (setAutonomyMode, admin/compliance only),
 * which records the eligibility snapshot in its audit entry. */
export const GraduationCriterionSchema = z.object({
  key: z.string(),
  label: z.string(),
  met: z.boolean(),
  current: z.number(),
  required: z.string(),
});
export type GraduationCriterion = z.infer<typeof GraduationCriterionSchema>;

export const GraduationEligibilitySchema = z.object({
  subWalletId: z.string(),
  eligible: z.boolean(),
  criteria: z.array(GraduationCriterionSchema),
  evaluatedAt: z.string(),
});
export type GraduationEligibility = z.infer<typeof GraduationEligibilitySchema>;

/** Mapping from numeric score to tier label. */
export function scoreToTier(score: number): RiskTier {
  if (score <= 20) return 'low';
  if (score <= 50) return 'medium';
  if (score <= 75) return 'high';
  return 'critical';
}
