CREATE TABLE `agent_command` (
  `id` text PRIMARY KEY NOT NULL,
  `source_session_id` text NOT NULL,
  `target_session_id` text NOT NULL,
  `state` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`target_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `agent_command_source_idx` ON `agent_command` (`source_session_id`);
CREATE INDEX `agent_command_target_idx` ON `agent_command` (`target_session_id`);
CREATE INDEX `agent_command_state_idx` ON `agent_command` (`state`);
CREATE INDEX `agent_command_time_updated_idx` ON `agent_command` (`time_updated`);
