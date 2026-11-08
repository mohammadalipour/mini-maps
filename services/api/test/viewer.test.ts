import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { TileStore } from '../src/tiles/tile-store.js';
import { viewerHtml } from '../src/viewer.js';

const emptyStore: TileStore = { getTile: async () => null, getManifest: async () => null };

function inlineScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  return scripts[0]![1]!;
}

describe('viewer page', () => {
  it('is served at /viewer with the token and default tileset', async () => {
    const app = buildApp({ tileStore: emptyStore, mapboxAccessToken: 'pk.test', defaultTileset: 'berlin' });
    const res = await app.inject('/viewer');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('mapbox-gl-js/v3.');
    expect(res.body).toContain('{"accessToken":"pk.test","defaultTileset":"berlin"}');
  });

  it('redirects / to the viewer', async () => {
    const res = await buildApp({ tileStore: emptyStore }).inject('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/viewer');
  });

  it('contains valid browser JavaScript', () => {
    const script = inlineScript(viewerHtml({ defaultTileset: 'berlin' }));
    expect(() => new Function(script)).not.toThrow();
  });

  it('cannot be broken out of by config values', () => {
    const html = viewerHtml({ defaultTileset: '</script><script>alert(1)</script>' });
    expect(inlineScript(html)).toContain('\\u003c/script>');
  });

  it('keeps the token form hidden unless the script shows it', () => {
    const html = viewerHtml({ defaultTileset: 'berlin' });
    expect(html).toMatch(/<form id="token-form" hidden>/);
    // A plain `form { display: ... }` rule would beat the hidden attribute and always show it.
    expect(html).not.toMatch(/form\s*\{[^}]*display/);
  });
});
