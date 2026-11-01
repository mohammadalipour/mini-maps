"""Shared by the pipeline Lambdas. Key layout matches services/api/src/tiles/tile-store.ts."""
import re

TILESET_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class InvalidInputError(Exception):
    """The uploaded data is unusable. Not retried by Step Functions."""


def tile_prefix(tileset_id: str, version: int) -> str:
    return f"tilesets/{tileset_id}/v{version}"


def manifest_key(tileset_id: str) -> str:
    return f"tilesets/{tileset_id}/manifest.json"


_s3 = None


def s3_client():
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client("s3")
    return _s3
