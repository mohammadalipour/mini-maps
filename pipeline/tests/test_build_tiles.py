from pathlib import Path

import pytest

from build_tiles import MVT_CONTENT_TYPE, tippecanoe_command, upload_plan


def write(path: Path, content: bytes = b"x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def test_upload_plan_maps_tiles_and_metadata(tmp_path):
    write(tmp_path / "0/0/0.pbf")
    write(tmp_path / "12/2200/1343.pbf")
    write(tmp_path / "metadata.json", b"{}")

    tiles, metadata = upload_plan(tmp_path, "tilesets/berlin/v7")

    assert [key for _, key, _ in tiles] == ["tilesets/berlin/v7/0/0/0.mvt", "tilesets/berlin/v7/12/2200/1343.mvt"]
    assert tiles[0][2] == {
        "ContentType": MVT_CONTENT_TYPE,
        "ContentEncoding": "gzip",
        "CacheControl": "public, max-age=31536000, immutable",
    }
    assert metadata[1] == "tilesets/berlin/v7/metadata.json"


def test_upload_plan_requires_metadata(tmp_path):
    write(tmp_path / "0/0/0.pbf")
    with pytest.raises(RuntimeError, match="metadata.json"):
        upload_plan(tmp_path, "tilesets/berlin/v7")


def test_tippecanoe_writes_a_directory_with_the_given_layer():
    cmd = tippecanoe_command(Path("/tmp/in.geojson"), Path("/tmp/out"), "landmarks", "berlin")
    assert cmd[0] == "tippecanoe"
    assert cmd[cmd.index("--output-to-directory") + 1] == "/tmp/out"
    assert cmd[cmd.index("--layer") + 1] == "landmarks"
    assert cmd[-1] == "/tmp/in.geojson"
