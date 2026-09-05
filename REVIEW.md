# Listening Atlas duration upgrade — review

Prepared 5 September 2026. This is an unpublished review candidate. The existing live deployment has not been changed.

## Important limitation

The requested Spotify-powered listening analysis cannot responsibly be enabled under the currently published standard policy. Spotify Developer Policy III.13 restricts analysis of Spotify Content to derive listenership/user metrics or profiles; III.14 and Developer Terms IV.2 restrict AI ingestion. This affects derived completion as well as exporting raw responses. The server implementation therefore requires documented Spotify permission covering this use before it can run. Merely supplying credentials does not enable it. The ChatGPT export excludes Spotify-derived completion even when local enrichment is authorized. Independently sourced durations can drive both local analytics and export now; demo durations are clearly illustrative.

Sources checked: [Developer Policy](https://developer.spotify.com/policy), [Developer Terms](https://developer.spotify.com/terms), [Get Track](https://developer.spotify.com/documentation/web-api/reference/get-track), [Client credentials](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow), [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits), [February 2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide). These findings are implementation constraints, not legal advice or a claim of Spotify approval.

## Changes and files

| Files | Purpose |
| --- | --- |
| `public/index.html`, `app.js`, `style.css` | Existing interface retained; unobtrusive enrichment status, coverage insight, expanded song/artist/album details, source-aware duration import. Custom date label explicitly says UTC. Original stylesheet remains intact with additions appended. |
| `public/engine.js` | Existing normalization, identity and skip behavior; indexed duration lookup, simultaneous play counts, event-weighted completion, coverage and calendar memoization. |
| `public/worker.js` | Existing worker/IndexedDB pipeline; progressive metadata updates, safe legacy migration, aggregate cache and demo preservation. |
| `public/enrichment.js` | Unique-ID cache lookup, small progressive batches, cancellation and cooldown handling. |
| `public/profile.js` | Compact deterministic schema v2, definitions, all time windows, previous-period metrics and interpretable momentum. |
| `server/api.js`, `spotify.js`, `cache.js`, `index.js` | Isolated server authentication, Spotify requests, persistent cache, globally serialized batches and explicit frontend asset serving. |
| `db/schema.ts`, `drizzle/`, `.openai/hosting.json` | Additive Sites D1 cache and lease tables; no listening-history table. |
| `scripts/build.mjs`, `package.json`, lockfile, `vite.config.js` | Worker-compatible build and internal preview of existing vanilla frontend. Authored frontend moved from `dist` to `public`; generated server output stays in `dist`. |
| `tests/` | Import, analytics, profile, browser-storage migration, queue/cache and mocked Spotify regression checks. |

## Storage and privacy

Browser IndexedDB remains `listening-atlas`, version 1, with the same `data/history` value. The additional `duration_metadata_v2` key stores metadata separately, avoiding rewrites of 100,000 events during enrichment. Existing histories and legacy duration values remain readable; legacy source-unknown durations are excluded from AI completion. Imports keep their existing replace-and-deduplicate behavior. Demo does not overwrite saved history.

Sites D1 binding `DB` contains `spotify_track_metadata` (exact ID, duration, status, fetched/expiry/retry timestamps, attempts) and `spotify_enrichment_control` (global lease/cooldown). The generated migration only creates these new tables. No production migration has run because this candidate is not deployed. Successful and permanent-failure records expire after 30 days; expired records are ignored and lazily removed on API activity. This is bounded caching, not indefinite mirroring. Only unique track IDs cross from browser to enrichment server and Spotify; listening timestamps, played milliseconds and profiles do not.

## Spotify and setup

Authentication is server-to-server `POST https://accounts.spotify.com/api/token`, client credentials grant. Metadata uses currently documented `GET https://api.spotify.com/v1/tracks/{id}?market=CA`, one exact 22-character ID per request. Returned ID must match the requested ID: relinked alternate releases are rejected. No account login, scopes, library, playlist or playback integration is added.

The Site currently has no hosted environment variables. In the existing Site's settings, use its Environment variables section to enter `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` as secrets. Do not put them in frontend code, files committed to source, or chat. Leave `SPOTIFY_ANALYTICS_PERMISSION` unset unless Spotify has explicitly authorized this analysis use; only then set it to `granted`. This flag records external authorization and is not a substitute for obtaining it. The backend reads these values only at runtime. Development-mode access also depends on Spotify's current app/account eligibility, including the Premium requirement documented in its migration guide.

No setup is necessary to keep using the existing app, or to import independently sourced duration data. Production runtime bindings and a real Spotify response still require verification after authorization/configuration and an approved deployment.

## Queue, caching and failure behavior

Local metadata avoids repeated cache requests. Server lookup handles up to 80 unique IDs; enrichment handles at most 8 per call, serially with one-second spacing. A D1 lease serializes batches across requests/instances. Tokens are cached in server memory and refreshed once after 401. Requests time out after eight seconds. A 429 pauses the global queue using Retry-After, with a conservative fallback. Browser resumes short cooldowns and allows manual retry after longer ones. Network/5xx failures use bounded exponential backoff, at most three persisted attempts per cache lifetime; exhausted failures remain unavailable until expiry. Invalid/unavailable tracks and identity mismatches are cached as failures. Enrichment never blocks core import or raw-history analytics. A closed browser pauses progression; no scheduled background service is added.

## Metrics and profile

Each valid-duration event uses `min(ms_played / duration_ms, 1)`. Invalid/unknown/expired durations are excluded, never treated as zero. Zero-ms events with known duration legitimately count as zero completion. Raw listening time is never capped or filtered by the Count plays selector. Full listen is at least 90%, near-complete at least 75%, early exit below 25%. Means, exact medians and rates use underlying events, including for artists/albums. Coverage reports known events and associated raw listening time, plus identified/enriched/missing-ID tracks. Skip rate still uses explicit boolean skip flags, independently of completion.

Schema version is 2. Every exported aggregate includes `plays.all_events`, `gte_30_seconds`, `gte_60_seconds`; the UI selection does not change analytical counts or rankings. Completion contains known-event count, coverage, mean, median, full/near/early rates and listening-time coverage. No eligible durations means null completion values. Selected/custom, previous equal-length period, 7/30/90/180-day and all-time windows are retained. Top lists are bounded (100 tracks, 30 artists, 30 albums), with current/previous momentum including entities that cool to zero. Definitions explicitly document identity, denominators, date boundaries and source restrictions. No raw durations, API objects, secrets or event-history dump are exported. Spotify-derived and unknown-source duration metrics are excluded from every AI-facing section.

## Verification and remaining limits

All 24 automated regression tests pass. Coverage includes A–G, I–V from the requested checklist: streaming/atomic import, old IndexedDB preservation, date/custom/timezone boundaries, play thresholds, invariant listening time/skip rate, secret isolation, persistent cache, unavailable tracks, outage isolation, 429, partial completion/capping, valid v2 JSON, all counts, source-aware completion and demo preservation. H (live known-track enrichment) is exercised with mocked Spotify responses only and remains unverified against the live service. The actual generated D1 migrations are used in SQLite-backed cache tests.

Internal browser verification imported 100,005 synthetic events, reloaded saved history, exercised navigation, presets/custom dates/timezone, threshold selection, history pagination, search, demo, independent duration import and profile download. Half-known metadata produced approximately 50% coverage and 40% mean completion without zero-filling unknown events. Downloaded JSON parsed successfully at about 40 KB for the synthetic dataset. A 100,000-event aggregation took about 326 ms in the local Node benchmark; this is not a guarantee for every device. Desktop visual inspection preserved the charcoal/lime layout, sidebar and four headline cards; mobile layout was not separately browser-tested. Built-Worker checks verified frontend responses contain no test credentials and server/environment source paths return 404.

Limitations: fixed CA market may mark some regional tracks unavailable; returned alternate IDs are intentionally not substituted. Completion estimates duration listened, not whether playback was contiguous or manually sought. No title guessing, alternate-release merging, arbitrary taste scores, cloud history sync, trackers, or metadata-clear UI was added. Production D1 deployment and live Spotify credentials/network behavior remain outstanding. Review this candidate before any deployment.
