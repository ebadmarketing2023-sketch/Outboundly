CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`related_account_id` text,
	`related_campaign_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`related_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);