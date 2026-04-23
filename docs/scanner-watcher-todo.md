# Scanner Watcher — Phase 6 Backlog

Parked follow-ups from the watcher build. Nothing here is blocking — all are
small surgical fixes or UX improvements to revisit once the Phase 1–5 pipeline
has landed real scans in prod.

## 1. PNG-in-JPEG mime bug, scan-ingest edition

**Where:** [server/scan-ingest-service.ts:41-102](../server/scan-ingest-service.ts#L41-L102), function `uploadImagesToCert`.

**What's wrong:** Every uploaded file is written to R2 at `images/grading/${certId}/front_original.jpg` (and variants) with `ContentType: image/jpeg`, regardless of the input buffer's actual format. When the scanner watcher uploads `.tif` files, sharp re-encodes them to JPEG via `generateImageVariants` so the bytes match the mime — fine. But if anyone else calls scan-ingest with a `.png` (e.g. the curl tests in Phase 2, or future integrations), the stored original is PNG bytes served as `image/jpeg`. Same class of bug as Phase 1 Bug 4 but on a different handler.

**Why it wasn't fixed in Phase 3:** Scope creep. Bug 4 fix was narrowly applied to the upload-images handler only. The watcher path works correctly because sharp forces JPEG encoding before write.

**Risk level:** Low in practice. Only matters if the original is ever consumed by code that trusts the mime header over sniffing. Browsers cope via content sniffing. Downstream CDN transforms or email previews could break.

**Suggested fix:** In `uploadImagesToCert`, mirror the Phase 1 Bug 4 approach — detect buffer format with `sharp(buf).metadata().format`, set mime and extension accordingly, or force-encode to a single canonical format before write. Either (a) keep `.jpg` everywhere and re-encode non-JPEG inputs, or (b) switch to a format-aware key (`.jpg` / `.png`) like the upload-images path now does.

## 2. Watcher has no startup token self-check

**Where:** [scripts/scanner-watcher/watcher.mjs](../scripts/scanner-watcher/watcher.mjs)

**What's missing:** The watcher checks that `SCANNER_API_TOKEN` is *set* before starting, but doesn't verify it's *valid*. A mistyped or stale token means every scan 401s silently, and the user only notices when files pile up in `failed/`.

**Suggested fix:** On startup, after the greeting log, hit a lightweight endpoint (e.g. `GET /api/admin/db-info` with the token — currently requireAdmin, would need a scanner-compatible health echo) and log the result. If 401, refuse to start with a clear "token doesn't match server" message.

Alternative: add `GET /api/admin/scanner/ping` that accepts `X-Scanner-Token` and returns `{ok: true}` for validation.

**Risk level:** UX-only. No security impact.

## 3. No automatic log rotation

**Where:** `~/mintvault-scans/watcher.log` is owned by launchd (plist `StandardOutPath`).

**Background:** Phase 3 originally had the watcher rotate the file itself. During Phase 4 we discovered launchd opens `watcher.log` for append *before* forking the wrapper — so if the watcher renames the file, launchd's open fd still points at the old inode and subsequent writes land in the archive file, not a fresh log. The internal rotation was removed; log file is now launchd's exclusively.

**What's missing:** No rotation at all. A long-running watcher on a home Mac might accumulate weeks of log output in a single file. Manageable on modern disks, but not infinite.

**Suggested fix options:**
- (a) Separate `rotate.sh` helper the user runs manually / via cron. It would: `launchctl bootout` → `mv watcher.log watcher-$(date +%F).log` → `launchctl bootstrap` → `find -name "watcher-*.log" -mtime +7 -delete`.
- (b) A second LaunchAgent with `StartCalendarInterval` that runs rotation daily at 03:00 (no dep, pure plist + shell).
- (c) Have the watcher fopen the log itself and set launchd's StandardOutPath to `/dev/null`. Reinstates internal rotation, but means manual `npm start` users lose stdout unless we mirror.

**Risk level:** Low. Log sizes grow slowly on a home scanner (single-digit MB/week).

## 4. Watcher doesn't surface rich errors in admin UI

**Where:** Admin "Scans" tab (client) + watcher failure path (script).

**What's missing:** When a scan fails (network, 5xx, malformed image), the watcher writes `.error.txt` locally but the admin UI has no visibility. Cornelius would have to SSH his own Mac to see them.

**Suggested fix:** Phase 6 — have the watcher POST a lightweight `/api/admin/scanner-errors` row on failure (subject/body/timestamp), surface under a "Scanner issues" section in the Scans tab. Requires new DB table + endpoint.

**Risk level:** None. Current fallback (local `.error.txt`) is adequate for single-operator use.

## 5. `scan-ingest` doesn't normalise client_source values

**Where:** [server/routes.ts:7653](../server/routes.ts#L7653)

**What's wrong:** `client_source` is stored as a free-form string. Current callers use `"admin_ui"`, `"scanner_app"`, `"scanner_watcher"`, the Phase 2 test certs have `"phase2_auth_log_test"` and `"scanner_watcher_phase2_test"` in them. No validation, no enum. Makes analytics queries awkward.

**Suggested fix:** Whitelist known values, reject unknown. Or accept free-form but log anomalies. Add a `client_source` column type / enum if we're going to query by it.

**Risk level:** None. Cosmetic data-hygiene issue.

## 6. SilverFast dual-format dumps will clutter the inbox

**Where:** Home Mac filesystem.

**What's wrong:** SilverFast SE's default is to save both `.tif` and `.jpg` on every scan. The watcher silently ignores `.jpg` (correctly), but the inbox fills with ignored files that never get moved.

**Suggested fix:** Either (a) configure SilverFast to output TIF only (user action, no code change), or (b) have the watcher actively delete/quarantine ignored duplicates when their TIF pair has been processed.

**Risk level:** UX-only. Disk space creep.

## 7. No rate-limit on scan-ingest endpoint

**Where:** [server/routes.ts:7638](../server/routes.ts#L7638)

**What's missing:** The endpoint has auth (scanner-token or admin cookie) but no rate limit. A runaway watcher could create thousands of certs before anyone notices — each triggers an AI call which costs money.

**Suggested fix:** Add `aiRateLimit` middleware (already exists — used on `/api/admin/certificates/:id/analyze-v1-legacy`) to scan-ingest. Tune for scanner cadence (e.g. 1 per 10s should be ample for manual scanning).

**Risk level:** Medium on prod. Low on staging. Worth doing before heavy use of the watcher.

---

Revisit order when ready: **#7 (rate limit)** > **#1 (PNG mime)** > **#2 (token self-check)** > **#3 (log rotation)** > rest are optional polish.
