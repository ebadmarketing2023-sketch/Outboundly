ALTER TABLE `accounts` ADD `min_send_delay_seconds` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `max_send_delay_seconds` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `next_allowed_send_at` integer;