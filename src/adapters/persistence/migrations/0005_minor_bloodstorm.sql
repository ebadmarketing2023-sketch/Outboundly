CREATE TABLE `account_metrics_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`bounced_count` integer DEFAULT 0 NOT NULL,
	`replied_count` integer DEFAULT 0 NOT NULL,
	`positive_reply_count` integer DEFAULT 0 NOT NULL,
	`unsubscribed_count` integer DEFAULT 0 NOT NULL,
	`conversion_count` integer DEFAULT 0 NOT NULL,
	`opened_count` integer DEFAULT 0 NOT NULL,
	`clicked_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaign_metrics_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`bounced_count` integer DEFAULT 0 NOT NULL,
	`replied_count` integer DEFAULT 0 NOT NULL,
	`positive_reply_count` integer DEFAULT 0 NOT NULL,
	`unsubscribed_count` integer DEFAULT 0 NOT NULL,
	`conversion_count` integer DEFAULT 0 NOT NULL,
	`opened_count` integer DEFAULT 0 NOT NULL,
	`clicked_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`message_id` text,
	`campaign_id` text,
	`account_id` text,
	`occurred_at` integer NOT NULL,
	`metadata_json` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`insight_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`explanation` text NOT NULL,
	`recommended_action` text,
	`generated_at` integer NOT NULL,
	`dismissed_at` integer
);
--> statement-breakpoint
CREATE TABLE `subject_metrics_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_variant_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`bounced_count` integer DEFAULT 0 NOT NULL,
	`replied_count` integer DEFAULT 0 NOT NULL,
	`positive_reply_count` integer DEFAULT 0 NOT NULL,
	`unsubscribed_count` integer DEFAULT 0 NOT NULL,
	`conversion_count` integer DEFAULT 0 NOT NULL,
	`opened_count` integer DEFAULT 0 NOT NULL,
	`clicked_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`subject_variant_id`) REFERENCES `subject_variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `template_metrics_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`bounced_count` integer DEFAULT 0 NOT NULL,
	`replied_count` integer DEFAULT 0 NOT NULL,
	`positive_reply_count` integer DEFAULT 0 NOT NULL,
	`unsubscribed_count` integer DEFAULT 0 NOT NULL,
	`conversion_count` integer DEFAULT 0 NOT NULL,
	`opened_count` integer DEFAULT 0 NOT NULL,
	`clicked_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_classification` text;--> statement-breakpoint
CREATE UNIQUE INDEX `account_metrics_rollup_account_period_idx` ON `account_metrics_rollup` (`account_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_metrics_rollup_campaign_period_idx` ON `campaign_metrics_rollup` (`campaign_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `events_campaign_event_occurred_idx` ON `events` (`campaign_id`,`event_type`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_account_event_occurred_idx` ON `events` (`account_id`,`event_type`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subject_metrics_rollup_subject_period_idx` ON `subject_metrics_rollup` (`subject_variant_id`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_metrics_rollup_template_period_idx` ON `template_metrics_rollup` (`template_id`,`period_start`);