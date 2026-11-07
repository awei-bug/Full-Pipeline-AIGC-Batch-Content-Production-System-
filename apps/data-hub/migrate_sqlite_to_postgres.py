"""Copy a stopped data-hub SQLite database to an empty PostgreSQL hub schema.

HUB_DATABASE_URL supplies the target. The target hub tables must be empty; no
existing rows are overwritten. Keep the source and verify before switching.
"""
import argparse
import sqlite3
from pathlib import Path

import psycopg
from psycopg import sql

import app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, help='Existing SQLite hub database')
    args = parser.parse_args()
    source_path = Path(args.source).resolve(strict=True)
    if not app.HUB_DATABASE_URL:
        raise RuntimeError('HUB_DATABASE_URL must identify the PostgreSQL target')

    app.init_db()
    source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    try:
        source.execute('BEGIN')
        with psycopg.connect(app.HUB_DATABASE_URL) as target:
            with target.transaction():
                target.execute('SELECT pg_advisory_xact_lock(1481259851)')
                for table in ('hub_products', 'hub_sync_log'):
                    if target.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone()[0]:
                        raise RuntimeError(f'Target {table} is not empty; refusing to overwrite')
                for table in ('hub_products', 'hub_sync_log'):
                    columns = [row[1] for row in source.execute(f'PRAGMA table_info({table})')]
                    if not columns or 'id' not in columns:
                        raise RuntimeError(f'Missing expected source table: {table}')
                    statement = sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(
                        sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, columns)),
                        sql.SQL(',').join(sql.Placeholder() for _ in columns))
                    rows = source.execute(f'SELECT * FROM {table} ORDER BY id').fetchall()
                    with target.cursor() as cursor:
                        cursor.executemany(statement, [tuple(row[c] for c in columns) for row in rows])
                    actual = target.execute(sql.SQL('SELECT {} FROM {} ORDER BY id').format(
                        sql.SQL(',').join(map(sql.Identifier, columns)), sql.Identifier(table))).fetchall()
                    if [tuple(row[c] for c in columns) for row in rows] != actual:
                        raise RuntimeError(f'Copied data differs for {table}; transaction rolled back')
                    target.execute(sql.SQL("SELECT setval(pg_get_serial_sequence({}, 'id'), "
                                           "COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM {}").format(
                        sql.Literal(table), sql.Identifier(table)))
                    print(f'{table}: {len(rows)} records verified')
    finally:
        source.close()


if __name__ == '__main__':
    main()
