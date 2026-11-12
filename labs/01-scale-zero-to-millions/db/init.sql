-- Runs once, on first start of an empty volume.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE users (
  id    bigint PRIMARY KEY,
  name  text NOT NULL
);

CREATE TABLE documents (
  id          bigint PRIMARY KEY,
  owner_id    bigint NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  body        text NOT NULL,
  version     int  NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- Serves "list my docs, newest first" without a sort step.
CREATE INDEX documents_owner_updated ON documents (owner_id, updated_at DESC);

INSERT INTO users (id, name)
SELECT g, 'user ' || g FROM generate_series(1, 10000) g;

-- 100k docs x ~1KB body ~= 110MB heap. Bigger than shared_buffers (64MB, set in compose)
-- on purpose: random reads over the whole set miss PG buffer cache and hit the OS page cache.
INSERT INTO documents (id, owner_id, title, body, updated_at)
SELECT g,
       1 + (g % 10000),
       'Doc ' || g,
       repeat(md5(g::text) || ' lorem ipsum dolor sit amet ', 18),
       now() - (g || ' seconds')::interval
FROM generate_series(1, 100000) g;

ANALYZE;
