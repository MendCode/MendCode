ALTER TABLE `background_task` ADD COLUMN `root_session_id` text;
--> statement-breakpoint
ALTER TABLE `background_task` ADD COLUMN `depth` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE INDEX `background_task_root_idx` ON `background_task` (`root_session_id`);
