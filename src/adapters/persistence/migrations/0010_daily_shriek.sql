CREATE TABLE `error_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`source` text NOT NULL,
	`error_type` text NOT NULL,
	`error_message` text NOT NULL,
	`campaign_id` text,
	`account_id` text,
	`recipient_email` text,
	`retry_count` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `error_logs_occurred_at_idx` ON `error_logs` (`occurred_at`);