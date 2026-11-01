"""Step 2 (ECS Fargate task): GeoJSON in S3 -> vector tiles in S3, using tippecanoe.

Environment: SOURCE_BUCKET, SOURCE_KEY, TILES_BUCKET, TILESET_ID, VERSION, LAYER (optional).
Writes tilesets/<id>/v<version>/{z}/{x}/{y}.mvt and, last, .../metadata.json.
"""
import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

MVT_CONTENT_TYPE = "application/vnd.mapbox-vector-tile"
TILE_CACHE = "public, max-age=31536000, immutable"


def log(message: str, **fields) -> None:
    print(json.dumps({"msg": message, **fields}), flush=True)


def tippecanoe_command(source: Path, out_dir: Path, layer: str, name: str) -> list[str]:
    return [
        "tippecanoe",
        "--output-to-directory", str(out_dir),
        "--maximum-zoom=g",                  # let tippecanoe pick a max zoom that fits the data,
        "--smallest-maximum-zoom-guess=12",  # but never below street level for sparse data
        "--drop-densest-as-needed",          # keep tiles under the size limit
        "--extend-zooms-if-still-dropping",
        "--layer", layer,
        "--name", name,
        "--quiet",
        str(source),
    ]


def upload_plan(out_dir: Path, prefix: str):
    """Map tippecanoe's output files to S3 keys. Returns (tiles, metadata)."""
    tiles, metadata = [], None
    for path in sorted(out_dir.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(out_dir).as_posix()
        if relative == "metadata.json":
            metadata = (path, f"{prefix}/metadata.json", {"ContentType": "application/json"})
        elif relative.endswith(".pbf"):
            # tippecanoe gzips tiles; the API passes Content-Encoding through to clients.
            extra = {"ContentType": MVT_CONTENT_TYPE, "ContentEncoding": "gzip", "CacheControl": TILE_CACHE}
            tiles.append((path, f"{prefix}/{relative.removesuffix('.pbf')}.mvt", extra))
    if metadata is None:
        raise RuntimeError("tippecanoe wrote no metadata.json")
    return tiles, metadata


def main() -> None:
    import boto3

    env = os.environ
    tileset_id, version = env["TILESET_ID"], int(env["VERSION"])
    tiles_bucket = env["TILES_BUCKET"]
    work = Path("/tmp/work")
    source, out_dir = work / "source.geojson", work / "tiles"
    work.mkdir(parents=True, exist_ok=True)

    s3 = boto3.client("s3")
    started = time.monotonic()

    s3.download_file(env["SOURCE_BUCKET"], env["SOURCE_KEY"], str(source))
    subprocess.run(tippecanoe_command(source, out_dir, env.get("LAYER") or tileset_id, tileset_id), check=True)
    built = time.monotonic()

    tiles, metadata = upload_plan(out_dir, f"tilesets/{tileset_id}/v{version}")
    with ThreadPoolExecutor(max_workers=32) as pool:
        list(pool.map(lambda t: s3.upload_file(str(t[0]), tiles_bucket, t[1], ExtraArgs=t[2]), tiles))
    # metadata.json last: the publish step treats it as "all tiles are uploaded".
    s3.upload_file(str(metadata[0]), tiles_bucket, metadata[1], ExtraArgs=metadata[2])

    log(
        "tiles built",
        tileset=tileset_id,
        version=version,
        tiles=len(tiles),
        build_seconds=round(built - started, 1),
        upload_seconds=round(time.monotonic() - built, 1),
    )


if __name__ == "__main__":
    main()
