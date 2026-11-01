import { type CloudWatchClient, type MetricDatum, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

/**
 * Per-route request metrics, aggregated in memory and published once a minute (docs/adr/0007).
 *
 * Latencies go out as a histogram (PutMetricData Values + Counts), so CloudWatch can compute
 * p50/p99, and the cost is one API call per minute per task however much traffic there is.
 */

// Buckets ~20% wide: 0.1 ms .. 100 s is ~76 distinct values, under PutMetricData's 150 limit.
const BUCKET_BASE = 1.2;
const MIN_LATENCY_MS = 0.1;

export function latencyBucket(ms: number): number {
  const clamped = Math.max(ms, MIN_LATENCY_MS);
  const bucket = BUCKET_BASE ** Math.round(Math.log(clamped) / Math.log(BUCKET_BASE));
  return Math.round(bucket * 100) / 100;
}

interface RouteStats {
  latencies: Map<number, number>;
  requests: number;
  errors5xx: number;
}

export class RequestMetrics {
  private routes = new Map<string, RouteStats>();

  record(route: string, statusCode: number, latencyMs: number): void {
    let stats = this.routes.get(route);
    if (!stats) {
      stats = { latencies: new Map(), requests: 0, errors5xx: 0 };
      this.routes.set(route, stats);
    }
    const bucket = latencyBucket(latencyMs);
    stats.latencies.set(bucket, (stats.latencies.get(bucket) ?? 0) + 1);
    stats.requests += 1;
    if (statusCode >= 500) stats.errors5xx += 1;
  }

  /** Returns everything recorded since the last drain and starts a new period. */
  drain(timestamp = new Date()): MetricDatum[] {
    const routes = this.routes;
    this.routes = new Map();

    return [...routes].flatMap(([route, stats]) => {
      const dimensions = [{ Name: 'Route', Value: route }];
      return [
        {
          MetricName: 'Latency',
          Dimensions: dimensions,
          Timestamp: timestamp,
          Unit: 'Milliseconds',
          Values: [...stats.latencies.keys()],
          Counts: [...stats.latencies.values()],
        },
        { MetricName: 'Requests', Dimensions: dimensions, Timestamp: timestamp, Unit: 'Count', Value: stats.requests },
        { MetricName: 'Errors5xx', Dimensions: dimensions, Timestamp: timestamp, Unit: 'Count', Value: stats.errors5xx },
      ];
    });
  }
}

/** Short, low-cardinality names for route patterns; each one becomes a CloudWatch dimension value. */
export function routeLabel(pattern: string | undefined): string | null {
  switch (pattern) {
    case '/v1/tiles/:tilesetId/:version/:z/:x/:y.mvt':
      return 'tiles';
    case '/v1/tilesets/:tilesetId':
      return 'tilejson';
    case '/v1/tilesets/:tilesetId/features':
      return 'features';
    case '/viewer':
      return 'viewer';
    case '/health':
    case '/':
      return null; // health checks would only add noise
    default:
      return 'other'; // 404s and anything unexpected: one bucket, never one per URL
  }
}

export interface MetricsPublisherOptions {
  client: CloudWatchClient;
  namespace: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export class MetricsPublisher {
  private timer?: NodeJS.Timeout;

  constructor(
    readonly metrics: RequestMetrics,
    private readonly options: MetricsPublisherOptions,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.intervalMs ?? 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  async flush(): Promise<void> {
    const data = this.metrics.drain();
    // PutMetricData accepts up to 1000 datums per call.
    for (let i = 0; i < data.length; i += 1000) {
      try {
        await this.options.client.send(
          new PutMetricDataCommand({ Namespace: this.options.namespace, MetricData: data.slice(i, i + 1000) }),
        );
      } catch (err) {
        // Metrics must never break the request path: report and drop this period.
        this.options.onError?.(err);
      }
    }
  }
}
