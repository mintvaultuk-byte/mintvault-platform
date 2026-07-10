let logged = false;
let vqLogged = false;

export function getDatabaseUrl(): string {
  const dbUrl = process.env.MINTVAULT_DATABASE_URL;

  if (!dbUrl) {
    throw new Error("MINTVAULT_DATABASE_URL is not set");
  }

  if (!logged) {
    try {
      const parsed = new URL(dbUrl);
      console.log(`[config] ENV=${process.env.NODE_ENV || "development"} DB_HOST=${parsed.hostname} DB_NAME=${parsed.pathname.slice(1)} (Using MINTVAULT_DATABASE_URL)`);
    } catch {
      console.log(`[config] ENV=${process.env.NODE_ENV || "development"} (Using MINTVAULT_DATABASE_URL, unable to parse host)`);
    }
    logged = true;
  }

  return dbUrl;
}

/**
 * Vault Quest database URL. Read ONLY from VAULT_QUEST_DATABASE_URL — Vault Quest
 * NEVER falls back to the MintVault grading database. Throws a clear fail-closed
 * error when unset so Vault Quest routes surface "not configured" instead of
 * silently using grading data. Called lazily (first VQ query), so the MintVault
 * app still boots when this variable is absent.
 */
export function getVaultQuestDatabaseUrl(): string {
  const url = process.env.VAULT_QUEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      "VAULT_QUEST_DATABASE_URL is not set — the Vault Quest data layer is not configured. " +
        "Vault Quest fails closed and NEVER falls back to the MintVault grading database. " +
        "Set VAULT_QUEST_DATABASE_URL to enable Vault Quest routes.",
    );
  }

  if (!vqLogged) {
    try {
      const parsed = new URL(url);
      console.log(`[config] Vault Quest DB_HOST=${parsed.hostname} DB_NAME=${parsed.pathname.slice(1)} (Using VAULT_QUEST_DATABASE_URL)`);
    } catch {
      console.log(`[config] Vault Quest (Using VAULT_QUEST_DATABASE_URL, unable to parse host)`);
    }
    vqLogged = true;
  }

  return url;
}
