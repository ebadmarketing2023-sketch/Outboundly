CREATE TABLE `lead_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `contacts` ADD `import_batch_id` text REFERENCES lead_import_batches(id);--> statement-breakpoint
ALTER TABLE `contacts` ADD `deleted_at` integer;