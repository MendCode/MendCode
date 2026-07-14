CREATE TABLE `loop_artifact` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `run_id` text,
  `session_id` text,
  `sequence` integer NOT NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL,
  `summary` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text,
  FOREIGN KEY (`workflow_id`) REFERENCES `loop_workflow`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`run_id`) REFERENCES `loop_run`(`id`) ON UPDATE no action ON DELETE set null,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `loop_artifact_workflow_sequence_idx` ON `loop_artifact` (`workflow_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `loop_artifact_workflow_time_idx` ON `loop_artifact` (`workflow_id`,`time_created`);
--> statement-breakpoint
CREATE INDEX `loop_artifact_run_idx` ON `loop_artifact` (`run_id`);
--> statement-breakpoint
CREATE INDEX `loop_artifact_kind_idx` ON `loop_artifact` (`kind`);
