ALTER TABLE `messages` ADD `sent_from_account_id` text REFERENCES accounts(id);
