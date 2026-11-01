# syntax=docker/dockerfile:1
FROM debian:bookworm-slim AS tippecanoe
ARG TIPPECANOE_VERSION=2.79.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates git libsqlite3-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${TIPPECANOE_VERSION} https://github.com/felt/tippecanoe.git /src \
 && make -C /src -j"$(nproc)" \
 && make -C /src install

FROM python:3.13-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 libstdc++6 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe
RUN pip install --no-cache-dir boto3
WORKDIR /app
COPY build_tiles.py ./
USER nobody
ENTRYPOINT ["python", "/app/build_tiles.py"]
