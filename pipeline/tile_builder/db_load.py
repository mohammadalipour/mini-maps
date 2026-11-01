"""Load a tileset version's features into PostGIS, for the API's bbox queries (docs/adr/0006)."""
import json
from pathlib import Path

SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
# Advisory lock key, so concurrent builds never run CREATE EXTENSION / CREATE TABLE at the same time.
SCHEMA_LOCK = 0x6D696E69

INSERT_FEATURE = """
    INSERT INTO features (tileset_id, version, feature_index, properties, geom)
    VALUES (%s, %s, %s, %s, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)))
"""


def connect_from_env(env):
    """Returns a connection, or None when no database is configured (loading is then skipped)."""
    if not env.get("DB_HOST"):
        return None
    import psycopg

    return psycopg.connect(
        host=env["DB_HOST"],
        port=int(env.get("DB_PORT", "5432")),
        dbname=env["DB_NAME"],
        user=env["DB_USER"],
        password=env["DB_PASSWORD"],
        sslmode=env.get("DB_SSLMODE", "verify-full"),
        sslrootcert=env.get("DB_SSLROOTCERT", "/app/rds-ca.pem"),
        connect_timeout=10,
    )


def apply_schema(conn) -> None:
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_LOCK,))
        conn.execute(SCHEMA)


def load_version(conn, tileset_id: str, version: int, features: list[dict]) -> int:
    from psycopg.types.json import Jsonb

    rows = [
        (tileset_id, version, index, Jsonb(feature.get("properties") or {}), json.dumps(feature["geometry"]))
        for index, feature in enumerate(features)
    ]
    with conn.transaction():
        # A retried build replaces the same version instead of duplicating it (rows cascade).
        conn.execute("DELETE FROM tileset_versions WHERE tileset_id = %s AND version = %s", (tileset_id, version))
        conn.execute(
            "INSERT INTO tileset_versions (tileset_id, version, feature_count) VALUES (%s, %s, %s)",
            (tileset_id, version, len(rows)),
        )
        with conn.cursor() as cur:
            cur.executemany(INSERT_FEATURE, rows)
    return len(rows)
