let logged = false;

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
