-- The local stack gives Keycloak its own database (MVP.md 9.1, issue #97).
-- ADR 0003 keeps the enform store (log, state, outbox and jobs) in one
-- database and the identity broker out of it.
CREATE DATABASE keycloak;
