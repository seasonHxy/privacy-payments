CREATE TABLE workspaces (
 id text PRIMARY KEY,
 mode text NOT NULL CHECK (mode='L0'),
 payload bytea NOT NULL
);
CREATE TABLE memberships (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 user_id text NOT NULL,
 role text NOT NULL CHECK(role IN ('payer','admin','viewer','recipient')),
 PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE invoices (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 current_version integer NOT NULL CHECK(current_version>0),
 settled boolean NOT NULL DEFAULT false,
 payload bytea NOT NULL,
 UNIQUE(workspace_id,id)
);
CREATE TABLE invoice_versions (
 workspace_id text NOT NULL,
 invoice_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 payload bytea NOT NULL,
 PRIMARY KEY(invoice_id,version),
 UNIQUE(workspace_id,invoice_id,version),
 FOREIGN KEY(workspace_id,invoice_id) REFERENCES invoices(workspace_id,id)
);
ALTER TABLE invoices ADD CONSTRAINT current_version_exists
 FOREIGN KEY(id,current_version) REFERENCES invoice_versions(invoice_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE approvals (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 invoice_id uuid NOT NULL,
 version integer NOT NULL,
 active boolean NOT NULL,
 payload bytea NOT NULL,
 UNIQUE(workspace_id,invoice_id,version,id),
 FOREIGN KEY(workspace_id,invoice_id,version) REFERENCES invoice_versions(workspace_id,invoice_id,version)
);
CREATE UNIQUE INDEX one_active_approval ON approvals(invoice_id,version) WHERE active;
CREATE TABLE payment_attempts (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 invoice_id uuid NOT NULL,
 version integer NOT NULL,
 approval_id uuid NOT NULL,
 idempotency_tag bytea NOT NULL,
 state text NOT NULL CHECK(state IN ('CREATED','QUOTED','AWAITING_SIGNATURE','SUBMITTED','VERIFYING','VERIFIED_SUCCESS','USER_REJECTED','UNKNOWN','FAILED_NO_TRANSFER','REFUND_PENDING','REFUNDED','REVIEW_REQUIRED')),
 revision integer NOT NULL CHECK(revision>=0),
 payload bytea NOT NULL,
 UNIQUE(workspace_id,idempotency_tag),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,invoice_id,version,approval_id) REFERENCES approvals(workspace_id,invoice_id,version,id)
);
CREATE UNIQUE INDEX one_active_attempt ON payment_attempts(invoice_id) WHERE state NOT IN ('USER_REJECTED','FAILED_NO_TRANSFER');
CREATE TABLE quote_snapshots (
 workspace_id text NOT NULL,
 attempt_id uuid NOT NULL,
 revision integer NOT NULL,
 payload bytea NOT NULL,
 PRIMARY KEY(attempt_id,revision),
 FOREIGN KEY(workspace_id,attempt_id) REFERENCES payment_attempts(workspace_id,id)
);
CREATE TABLE settlement_evidence (
 attempt_id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 event_tag bytea NOT NULL UNIQUE,
 payload bytea NOT NULL,
 FOREIGN KEY(workspace_id,attempt_id) REFERENCES payment_attempts(workspace_id,id)
);
CREATE TABLE disclosure_grants (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL,
 invoice_id uuid NOT NULL,
 version integer NOT NULL,
 recipient text NOT NULL,
 payload bytea NOT NULL,
 FOREIGN KEY(workspace_id,invoice_id,version) REFERENCES invoice_versions(workspace_id,invoice_id,version),
 FOREIGN KEY(workspace_id,recipient) REFERENCES memberships(workspace_id,user_id)
);
CREATE TABLE audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 payload bytea NOT NULL
);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_invoice_version BEFORE UPDATE OR DELETE ON invoice_versions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_quote BEFORE UPDATE OR DELETE ON quote_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION guard_new_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid boolean; current_v integer; approved boolean;
BEGIN
 SELECT settled,current_version INTO paid,current_v FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
 IF paid OR current_v <> NEW.version THEN RAISE EXCEPTION 'settled or stale invoice' USING ERRCODE='23514'; END IF;
 SELECT active INTO approved FROM approvals WHERE id=NEW.approval_id;
 IF approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'inactive approval' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_new_attempt BEFORE INSERT ON payment_attempts FOR EACH ROW EXECUTE FUNCTION guard_new_attempt();
