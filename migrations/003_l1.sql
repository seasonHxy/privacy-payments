-- L1 has its own encrypted namespace. No L0 record can be settled by these rows.
CREATE TABLE l1_invoices (
 id uuid PRIMARY KEY,
 idempotency_tag bytea NOT NULL UNIQUE,
 revision integer NOT NULL CHECK(revision >= 0),
 payload bytea NOT NULL
);
CREATE TABLE l1_events (
 event_tag bytea PRIMARY KEY,
 invoice_id uuid NOT NULL UNIQUE REFERENCES l1_invoices(id)
);
