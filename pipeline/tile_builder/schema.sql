-- Feature store for bbox queries (docs/adr/0006). Idempotent: applied by every tile build.
-- Rows are per (tileset, version); the API reads the version that manifest.json points to.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS tileset_versions (
    tileset_id    text        NOT NULL,
    version       bigint      NOT NULL,
    feature_count integer     NOT NULL,
    loaded_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tileset_id, version)
);

CREATE TABLE IF NOT EXISTS features (
    tileset_id    text     NOT NULL,
    version       bigint   NOT NULL,
    feature_index integer  NOT NULL,
    properties    jsonb    NOT NULL DEFAULT '{}',
    geom          geometry(Geometry, 4326) NOT NULL,
    PRIMARY KEY (tileset_id, version, feature_index),
    FOREIGN KEY (tileset_id, version) REFERENCES tileset_versions ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS features_geom_idx ON features USING gist (geom);
