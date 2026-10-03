-- SYNTHETIC TEST DATA — not provider records or personal preferences.
CREATE ROLE bor_migrator LOGIN NOSUPERUSER CREATEDB CREATEROLE INHERIT REPLICATION BYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
GRANT anon,authenticated,service_role TO bor_migrator WITH INHERIT FALSE, SET TRUE;
GRANT CREATE,CONNECT,TEMP ON DATABASE bor_pr02_test TO bor_migrator;
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
$$;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO bor_migrator,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO bor_migrator,authenticated,service_role;
GRANT SELECT,INSERT,DELETE ON auth.users TO bor_migrator;
CREATE SCHEMA test_support AUTHORIZATION bor_migrator;
REVOKE ALL ON SCHEMA test_support FROM PUBLIC,anon,authenticated,service_role;
SET ROLE bor_migrator;
CREATE TABLE test_support.marker (name text PRIMARY KEY);
INSERT INTO test_support.marker(name) VALUES ('bor-pr02-disposable');
