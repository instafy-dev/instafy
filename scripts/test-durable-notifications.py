#!/usr/bin/env python3
"""Real PostgreSQL migration + outbox simulation in an isolated, socket-only cluster.

Requires local PostgreSQL binaries (PG_BIN may name their directory). Does not read
DATABASE_URL, environment files, credentials, or connect to any existing database.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import argparse
import os
import socket
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'supabase/migrations/20260906120000_durable_notifications.sql'
PG = Path(os.environ.get('PG_BIN', Path(shutil.which('initdb') or '/opt/homebrew/opt/postgresql@17/bin/initdb').parent))


def run(command, *, input=None):
    # libpq's PGHOSTADDR/PGSERVICE can override a supplied hostname. Strip every
    # PG* override so inherited shell configuration cannot redirect this fixture.
    local_env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    result = subprocess.run(command, input=input, capture_output=True, text=True, timeout=60, env=local_env)
    if result.returncode:
        raise RuntimeError(result.stderr[-6000:])
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controller-test', action='append', default=[], metavar='PATTERN',
                        help='also run selected Rust tests on a clean migrated DB; opens a temporary loopback-only port')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='instafy-notification-pg-', dir='/tmp') as directory:
        directory = Path(directory)
        data = directory / 'data'
        sock = directory / 'socket'
        sock.mkdir()
        run([str(PG/'initdb'), '-D', str(data), '-U', 'postgres', '-A', 'trust', '--no-locale'])
        # Empty listen_addresses forbids TCP. Every psql invocation names this
        # freshly-created private socket path and database explicitly.
        port = 5432
        addresses = ''
        if args.controller_test:
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            addresses = '127.0.0.1'
        run([str(PG/'pg_ctl'), '-D', str(data), '-l', str(directory/'postgres.log'), '-o',
             f"-k {sock} -p {port} -c listen_addresses='{addresses}'", '-w', 'start'])
        try:
            command = [str(PG/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', str(sock), '-p', str(port), '-U', 'postgres', '-d', 'postgres']
            def sql(value):
                return run(command, input=value)
            sql("""
                create role anon; create role authenticated; create role service_role;
                create schema auth;
                create table auth.users(
                  id uuid primary key, email text, instance_id uuid, aud text, role text,
                  encrypted_password text, email_confirmed_at timestamptz,
                  last_sign_in_at timestamptz, confirmation_token text, recovery_token text,
                  email_change_token_new text, email_change text,
                  raw_app_meta_data jsonb not null default '{}',
                  raw_user_meta_data jsonb not null default '{}', is_super_admin boolean,
                  created_at timestamptz, updated_at timestamptz);
                create function auth.uid() returns uuid language sql stable as
                  'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
            """)
            files = sorted((ROOT/'supabase/migrations').glob('*.sql'))
            for migration in files:
                sql('begin;\n' + migration.read_text() + '\ncommit;')
            print(f'PASS: all {len(files)} public migrations replayed into empty PostgreSQL', flush=True)
            if args.controller_test:
                # Snapshot the clean migrated schema before SQL simulation fixtures.
                sql('create database notification_controller_tests template postgres;')
            sql((ROOT/'supabase/tests/durable_notifications.sql').read_text())
            print('PASS: support lifecycle, transactional rollback, preferences, account isolation, privacy, all producers, quiet runs, monotonic state, revocation')
            before = sql('select count(*) from notification_events;')
            sql('begin;\n' + MIGRATION.read_text() + '\ncommit;')
            assert before == sql('select count(*) from notification_events;'), 'migration replay emitted historical events'
            print('PASS: additive migration replay preserves state and emits no historical events')
            # Distinct sessions contend on the same producer key. Exactly one
            # event, recipient, and endpoint job may exist after concurrent commit.
            key = 'parallel:' + str(uuid.uuid4())
            produce = f"""select notification_emit('support.reply',
              '00000000-0000-0000-0000-000000000010',null,null,'{key}',now(),
              array['00000000-0000-0000-0000-000000000001'::uuid]);"""
            with ThreadPoolExecutor(max_workers=8) as pool:
                event_ids = list(pool.map(sql, [produce] * 16))
            assert len(set(event_ids)) == 1
            assert sql(f"select count(*) from notification_events where producer_key='{key}';") == '1'
            assert sql(f"select count(*) from notification_delivery_jobs where event_id='{event_ids[0]}';") == '1'
            print('PASS: 16 concurrent producers deduplicate event, recipient, and outbox')
            count_before = int(sql("select count(*) from notification_events where event_name='support.resolved';"))
            sql("update bug_reports set status='open' where id='00000000-0000-0000-0000-000000000010';")
            resolve = "update bug_reports set status='resolved',resolved_at=now() where id='00000000-0000-0000-0000-000000000010';"
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(sql, [resolve] * 16))
            assert int(sql("select count(*) from notification_events where event_name='support.resolved';")) == count_before + 1
            print('PASS: 16 concurrent support resolutions produce exactly one transition event')
            sql("update notification_delivery_jobs set status='cancelled',lease_token=null,lease_until=null;")
            # Four simultaneous claimers each ask for four of twelve due jobs.
            for index in range(12):
                sql(produce.replace(key, key + str(index)))
            claim = 'begin; select id from notification_lease_jobs(4,60); select pg_sleep(0.1); commit;'
            with ThreadPoolExecutor(max_workers=4) as pool:
                batches = list(pool.map(sql, [claim] * 4))
            job_ids = [item for batch in batches for item in batch.splitlines() if item]
            assert len(job_ids) == 12 and len(set(job_ids)) == 12, batches
            print('PASS: concurrent SKIP LOCKED claims never share a lease')
            job = job_ids[0]
            old_token = sql(f"select lease_token from notification_delivery_jobs where id='{job}';")
            sql(f"update notification_delivery_jobs set lease_until=now()-interval '1 second' where id='{job}';")
            assert sql(f"select id from notification_lease_jobs(1,60);") == job
            assert sql(f"select count(*) from notification_delivery_jobs where id='{job}' and lease_token='{old_token}';") == '0'
            assert sql(f"select count(*) from notification_delivery_attempts where job_id='{job}' and status='lease_expired';") == '1'
            for _ in range(7):
                sql(f"update notification_delivery_jobs set lease_until=now()-interval '1 second' where id='{job}' and status='leased'; select count(*) from notification_lease_jobs(1,60);")
            assert sql(f"select status||':'||attempt_count from notification_delivery_jobs where id='{job}';") == 'failed:8'
            print('PASS: crash recovery fences stale workers and terminates at eight attempts')
            for pattern in args.controller_test:
                test_env = dict(os.environ, TEST_DATABASE_URL=f'postgresql://postgres@127.0.0.1:{port}/notification_controller_tests')
                subprocess.run(['cargo', 'test', '--manifest-path',
                                str(ROOT/'packages/runtime-controller/Cargo.toml'),
                                pattern, '--', '--test-threads=1'], cwd=ROOT,
                               env=test_env, check=True, timeout=1800)
            print('Notification PostgreSQL simulation complete; temporary cluster will be removed.')
        finally:
            run([str(PG/'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'])


if __name__ == '__main__':
    main()
