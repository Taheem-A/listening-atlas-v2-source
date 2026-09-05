// Only public track identifiers/statuses belong here. Never insert listening events or credentials.
export class MetadataCache {
  constructor(db) { this.db = db; }
  async get(ids) {
    if (!ids.length) return [];
    const records=[];
    for(let i=0;i<ids.length;i+=80){
      const batch=ids.slice(i,i+80);
      records.push(...(await this.db.prepare(`SELECT * FROM spotify_track_metadata WHERE spotify_track_id IN (${batch.map(()=>'?').join(',')})`).bind(...batch).all()).results);
    }
    return records;
  }
  async put(row) {
    await this.db.prepare(`INSERT INTO spotify_track_metadata (spotify_track_id,duration_ms,metadata_status,fetched_at,expires_at,retry_at,attempts) VALUES (?,?,?,?,?,?,?) ON CONFLICT(spotify_track_id) DO UPDATE SET duration_ms=excluded.duration_ms,metadata_status=excluded.metadata_status,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,retry_at=excluded.retry_at,attempts=excluded.attempts`).bind(row.spotify_track_id,row.duration_ms,row.metadata_status,row.fetched_at,row.expires_at,row.retry_at,row.attempts).run();
  }
  async prune(now) { await this.db.prepare('DELETE FROM spotify_track_metadata WHERE expires_at <= ?').bind(now).run(); }
  async stats() { return await this.db.prepare("SELECT COUNT(*) AS tracks, SUM(CASE WHEN metadata_status='ready' THEN 1 ELSE 0 END) AS enriched, MAX(fetched_at) AS last_enrichment FROM spotify_track_metadata").first(); }
  async control() { return await this.db.prepare("SELECT * FROM spotify_enrichment_control WHERE key='spotify'").first(); }
  async claim(now, token) {
    await this.db.prepare("INSERT INTO spotify_enrichment_control (key) VALUES ('spotify') ON CONFLICT(key) DO NOTHING").run();
    const r = await this.db.prepare("UPDATE spotify_enrichment_control SET lock_token=?,lease_until=? WHERE key='spotify' AND lease_until<=? AND next_request_at<=?").bind(token,now+180000,now,now).run();
    return r.meta.changes === 1;
  }
  async release(token, next) {
    await this.db.prepare("UPDATE spotify_enrichment_control SET lock_token=NULL,lease_until=0,next_request_at=MAX(next_request_at,?) WHERE key='spotify' AND lock_token=?").bind(next,token).run();
  }
}
