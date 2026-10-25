CREATE TABLE auth_challenges (
 id uuid PRIMARY KEY,
 nonce_tag bytea NOT NULL UNIQUE,
 expires_at bigint NOT NULL,
 consumed_at bigint,
 payload bytea NOT NULL
);
CREATE INDEX auth_challenge_expiry ON auth_challenges(expires_at);
CREATE TABLE auth_sessions (
 token_tag bytea PRIMARY KEY,
 expires_at bigint NOT NULL,
 revoked_at bigint,
 payload bytea NOT NULL
);
CREATE INDEX auth_session_expiry ON auth_sessions(expires_at);
