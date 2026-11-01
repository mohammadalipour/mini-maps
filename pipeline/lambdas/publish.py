"""Step 3: point the tileset at the newly built version by writing manifest.json.

Runs only after all tiles exist, so clients never see a half-built version (docs/adr/0002).
Uses an S3 conditional write so two pipeline runs cannot overwrite each other, and never
replaces a newer version with an older one.
"""
import json
import os

from botocore.exceptions import ClientError

from common import manifest_key, s3_client, tile_prefix


class MissingTilesError(Exception):
    """The build step finished without writing tiles."""


class ConcurrentPublishError(Exception):
    """The manifest changed between read and write. Step Functions retries this."""


def handler(event, _context):
    return publish(event, s3_client(), os.environ["TILES_BUCKET"])


def publish(event: dict, s3, bucket: str) -> dict:
    tileset_id, version = event["tilesetId"], event["version"]

    metadata, _ = read_json(s3, bucket, f"{tile_prefix(tileset_id, version)}/metadata.json")
    if metadata is None:
        raise MissingTilesError(f"no metadata.json for {tileset_id} v{version}")

    current, etag = read_json(s3, bucket, manifest_key(tileset_id))
    if current is not None and current["version"] >= version:
        return {"status": "superseded", "tilesetId": tileset_id, "version": version, "currentVersion": current["version"]}

    condition = {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}
    try:
        s3.put_object(
            Bucket=bucket,
            Key=manifest_key(tileset_id),
            Body=json.dumps(build_manifest(tileset_id, version, metadata)).encode(),
            ContentType="application/json",
            **condition,
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") in ("PreconditionFailed", "ConditionalRequestConflict"):
            raise ConcurrentPublishError(f"manifest for {tileset_id} changed during publish") from err
        raise

    return {"status": "published", "tilesetId": tileset_id, "version": version}


def build_manifest(tileset_id: str, version: int, metadata: dict) -> dict:
    """Turn tippecanoe's metadata.json into the manifest the API serves as TileJSON."""
    vector_layers = metadata.get("vector_layers")
    if vector_layers is None:
        vector_layers = json.loads(metadata.get("json", "{}")).get("vector_layers", [])

    manifest = {
        "id": tileset_id,
        "name": metadata.get("name") or tileset_id,
        "version": version,
        "minzoom": int(metadata["minzoom"]),
        "maxzoom": int(metadata["maxzoom"]),
        "bounds": [float(v) for v in str(metadata["bounds"]).split(",")],
        "center": [float(v) for v in str(metadata["center"]).split(",")],
        "vector_layers": vector_layers,
    }
    if metadata.get("attribution"):
        manifest["attribution"] = metadata["attribution"]
    return manifest


def read_json(s3, bucket: str, key: str):
    """Returns (parsed JSON, ETag), or (None, None) when the object does not exist."""
    try:
        res = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "NoSuchKey":
            return None, None
        raise
    return json.loads(res["Body"].read()), res["ETag"]
