"""Integration tests against a real PostGIS. Run `docker compose up -d postgis` and set
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/minimaps (CI does this)."""
import os

import pytest

import db_load

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL not set")

FEATURES = [
    {"type": "Feature", "properties": {"name": "Brandenburger Tor"}, "geometry": {"type": "Point", "coordinates": [13.3777, 52.5163]}},
    {"type": "Feature", "properties": {"name": "Fernsehturm"}, "geometry": {"type": "Point", "coordinates": [13.4094, 52.5208, 368]}},
    {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[13.37, 52.51], [13.40, 52.52]]}},
]


@pytest.fixture
def conn():
    import psycopg

    with psycopg.connect(DATABASE_URL) as connection:
        db_load.apply_schema(connection)
        connection.execute("DELETE FROM tileset_versions WHERE tileset_id = 'test-berlin'")
        connection.commit()
        yield connection


def count(conn, version):
    return conn.execute(
        "SELECT count(*) FROM features WHERE tileset_id = 'test-berlin' AND version = %s", (version,)
    ).fetchone()[0]


def test_schema_can_be_applied_repeatedly(conn):
    db_load.apply_schema(conn)
    db_load.apply_schema(conn)


def test_load_is_idempotent_per_version(conn):
    assert db_load.load_version(conn, "test-berlin", 1, FEATURES) == 3
    db_load.load_version(conn, "test-berlin", 1, FEATURES)
    assert count(conn, 1) == 3


def test_versions_are_kept_apart(conn):
    db_load.load_version(conn, "test-berlin", 1, FEATURES)
    db_load.load_version(conn, "test-berlin", 2, FEATURES[:1])
    assert (count(conn, 1), count(conn, 2)) == (3, 1)


def test_bbox_query_uses_the_spatial_index_shape(conn):
    db_load.load_version(conn, "test-berlin", 1, FEATURES)
    rows = conn.execute(
        """SELECT properties->>'name' FROM features
           WHERE tileset_id = 'test-berlin' AND version = 1
             AND ST_Intersects(geom, ST_MakeEnvelope(13.40, 52.515, 13.42, 52.53, 4326))
           ORDER BY feature_index"""
    ).fetchall()
    # The Fernsehturm point and the line both reach into this box; the Brandenburger Tor does not.
    assert [r[0] for r in rows] == ["Fernsehturm", None]


def test_3d_coordinates_are_stored_as_2d(conn):
    db_load.load_version(conn, "test-berlin", 1, FEATURES)
    dims = conn.execute(
        "SELECT ST_NDims(geom) FROM features WHERE tileset_id = 'test-berlin' AND feature_index = 1"
    ).fetchone()[0]
    assert dims == 2
