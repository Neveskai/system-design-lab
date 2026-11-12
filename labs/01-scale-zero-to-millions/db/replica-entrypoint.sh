#!/bin/sh
# Streaming replica (book fig 1-5, "database replication").
# First start: copy the primary with pg_basebackup, then follow its WAL stream.
# -R writes primary_conninfo + standby.signal; -S uses a replication slot so the primary
# keeps WAL the replica has not received yet (see max_slot_wal_keep_size on the primary).
set -e
export PGPASSWORD="$REPLICATION_PASSWORD"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h postgres -U "$REPLICATION_USER" -q; do sleep 1; done
  # A slot left over from a deleted replica volume would block a new one with the same name.
  psql -h postgres -U "$REPLICATION_USER" -d postgres -qtAc \
    "SELECT pg_drop_replication_slot('replica1') FROM pg_replication_slots WHERE slot_name = 'replica1'" >/dev/null
  pg_basebackup -h postgres -U "$REPLICATION_USER" -D "$PGDATA" -X stream -R -C -S replica1 -c fast
  chmod 700 "$PGDATA"
fi
exec postgres "$@"
