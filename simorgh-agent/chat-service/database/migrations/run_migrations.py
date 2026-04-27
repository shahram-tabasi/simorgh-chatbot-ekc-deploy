#!/usr/bin/env python3
"""
Database Migration Runner for Simorgh Authentication

Usage:
    python run_migrations.py [--dry-run] [--rollback]

Options:
    --dry-run   Show SQL that would be executed without running it
    --rollback  Rollback the last migration

Environment Variables:
    POSTGRES_AUTH_HOST      PostgreSQL host (default: localhost)
    POSTGRES_AUTH_PORT      PostgreSQL port (default: 5432)
    POSTGRES_AUTH_DATABASE  Database name (default: simorgh_auth)
    POSTGRES_AUTH_USER      Username (default: simorgh)
    POSTGRES_AUTH_PASSWORD  Password (required)
"""

import os
import sys
import glob
import psycopg2
from psycopg2 import sql
from datetime import datetime
from pathlib import Path


def get_connection():
    """Create database connection from environment variables."""
    return psycopg2.connect(
        host=os.getenv('POSTGRES_AUTH_HOST', 'localhost'),
        port=int(os.getenv('POSTGRES_AUTH_PORT', 5432)),
        database=os.getenv('POSTGRES_AUTH_DATABASE', 'simorgh_auth'),
        user=os.getenv('POSTGRES_AUTH_USER', 'simorgh'),
        password=os.getenv('POSTGRES_AUTH_PASSWORD', '')
    )


def create_migrations_table(conn):
    """Create migrations tracking table if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                checksum VARCHAR(64)
            )
        """)
        conn.commit()


def get_applied_migrations(conn):
    """Get list of already applied migrations."""
    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations ORDER BY id")
        return {row[0] for row in cur.fetchall()}


def get_migration_files():
    """Get all SQL migration files sorted by name."""
    migrations_dir = Path(__file__).parent
    files = glob.glob(str(migrations_dir / "*.sql"))
    return sorted(files)


def run_migration(conn, filepath, dry_run=False):
    """Run a single migration file."""
    filename = os.path.basename(filepath)

    with open(filepath, 'r') as f:
        migration_sql = f.read()

    if dry_run:
        print(f"[DRY RUN] Would execute migration: {filename}")
        print("-" * 60)
        print(migration_sql[:500] + "..." if len(migration_sql) > 500 else migration_sql)
        print("-" * 60)
        return

    print(f"Running migration: {filename}")

    with conn.cursor() as cur:
        cur.execute(migration_sql)
        cur.execute(
            "INSERT INTO schema_migrations (filename) VALUES (%s)",
            (filename,)
        )

    conn.commit()
    print(f"  ✓ Successfully applied: {filename}")


def rollback_last(conn, dry_run=False):
    """Rollback the last applied migration."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT filename FROM schema_migrations
            ORDER BY id DESC LIMIT 1
        """)
        result = cur.fetchone()

        if not result:
            print("No migrations to rollback")
            return

        filename = result[0]
        base_name = filename.replace('.sql', '')
        rollback_file = Path(__file__).parent / f"{base_name}_rollback.sql"

        if not rollback_file.exists():
            print(f"Rollback file not found: {rollback_file}")
            print("Manual rollback required")
            return

        if dry_run:
            print(f"[DRY RUN] Would rollback: {filename}")
            return

        with open(rollback_file, 'r') as f:
            rollback_sql = f.read()

        cur.execute(rollback_sql)
        cur.execute(
            "DELETE FROM schema_migrations WHERE filename = %s",
            (filename,)
        )

        conn.commit()
        print(f"  ✓ Rolled back: {filename}")


def main():
    dry_run = '--dry-run' in sys.argv
    rollback = '--rollback' in sys.argv

    if not os.getenv('POSTGRES_AUTH_PASSWORD'):
        print("Error: POSTGRES_AUTH_PASSWORD environment variable is required")
        sys.exit(1)

    try:
        conn = get_connection()
        print(f"Connected to PostgreSQL: {os.getenv('POSTGRES_AUTH_HOST', 'localhost')}")

        create_migrations_table(conn)

        if rollback:
            rollback_last(conn, dry_run)
        else:
            applied = get_applied_migrations(conn)
            migrations = get_migration_files()
            pending = [m for m in migrations if os.path.basename(m) not in applied]

            if not pending:
                print("All migrations are up to date")
            else:
                print(f"Found {len(pending)} pending migration(s)")
                for migration in pending:
                    run_migration(conn, migration, dry_run)

        conn.close()
        print("\nMigration complete!")

    except psycopg2.Error as e:
        print(f"Database error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
