export type CompletedChallenge = { challenge_id: string; title: string; bonus_points: number; reward_id: string | null };

/** Result shapes returned by the check_in / confirm_visit SQL functions. */
export type CheckInResult =
  | {
      status: "confirmed";
      visit_id: string;
      points_awarded?: number;
      points_balance: number;
      streak: number;
      tier: string;
      tier_upgraded?: boolean;
      already_confirmed?: boolean;
      streak_bonus?: number;
      challenges_completed?: CompletedChallenge[];
    }
  | { status: "pending"; visit_id: string }
  | { status: "cooldown"; visit_id: string; next_eligible_at: string };

/** Maps errors raised by the SQL functions to API error codes and HTTP statuses. */
const KNOWN_ERRORS: Record<string, number> = {
  tag_not_found: 404,
  visit_not_found: 404,
  reward_not_found: 404,
  visit_rejected: 409,
  reward_not_claimable: 400,
  not_a_member: 403,
  not_staff: 403,
  tier_too_low: 403,
  insufficient_points: 409,
  reward_redeemed: 409,
  reward_expired: 410,
  reward_revoked: 410,
};

export function mapDbError(message: string | undefined): { code: string; status: number } {
  if (message && message in KNOWN_ERRORS) return { code: message, status: KNOWN_ERRORS[message] };
  return { code: "internal_error", status: 500 };
}
