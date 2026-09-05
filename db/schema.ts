import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const trackMetadata = sqliteTable('spotify_track_metadata', {
  spotifyTrackId: text('spotify_track_id').primaryKey(),
  durationMs: integer('duration_ms'),
  metadataStatus: text('metadata_status').notNull(),
  fetchedAt: integer('fetched_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  retryAt: integer('retry_at').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
});
export const enrichmentControl = sqliteTable('spotify_enrichment_control', {
  key: text('key').primaryKey(),
  lockToken: text('lock_token'),
  leaseUntil: integer('lease_until').notNull().default(0),
  nextRequestAt: integer('next_request_at').notNull().default(0),
});
