CREATE TABLE `account_health_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`finding_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`explanation` text NOT NULL,
	`recommended_action` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `account_health_snapshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account_health_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`captured_at` integer NOT NULL,
	`bounce_rate` integer,
	`reply_rate` integer,
	`spam_complaint_rate` integer,
	`sends_last_24h` integer NOT NULL,
	`sends_last_7d` integer NOT NULL,
	`account_age_days` integer NOT NULL,
	`sending_consistency_score` integer,
	`spf_status` text NOT NULL,
	`dkim_status` text NOT NULL,
	`dmarc_status` text NOT NULL,
	`oauth_failure_count_30d` integer NOT NULL,
	`token_expiring_soon` integer NOT NULL,
	`provider_quota_usage_pct` integer,
	`health_score` integer NOT NULL,
	`risk_level` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deliverability_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`campaign_id` text,
	`account_id` text,
	`scope` text NOT NULL,
	`generated_at` integer NOT NULL,
	`overall_score` integer NOT NULL,
	`findings_json` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lab_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`input_snapshot_json` text NOT NULL,
	`score` integer NOT NULL,
	`findings_json` text NOT NULL,
	`generated_at` integer NOT NULL
);
