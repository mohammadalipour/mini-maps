import json

import pytest

from fakes import FakeS3
from publish import ConcurrentPublishError, MissingTilesError, build_manifest, publish

BUCKET = "tiles"
MANIFEST = "tilesets/berlin/manifest.json"

# Shape of tippecanoe's directory-output metadata.json
TIPPECANOE_METADATA = {
    "name": "berlin",
    "minzoom": "0",
    "maxzoom": "14",
    "bounds": "13.3,52.4,13.5,52.6",
    "center": "13.4,52.5,14",
    "json": json.dumps({"vector_layers": [{"id": "landmarks", "fields": {"name": "String"}}]}),
}


def store_with_build(version: int) -> FakeS3:
    s3 = FakeS3()
    s3.put_json(BUCKET, f"tilesets/berlin/v{version}/metadata.json", TIPPECANOE_METADATA)
    return s3


def manifest(s3: FakeS3) -> dict:
    return json.loads(s3.objects[(BUCKET, MANIFEST)])


def test_first_publish_creates_the_manifest():
    s3 = store_with_build(5)
    assert publish({"tilesetId": "berlin", "version": 5}, s3, BUCKET)["status"] == "published"
    assert manifest(s3)["version"] == 5
    assert manifest(s3)["vector_layers"] == [{"id": "landmarks", "fields": {"name": "String"}}]


def test_newer_version_replaces_the_manifest():
    s3 = store_with_build(6)
    s3.put_json(BUCKET, MANIFEST, {"id": "berlin", "version": 5, "vector_layers": []})
    publish({"tilesetId": "berlin", "version": 6}, s3, BUCKET)
    assert manifest(s3)["version"] == 6


def test_older_version_never_rolls_back_a_newer_one():
    s3 = store_with_build(4)
    s3.put_json(BUCKET, MANIFEST, {"id": "berlin", "version": 5, "vector_layers": []})
    result = publish({"tilesetId": "berlin", "version": 4}, s3, BUCKET)
    assert result == {"status": "superseded", "tilesetId": "berlin", "version": 4, "currentVersion": 5}
    assert manifest(s3)["version"] == 5


def test_concurrent_change_raises_a_retryable_error():
    s3 = store_with_build(6)
    s3.put_json(BUCKET, MANIFEST, {"id": "berlin", "version": 5, "vector_layers": []})

    original_get = s3.get_object

    def get_then_someone_else_writes(Bucket, Key):
        res = original_get(Bucket, Key)
        if Key == MANIFEST:
            s3.put_json(BUCKET, MANIFEST, {"id": "berlin", "version": 7, "vector_layers": []})
        return res

    s3.get_object = get_then_someone_else_writes
    with pytest.raises(ConcurrentPublishError):
        publish({"tilesetId": "berlin", "version": 6}, s3, BUCKET)
    assert manifest(s3)["version"] == 7


def test_missing_build_output_fails():
    with pytest.raises(MissingTilesError):
        publish({"tilesetId": "berlin", "version": 1}, FakeS3(), BUCKET)


def test_build_manifest_matches_the_api_shape():
    assert build_manifest("berlin", 3, TIPPECANOE_METADATA) == {
        "id": "berlin",
        "name": "berlin",
        "version": 3,
        "minzoom": 0,
        "maxzoom": 14,
        "bounds": [13.3, 52.4, 13.5, 52.6],
        "center": [13.4, 52.5, 14.0],
        "vector_layers": [{"id": "landmarks", "fields": {"name": "String"}}],
    }
