-- Immutable encrypted L1 invoice versions; legacy v1 is backfilled by the service under its storage key.
CREATE TABLE l1_invoice_versions (
 invoice_id uuid NOT NULL REFERENCES l1_invoices(id),
 version integer NOT NULL CHECK(version > 0),
 payload bytea NOT NULL,
 PRIMARY KEY(invoice_id,version)
);
CREATE FUNCTION l1_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'L1 invoice versions are immutable'; END $$;
CREATE TRIGGER l1_version_immutable BEFORE UPDATE OR DELETE ON l1_invoice_versions
 FOR EACH ROW EXECUTE FUNCTION l1_immutable_version();
CREATE TABLE l1_disclosures (
 id uuid PRIMARY KEY,
 invoice_id uuid NOT NULL,
 version integer NOT NULL,
 recipient_tag bytea NOT NULL,
 expires_at bigint NOT NULL,
 revoked_at bigint,
 payload bytea NOT NULL,
 FOREIGN KEY(invoice_id,version) REFERENCES l1_invoice_versions(invoice_id,version)
);
CREATE INDEX l1_disclosure_recipient ON l1_disclosures(recipient_tag);
