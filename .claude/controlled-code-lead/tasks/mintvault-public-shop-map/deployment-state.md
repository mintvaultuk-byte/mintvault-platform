# Deployment state — mintvault-public-shop-map

- Production/staging: not queried, contacted or mutated.
- Remote git: not pushed.
- Runtime proof: two fresh databases inside the existing task-labelled loopback PostgreSQL 17
  container, each bootstrapped through the deterministic browser fixture; local app ports 5177 and
  5178 only.
- Public reader: the local-only restricted runtime login was granted the already-migrated public
  reader group solely inside that disposable cluster. No hosted role, URL, credential or object
  store was contacted.
- Map provider: no map SDK, geocoding API, tile service, Google credential, or outbound map request
  was made. Browser proof inspected generated outbound links only.
