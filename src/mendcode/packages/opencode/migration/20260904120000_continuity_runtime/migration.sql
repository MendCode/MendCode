CREATE TABLE `continuity_record` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `directory` text NOT NULL,
  `kind` text NOT NULL,
  `generation` integer NOT NULL,
  `status` text NOT NULL,
  `data` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `continuity_session_kind_idx` ON `continuity_record` (`session_id`, `kind`);
