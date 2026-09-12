import { z } from 'zod';

/** Section 6.4 - Autonomy Modes.
 * Strict: every transaction pauses for human approval regardless of policy compliance.
 * BoundedAuto: transactions within policy execute automatically; only out-of-policy /
 * flagged transactions escalate. */
export const AutonomyModeSchema = z.enum(['strict', 'bounded_auto']);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

export const DEFAULT_AUTONOMY_MODE: AutonomyMode = 'strict'; // conservative default (Section 8 risk mitigation)

export interface AutonomyModeChangeEvent {
  subWalletId: string;
  previousMode: AutonomyMode;
  newMode: AutonomyMode;
  changedByUserId: string;
  changedByRole: string;
  timestamp: string;
}
