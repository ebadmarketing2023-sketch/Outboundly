ALTER TABLE `messages` ADD `template_id` text REFERENCES templates(id);
--> statement-breakpoint
ALTER TABLE `messages` ADD `subject_variant_id` text REFERENCES subject_variants(id);
