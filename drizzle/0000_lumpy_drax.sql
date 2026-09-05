CREATE TABLE `spotify_enrichment_control` (
	`key` text PRIMARY KEY NOT NULL,
	`lock_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`next_request_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spotify_track_metadata` (
	`spotify_track_id` text PRIMARY KEY NOT NULL,
	`duration_ms` integer,
	`metadata_status` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
