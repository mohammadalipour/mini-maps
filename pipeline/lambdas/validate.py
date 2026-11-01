"""Step 1: check an uploaded GeoJSON file and decide which version it becomes.

Input (from EventBridge):  {"bucket": ..., "key": "uploads/<tileset-id>.geojson", "time": "<ISO-8601>"}
Output: {"tilesetId", "version", "sourceBucket", "sourceKey", "featureCount", "bounds"}
"""
import json
import os
from datetime import datetime
from pathlib import PurePosixPath

from common import TILESET_ID, InvalidInputError, s3_client

# Lambda parses the whole file in memory; larger inputs would be validated inside the ECS task.
MAX_SOURCE_BYTES = int(os.environ.get("MAX_SOURCE_BYTES", 50 * 1024 * 1024))

GEOMETRY_TYPES = {"Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}


def handler(event, _context):
    return validate(event, s3_client())


def validate(event: dict, s3) -> dict:
    bucket, key = event["bucket"], event["key"]
    tileset_id = tileset_id_from_key(key)

    size = s3.head_object(Bucket=bucket, Key=key)["ContentLength"]
    if size > MAX_SOURCE_BYTES:
        raise InvalidInputError(f"{key} is {size} bytes, limit is {MAX_SOURCE_BYTES}")

    try:
        data = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
    except ValueError as err:
        raise InvalidInputError(f"{key} is not valid JSON: {err}") from None

    stats = inspect_feature_collection(data)
    return {
        "tilesetId": tileset_id,
        "version": version_from_time(event["time"]),
        "sourceBucket": bucket,
        "sourceKey": key,
        **stats,
    }


def tileset_id_from_key(key: str) -> str:
    path = PurePosixPath(key)
    if path.parent != PurePosixPath("uploads") or path.suffix != ".geojson":
        raise InvalidInputError(f"expected uploads/<tileset-id>.geojson, got {key}")
    if not TILESET_ID.match(path.stem):
        raise InvalidInputError(f"invalid tileset id {path.stem!r}: use lowercase letters, digits and dashes")
    return path.stem


def version_from_time(iso_time: str) -> int:
    """Upload time as YYYYMMDDHHMMSS: grows with each upload, and stays the same when a step is retried."""
    return int(datetime.fromisoformat(iso_time).strftime("%Y%m%d%H%M%S"))


def inspect_feature_collection(data) -> dict:
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise InvalidInputError("expected a GeoJSON FeatureCollection")
    features = data.get("features")
    if not isinstance(features, list) or not features:
        raise InvalidInputError("FeatureCollection has no features")

    west, south, east, north = 180.0, 90.0, -180.0, -90.0
    for index, feature in enumerate(features):
        geometry = feature.get("geometry") if isinstance(feature, dict) else None
        if not isinstance(geometry, dict) or geometry.get("type") not in GEOMETRY_TYPES:
            raise InvalidInputError(f"feature {index}: missing or unsupported geometry")
        for lon, lat in positions(geometry.get("coordinates"), index):
            west, south, east, north = min(west, lon), min(south, lat), max(east, lon), max(north, lat)

    return {"featureCount": len(features), "bounds": [west, south, east, north]}


def positions(coords, index: int):
    if isinstance(coords, list) and len(coords) >= 2 and all(isinstance(c, (int, float)) for c in coords[:2]):
        lon, lat = coords[0], coords[1]
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise InvalidInputError(f"feature {index}: coordinate {lon},{lat} is out of range")
        yield lon, lat
    elif isinstance(coords, list):
        for child in coords:
            yield from positions(child, index)
    else:
        raise InvalidInputError(f"feature {index}: invalid coordinates")
