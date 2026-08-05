-- One-time backfill of per-account sending limits (see core/scheduling/sending-defaults.ts).
--
-- These columns are nullable and null means "no limit" throughout the Rate Limiter, so every
-- account connected before this migration has no daily cap, no hourly cap and no pacing at all --
-- a campaign could dispatch its whole lead list back to back. This brings existing accounts up to
-- the same conservative starting point a newly connected account now gets.
--
-- Deliberately a migration rather than a check applied at startup: it must run exactly once. A
-- startup backfill would re-apply these values every launch, silently overriding a user who had
-- deliberately cleared a field to restore "no limit" for that account.
--
-- Only ever touches columns that are still null, so an account with a limit the user already chose
-- is left exactly as it is.
UPDATE accounts SET daily_send_limit = 40 WHERE daily_send_limit IS NULL;--> statement-breakpoint
UPDATE accounts SET hourly_send_limit = 8 WHERE hourly_send_limit IS NULL;--> statement-breakpoint
UPDATE accounts SET min_send_delay_seconds = 90 WHERE min_send_delay_seconds IS NULL;--> statement-breakpoint
UPDATE accounts SET max_send_delay_seconds = 300 WHERE max_send_delay_seconds IS NULL;
