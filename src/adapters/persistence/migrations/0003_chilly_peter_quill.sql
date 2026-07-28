CREATE TABLE `business_hours_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text NOT NULL,
	`windows_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaign_enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`current_step_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`next_send_at` integer,
	`enrolled_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sequence_id` text NOT NULL,
	`sending_account_ids` text NOT NULL,
	`business_hours_profile_id` text NOT NULL,
	`warmup_profile_id` text,
	`delay_policy_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`daily_limit_override` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`business_hours_profile_id`) REFERENCES `business_hours_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warmup_profile_id`) REFERENCES `warmup_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contact_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`label_id` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contact_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`company` text,
	`title` text,
	`timezone` text,
	`custom_fields` text,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `delay_policy_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text,
	`min_delay_seconds` integer NOT NULL,
	`max_delay_seconds` integer NOT NULL,
	`jitter_strategy` text DEFAULT 'uniform' NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text
);
--> statement-breakpoint
CREATE TABLE `send_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`account_id` text NOT NULL,
	`priority` text NOT NULL,
	`earliest_send_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sequence_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_id` text NOT NULL,
	`step_order` integer NOT NULL,
	`delay_days` integer DEFAULT 0 NOT NULL,
	`delay_hours` integer DEFAULT 0 NOT NULL,
	`template_id` text NOT NULL,
	`stop_on_reply` integer DEFAULT true NOT NULL,
	`stop_on_bounce` integer DEFAULT true NOT NULL,
	`condition_json` text,
	FOREIGN KEY (`sequence_id`) REFERENCES `sequences`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subject_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_step_id` text NOT NULL,
	`subject_text` text NOT NULL,
	`weight` integer NOT NULL,
	FOREIGN KEY (`sequence_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `suppression_list` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `template_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`variant_label` text NOT NULL,
	`weight` integer NOT NULL,
	`document_model_override_json` text,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`document_model_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `warmup_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`start_date` integer NOT NULL,
	`ramp_schedule_json` text NOT NULL,
	`current_daily_cap` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaign_enrollments_status_next_send_idx` ON `campaign_enrollments` (`status`,`next_send_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_labels_contact_label_idx` ON `contact_labels` (`contact_id`,`label_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_idx` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `send_queue_status_earliest_send_idx` ON `send_queue` (`status`,`earliest_send_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `send_queue_idempotency_key_idx` ON `send_queue` (`idempotency_key`);