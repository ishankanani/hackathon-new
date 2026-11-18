"""Load the repository's sample journeys into the shared database.

A new, empty database (for example a fresh Supabase or Neon project) starts with
no saved journeys on Vercel. This script copies the sample data that ships with
the repository into it, in exactly the format the app reads:

    backend/store/shipments.json   -> one "ship/<id>" row per journey
    backend/store/operations.json  -> the "operations.json" row
    backend/store/demo/<id>/operations.json -> "demo/<id>/operations.json" rows

It never overwrites or deletes anything: a row that already exists is left
alone and reported as kept. Road lines are simplified to within 5 m on the way
in, so the stored journeys are about four times smaller.

The DACHSER CSV files in data/raw are not copied: every server reads them from
the repository at start-up, so they never need to be in the database.

Usage (from the repository root):

    DATABASE_URL=postgresql://... python scripts/seed_database.py           # dry run
    DATABASE_URL=postgresql://... python scripts/seed_database.py --apply   # write
"""
import argparse
import json
import os
import sys
import time
import zlib
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import persistence  # noqa: E402  (same encoding and table as the app)
from app.geometry import simplify_all  # noqa: E402


def target_label(url):
    """Where the data is going, without the password."""
    parts = urlparse(url)
    return f"{parts.hostname}:{parts.port or 5432}{parts.path}"


def main():
    parser = argparse.ArgumentParser(description="Copy the sample journeys into the shared database.")
    parser.add_argument("--apply", action="store_true", help="write the rows (default is a dry run)")
    parser.add_argument("--store", default=str(ROOT / "backend" / "store"), help="folder holding shipments.json and operations.json")
    args = parser.parse_args()

    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        sys.exit("DATABASE_URL is not set. Set it to the database you want to fill, then run again.")

    store = Path(args.store)
    ships = json.loads((store / "shipments.json").read_text(encoding="utf-8"))
    if isinstance(ships, list):
        ships = {ship["id"]: ship for ship in ships}
    operations = json.loads((store / "operations.json").read_text(encoding="utf-8"))

    before = sum(len(json.dumps(ship, separators=(",", ":"), default=str)) for ship in ships.values())
    simplify_all(ships)
    after = sum(len(json.dumps(ship, separators=(",", ":"), default=str)) for ship in ships.values())

    rows = [(persistence.SHIP_PREFIX + sid,
             zlib.compress(json.dumps(ship, separators=(",", ":"), default=str).encode(), 1))
            for sid, ship in ships.items()]
    rows.append(("operations.json", persistence.encode(operations)))
    # Sample judge-demo journeys refer to their own demo session.
    for path in sorted(store.glob("demo/*/operations.json")):
        rows.append((path.relative_to(store).as_posix(), persistence.encode(json.loads(path.read_text(encoding="utf-8")))))
    # Tells the app the journeys are already stored one row each.
    rows.append((persistence.SHIPS_MIGRATED, persistence.encode({"at": time.time(), "seeded": True})))

    print(f"Target database : {target_label(url)}")
    print(f"Sample journeys : {len(ships)}  (road lines simplified: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB)")
    print(f"Rows to insert  : {len(rows)}  ({sum(len(payload) for _, payload in rows) / 1e6:.2f} MB stored)")

    import psycopg
    with psycopg.connect(url, connect_timeout=15, prepare_threshold=None) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS dachser_state (name text PRIMARY KEY, payload bytea NOT NULL, "
                           "version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())")
        existing = {name for (name,) in connection.execute(
            "SELECT name FROM dachser_state WHERE name = ANY(%s)", ([name for name, _ in rows],)).fetchall()}
        missing = [(name, payload) for name, payload in rows if name not in existing]
        print(f"Already present : {len(existing)}  (kept unchanged)")
        print(f"New             : {len(missing)}")
        if not args.apply:
            connection.rollback()
            print("\nDry run - nothing was written. Run again with --apply to insert the new rows.")
            return
        for name, payload in missing:
            connection.execute("INSERT INTO dachser_state(name, payload) VALUES (%s, %s) ON CONFLICT (name) DO NOTHING",
                               (name, payload))
        connection.commit()
    print(f"\nInserted {len(missing)} rows. Open the app: the journeys appear in the control room.")


if __name__ == "__main__":
    main()
