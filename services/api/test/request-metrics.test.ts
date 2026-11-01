import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MetricsPublisher, RequestMetrics, latencyBucket, routeLabel } from '../src/metrics/request-metrics.js';
import type { TileStore } from '../src/tiles/tile-store.js';

describe('latencyBucket', () => {
  it('stays within ~10% of the real value', () => {
    for (const ms of [0.4, 3, 17, 250, 4_000, 60_000]) {
      expect(Math.abs(latencyBucket(ms) - ms) / ms).toBeLessThan(0.11);
    }
  });

  it('keeps 0.1 ms .. 100 s under the 150 distinct values PutMetricData allows', () => {
    const buckets = new Set<number>();
    for (let ms = 0.05; ms < 100_000; ms *= 1.01) buckets.add(latencyBucket(ms));
    expect(buckets.size).toBeLessThan(150);
  });
});

describe('RequestMetrics', () => {
  it('aggregates latency as a histogram plus request and 5xx counts per route', () => {
    const metrics = new RequestMetrics();
    metrics.record('tiles', 200, 10);
    metrics.record('tiles', 200, 10.2);
    metrics.record('tiles', 503, 900);
    metrics.record('tilejson', 200, 2);

    const data = metrics.drain(new Date(0));
    const tiles = data.filter((d) => d.Dimensions?.[0]?.Value === 'tiles');
    const latency = tiles.find((d) => d.MetricName === 'Latency');

    expect(latency?.Counts?.reduce((a, b) => a + b, 0)).toBe(3);
    expect(latency?.Values).toHaveLength(2); // 10 and 10.2 share a bucket
    expect(tiles.find((d) => d.MetricName === 'Requests')?.Value).toBe(3);
    expect(tiles.find((d) => d.MetricName === 'Errors5xx')?.Value).toBe(1);
    expect(data.filter((d) => d.Dimensions?.[0]?.Value === 'tilejson')).toHaveLength(3);
  });

  it('starts a new period after each drain', () => {
    const metrics = new RequestMetrics();
    metrics.record('tiles', 200, 5);
    metrics.drain();
    expect(metrics.drain()).toEqual([]);
  });
});

describe('routeLabel', () => {
  it('maps patterns to a small, fixed set of names', () => {
    expect(routeLabel('/v1/tiles/:tilesetId/:version/:z/:x/:y.mvt')).toBe('tiles');
    expect(routeLabel('/v1/tilesets/:tilesetId')).toBe('tilejson');
    expect(routeLabel('/v1/tilesets/:tilesetId/features')).toBe('features');
    expect(routeLabel(undefined)).toBe('other');
    expect(routeLabel('/health')).toBeNull();
  });
});

describe('app integration', () => {
  const tileStore: TileStore = { getTile: async () => null, getManifest: async () => null };

  it('records each request under its route, but not health checks', async () => {
    const metrics = new RequestMetrics();
    const app = buildApp({ tileStore, metrics });
    await app.inject('/v1/tiles/berlin/1/0/0/0.mvt');
    await app.inject('/v1/tilesets/nope');
    await app.inject('/no/such/path');
    await app.inject('/health');

    const routes = new Set(metrics.drain().map((d) => d.Dimensions?.[0]?.Value));
    expect(routes).toEqual(new Set(['tiles', 'tilejson', 'other']));
  });
});

describe('MetricsPublisher', () => {
  it('sends one PutMetricData per flush and nothing when idle', async () => {
    const send = vi.fn(async () => ({}));
    const metrics = new RequestMetrics();
    const publisher = new MetricsPublisher(metrics, { client: { send } as never, namespace: 'Test/Api' });

    await publisher.flush();
    expect(send).not.toHaveBeenCalled();

    metrics.record('tiles', 200, 5);
    await publisher.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0] as unknown as [{ input: { Namespace: string; MetricData: unknown[] } }];
    expect(command.input.Namespace).toBe('Test/Api');
    expect(command.input.MetricData).toHaveLength(3);
  });

  it('reports failures instead of throwing', async () => {
    const onError = vi.fn();
    const metrics = new RequestMetrics();
    const publisher = new MetricsPublisher(metrics, {
      client: { send: async () => Promise.reject(new Error('throttled')) } as never,
      namespace: 'Test/Api',
      onError,
    });
    metrics.record('tiles', 200, 5);
    await expect(publisher.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});
