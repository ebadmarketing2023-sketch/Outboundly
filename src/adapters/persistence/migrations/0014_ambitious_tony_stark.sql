CREATE TABLE `sequence_step_content_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence_step_id` text NOT NULL,
	`template_id` text NOT NULL,
	`subject_variant_id` text NOT NULL,
	`document_model_json` text NOT NULL,
	`subject_text` text NOT NULL,
	`weight` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sequence_step_id`) REFERENCES `sequence_steps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_variant_id`) REFERENCES `subject_variants`(`id`) ON UPDATE no action ON DELETE no action
);
