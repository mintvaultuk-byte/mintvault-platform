-- ============================================================================================
-- 0086 — RECENT-AUTHENTICATION STEP-UP FOR PARTNER SESSIONS (AG-3)
--
-- THE GAP. The only re-authentication primitive in the partner system is verifyPassword(), wired
-- exclusively into the four MFA credential routes. Everything else rides a plain session: buying
-- Grading Credits, changing a colleague's role, inviting or removing staff, revoking sessions. A
-- session left open on an unattended shop-floor browser is therefore enough to spend the shop's
-- money or promote an account, and the only things standing in the way are a typed-confirm dialog
-- and a mandatory reason string — both of which are UI, not authority.
--
-- WHAT THIS ADDS. One nullable timestamp: when did the human at this session last PROVE they are
-- who the session says they are, by re-entering their password (and their second factor, when one
-- is enrolled). High-risk routes then require that proof to be recent.
--
-- WHY A TIMESTAMP RATHER THAN A FLAG. A boolean cannot expire. The whole value of step-up is that
-- it decays: proving yourself at 09:00 must not still authorise a credit purchase at 17:00 on a
-- machine anyone can walk up to.
--
-- WHY NOT SIMPLY DEMAND MFA MORE OFTEN. Because that would break the shift. Scanning is the
-- high-frequency path and must stay fast — locked requirement. Step-up is deliberately scoped to
-- the small set of rare, expensive, hard-to-undo actions, and NEW/FIX capture is not among them:
-- a card costs one credit the shop already bought, and every capture is already bound to an
-- approved station AND an MFA-passed operator.
--
-- NULLABLE ON PURPOSE. Every existing session predates this column and has therefore never stepped
-- up, which is exactly what NULL means. It must read as "not recently authenticated" — fail-closed —
-- rather than being backfilled to now(), which would silently hand every open session a free pass
-- at the moment of deployment.
--
-- ADDITIVE AND OLD-VERSION-SAFE: an app version that does not know this column keeps working; it
-- simply never writes or reads it (invariant I17).
--
-- ROLLBACK: rollback-0086-partner-session-step-up.sql drops the column. Losing it loses only the
-- record of who recently re-authenticated, which fails closed by construction.
-- ============================================================================================

ALTER TABLE partner_sessions ADD COLUMN IF NOT EXISTS last_step_up_at timestamptz;

COMMENT ON COLUMN partner_sessions.last_step_up_at IS
  'When this session last re-proved the human (password + current second factor). NULL means never; never backfill it.';

-- ---------------------------------------------------------------------------------------------
-- Fail-closed assertions, in the same transaction as the change.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'partner_sessions' AND column_name = 'last_step_up_at'
  ) THEN
    RAISE EXCEPTION '0086 did not add partner_sessions.last_step_up_at';
  END IF;

  -- It must be NULLABLE. A NOT NULL DEFAULT now() would grant every session already open at deploy
  -- time a fresh step-up it never performed — the exact failure this column exists to prevent.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'partner_sessions' AND column_name = 'last_step_up_at'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION '0086: last_step_up_at must be nullable so an un-stepped-up session fails closed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM partner_sessions WHERE last_step_up_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0086 must not backfill last_step_up_at on existing sessions';
  END IF;
END$$;
