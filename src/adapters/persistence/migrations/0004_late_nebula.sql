ALTER TABLE `messages` ADD `draft_id` text REFERENCES drafts(id);
