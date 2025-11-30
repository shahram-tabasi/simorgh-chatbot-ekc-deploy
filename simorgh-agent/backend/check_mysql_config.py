#!/usr/bin/env python3
"""
Check Current MySQL Configuration
==================================
This script shows exactly what MySQL connection parameters are being used.
"""

import os
import sys
sys.path.insert(0, os.path.dirname(__file__))

from services.tpms_auth_service import TPMSAuthService


def main():
    print("=" * 70)
    print("  CURRENT MYSQL CONFIGURATION")
    print("=" * 70)

    service = TPMSAuthService()

    print("\n📋 Connection Parameters:")
    print(f"   Host:     {service.host}")
    print(f"   Port:     {service.port}")
    print(f"   Database: {service.database}")
    print(f"   User:     {service.user}")
    print(f"   Password: {'*' * len(service.password) if service.password else '(empty)'}")
    print(f"   Enabled:  {service.enabled}")

    print("\n📋 Environment Variables:")
    print(f"   MYSQL_HOST:     {os.getenv('MYSQL_HOST', '(not set)')}")
    print(f"   MYSQL_PORT:     {os.getenv('MYSQL_PORT', '(not set)')}")
    print(f"   MYSQL_DATABASE: {os.getenv('MYSQL_DATABASE', '(not set)')}")
    print(f"   MYSQL_USER:     {os.getenv('MYSQL_USER', '(not set)')}")
    print(f"   MYSQL_PASSWORD: {'***' if os.getenv('MYSQL_PASSWORD') else '(not set)'}")

    print("\n" + "=" * 70)
    print("  COMPARE WITH YOUR HEIDISQL SETTINGS")
    print("=" * 70)
    print("\nIn HeidiSQL, go to Session Manager and check:")
    print("   1. Network type: MySQL (TCP/IP)")
    print("   2. Hostname / IP: _______________")
    print("   3. User: _______________")
    print("   4. Port: _______________")
    print("   5. Database: _______________")
    print("\nIf any values are different, update the environment variables!")

    # Test connection
    print("\n" + "=" * 70)
    print("  TESTING CONNECTION")
    print("=" * 70)

    try:
        health = service.health_check()
        print(f"\n✅ Database: {health.get('status', 'unknown')}")

        if health.get('status') == 'healthy':
            print(f"   MySQL Version: {health.get('version', 'unknown')}")

            # Try to query technical_user
            print("\n📋 Testing table access...")
            with service.get_connection() as conn:
                cursor = conn.cursor()

                # Test 1: List all tables in TPMS
                try:
                    cursor.execute("SHOW TABLES")
                    tables = cursor.fetchall()
                    print(f"\n✅ Can list tables in TPMS database:")
                    for table in tables[:10]:  # Show first 10
                        print(f"      - {list(table.values())[0]}")
                    if len(tables) > 10:
                        print(f"      ... and {len(tables) - 10} more")
                except Exception as e:
                    print(f"\n❌ Cannot list tables: {e}")

                # Test 2: Query technical_user
                try:
                    cursor.execute("SELECT COUNT(*) as count FROM technical_user")
                    result = cursor.fetchone()
                    print(f"\n✅ Can read technical_user table:")
                    print(f"      Total users: {result['count']}")
                except Exception as e:
                    print(f"\n❌ Cannot read technical_user: {e}")
                    print("\n   This is the problem! The user credentials work")
                    print("   for connection but don't have SELECT permission")
                    print("   on technical_user table.")

                # Test 3: Show grants
                try:
                    cursor.execute(f"SHOW GRANTS FOR '{service.user}'@'%'")
                    grants = cursor.fetchall()
                    print(f"\n📋 User permissions:")
                    for grant in grants:
                        print(f"      {list(grant.values())[0]}")
                except Exception as e:
                    print(f"\n⚠️  Cannot show grants: {e}")

        else:
            print(f"   Error: {health.get('error', 'unknown')}")

    except Exception as e:
        print(f"\n❌ Connection failed: {e}")


if __name__ == "__main__":
    main()
