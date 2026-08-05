-- One-time repair of lead data that CSV import escaped on the way in.
--
-- importContactsCsv used to run every cell through neutralizeCsvCell before storing it, prefixing
-- an apostrophe to any value starting with = + - or @ (the spreadsheet formula-injection guard).
-- That guard belongs on export, where a spreadsheet app actually opens the file -- applied on
-- import it corrupted the stored value, and that same value is what personalization puts into the
-- email a lead reads: a company named "+Post Inc" went out as "Saw you're at '+Post Inc."
--
-- Import no longer escapes, but rows imported before that change are still mangled in place, so
-- they are unescaped here. Deliberately narrow: only a leading apostrophe followed by one of the
-- four escaped characters is removed, which is exactly the sequence the old code produced. A name
-- that genuinely begins with an apostrophe ("'Tis Season Ltd") is untouched.
UPDATE contacts SET first_name = substr(first_name, 2) WHERE substr(first_name, 1, 2) IN ('''=', '''+', '''-', '''@');--> statement-breakpoint
UPDATE contacts SET last_name = substr(last_name, 2) WHERE substr(last_name, 1, 2) IN ('''=', '''+', '''-', '''@');--> statement-breakpoint
UPDATE contacts SET company = substr(company, 2) WHERE substr(company, 1, 2) IN ('''=', '''+', '''-', '''@');--> statement-breakpoint
UPDATE contacts SET title = substr(title, 2) WHERE substr(title, 1, 2) IN ('''=', '''+', '''-', '''@');--> statement-breakpoint
UPDATE contacts SET timezone = substr(timezone, 2) WHERE substr(timezone, 1, 2) IN ('''=', '''+', '''-', '''@');--> statement-breakpoint
-- custom_fields is a JSON object, so the escape always appears immediately after the opening quote
-- of a value (JSON.stringify emits no whitespace): {"Website URL":"'=..."}. Replacing that exact
-- 3-character sequence cannot match anything else in well-formed JSON, since a `"` directly
-- preceded by `:` only ever starts a value.
UPDATE contacts SET custom_fields = replace(custom_fields, ':"''=', ':"=') WHERE custom_fields LIKE '%:"''=%';--> statement-breakpoint
UPDATE contacts SET custom_fields = replace(custom_fields, ':"''+', ':"+') WHERE custom_fields LIKE '%:"''+%';--> statement-breakpoint
UPDATE contacts SET custom_fields = replace(custom_fields, ':"''-', ':"-') WHERE custom_fields LIKE '%:"''-%';--> statement-breakpoint
UPDATE contacts SET custom_fields = replace(custom_fields, ':"''@', ':"@') WHERE custom_fields LIKE '%:"''@%';
