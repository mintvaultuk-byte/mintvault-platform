# Canon LiDE 400 cutover

Perform this only after the server release containing capture sessions and the append-only evidence migration is live. Keep cards off the desk during the swap.

1. Record or preserve historical hot-folder TIFFs. They are not production captures after cutover and will be quarantined rather than uploaded.
2. Stop every legacy scanner agent, then confirm only the unified label remains:

   ```sh
   cd ~/mintvault-platform/scripts/scanner-app
   ./uninstall.sh
   ./setup-new-mac.sh
   launchctl list | grep mintvault
   ```

   The expected live label is exactly `com.mintvault.scanner`. If an old watcher or `com.mintvault.scanner-app` remains, stop before proceeding.

3. Confirm the menu-bar popover reports `ready` for the Canon LiDE 400. If it reports `profile_unprovisioned`, enter the measured fixture origin; if it reports `disconnected` or `busy`, do not capture.
4. Complete the physical acceptance sequence in [`docs/MINTVAULT_CANON_LIDE_400_INTEGRATION.md`](../../docs/MINTVAULT_CANON_LIDE_400_INTEGRATION.md). It must verify a selected certificate/card/side, a 1200-DPI TIFF master, provenance/audit rows, R2 object hash, a controlled recapture, and grading preview updates.
5. Use only Card Details → arm **SCAN FRONT** → scanner app displays the target → physically position the card → **SCAN FRONT** → preview → **ACCEPT FRONT** (or **RESCAN FRONT**) → flip → arm/scan/preview/**ACCEPT BACK**. Target arming never starts a scan. Never configure a scanner application to export into the old inbox.

Rollback is a deployment decision, not an operator toggle: stop the unified agent first, preserve local TIFFs and evidence records, then deploy the previous compatible server and agent together. Do not mix old hot-folder code with a database that has begun using target-bound evidence revisions.
