import json

import pytest

from common import InvalidInputError
from fakes import FakeS3
from validate import tileset_id_from_key, validate, version_from_time

POINT = {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [13.4, 52.5]}}
LINE = {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[13.3, 52.4], [13.5, 52.6]]}}


def run(data, key="uploads/berlin.geojson"):
    body = data if isinstance(data, bytes) else json.dumps(data).encode()
    s3 = FakeS3({("raw", key): body})
    return validate({"bucket": "raw", "key": key, "time": "2026-11-01T18:30:05Z"}, s3)


def test_returns_tileset_version_and_bounds():
    result = run({"type": "FeatureCollection", "features": [POINT, LINE]})
    assert result == {
        "tilesetId": "berlin",
        "version": 20261101183005,
        "sourceBucket": "raw",
        "sourceKey": "uploads/berlin.geojson",
        "featureCount": 2,
        "bounds": [13.3, 52.4, 13.5, 52.6],
    }


def test_version_is_stable_for_the_same_event_and_grows_over_time():
    assert version_from_time("2026-11-01T18:30:05Z") == version_from_time("2026-11-01T18:30:05Z")
    assert version_from_time("2026-11-01T18:30:06Z") > version_from_time("2026-11-01T18:30:05Z")


@pytest.mark.parametrize(
    "key",
    ["uploads/Berlin.geojson", "uploads/a/b.geojson", "other/berlin.geojson", "uploads/berlin.json", "uploads/-x.geojson"],
)
def test_rejects_bad_keys(key):
    with pytest.raises(InvalidInputError):
        tileset_id_from_key(key)


@pytest.mark.parametrize(
    "data, message",
    [
        (b"{not json", "not valid JSON"),
        ({"type": "Feature"}, "FeatureCollection"),
        ({"type": "FeatureCollection", "features": []}, "no features"),
        ({"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": None}]}, "geometry"),
        (
            {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [200, 10]}}]},
            "out of range",
        ),
        (
            {"type": "FeatureCollection", "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": "x"}}]},
            "invalid coordinates",
        ),
    ],
)
def test_rejects_bad_geojson(data, message):
    with pytest.raises(InvalidInputError, match=message):
        run(data)


def test_rejects_files_over_the_size_limit(monkeypatch):
    monkeypatch.setattr("validate.MAX_SOURCE_BYTES", 10)
    with pytest.raises(InvalidInputError, match="limit"):
        run({"type": "FeatureCollection", "features": [POINT]})
