# Deployment state — mintvault-super-admin-credit-control

- Production/staging, Stripe, hosted databases, object storage and remote git are not contacted.
- Every proof process uses a fresh loopback PostgreSQL database and generated synthetic values.
- The one browser purchase row is fixture data only; it never represents a real Stripe payment.
