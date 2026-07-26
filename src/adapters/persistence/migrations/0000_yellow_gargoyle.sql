CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`email_address` text NOT NULL,
	`display_name` text,
	`status` text NOT NULL,
	`connected_at` integer NOT NULL,
	`last_synced_at` integer,
	`daily_send_limit` integer,
	`hourly_send_limit` integer,
	`warmup_mode` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`thread_id` text,
	`subject` text DEFAULT '' NOT NULL,
	`document_model_json` text NOT NULL,
	`to_addresses` text NOT NULL,
	`cc_addresses` text,
	`bcc_addresses` text,
	`provider_draft_ref` text,
	`autosave_version` integer DEFAULT 0 NOT NULL,
	`last_saved_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`account_id` text NOT NULL,
	`provider_message_id` text,
	`message_id_header` text NOT NULL,
	`in_reply_to_header` text,
	`references_header` text,
	`direction` text NOT NULL,
	`from_address` text NOT NULL,
	`to_addresses` text NOT NULL,
	`cc_addresses` text,
	`bcc_addresses` text,
	`subject` text DEFAULT '' NOT NULL,
	`body_html` text,
	`body_text` text,
	`snippet` text,
	`starred` integer DEFAULT false NOT NULL,
	`sent_at` integer,
	`received_at` integer,
	`status` text NOT NULL,
	`campaign_enrollment_id` text,
	`policy_trace_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_token_ref` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`refresh_status` text NOT NULL,
	`last_refreshed_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_thread_id` text,
	`subject_normalized` text NOT NULL,
	`conversation_state` text DEFAULT 'active' NOT NULL,
	`archived_at` integer,
	`snoozed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
