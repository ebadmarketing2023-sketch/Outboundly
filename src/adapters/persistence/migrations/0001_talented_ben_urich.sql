CREATE TABLE `conversation_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`contact_id` text,
	`email_address` text NOT NULL,
	`display_name` text,
	`role` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `message_reference_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`referenced_message_id_header` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `thread_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`absorbed_thread_id` text NOT NULL,
	`canonical_thread_id` text NOT NULL,
	`reason` text NOT NULL,
	`merged_at` integer NOT NULL,
	FOREIGN KEY (`absorbed_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`canonical_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `sync_cursor` text;