const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../server');

test('GET /api/health returns service status', async () => {
  const app = createApp();

  const response = await request(app)
    .get('/api/health')
    .expect(200);

  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'emergencies-dashboard-api');
  assert.ok(response.body.timestamp);
});

test('GET /api/usgs clamps days query to 30', async () => {
  let capturedFrom = null;
  let capturedTo = null;

  const app = createApp({
    createUSGS: (dateFrom, dateTo) => {
      capturedFrom = dateFrom;
      capturedTo = dateTo;
      return {
        loadEarthquakes: async () => [{ title: 'Mock quake' }]
      };
    },
    now: () => new Date('2026-03-01T00:00:00.000Z')
  });

  const response = await request(app)
    .get('/api/usgs?days=999')
    .expect(200);

  assert.equal(response.body.days, 30);
  assert.equal(response.body.count, 1);
  assert.ok(capturedFrom instanceof Date);
  assert.ok(capturedTo instanceof Date);
  assert.equal(capturedTo.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(capturedFrom.toISOString(), '2026-01-30T00:00:00.000Z');
});

test('GET /api/usgs serves stale cache when upstream fails', async () => {
  let shouldFail = false;
  let callCount = 0;

  const app = createApp({
    createUSGS: () => ({
      loadEarthquakes: async () => {
        callCount += 1;
        if (shouldFail) {
          throw new Error('upstream down');
        }
        return [{ title: 'Cached quake' }];
      }
    }),
    cacheTtlMs: { usgs_earthquakes: 0 }
  });

  const first = await request(app)
    .get('/api/usgs?days=10')
    .expect(200);

  assert.equal(first.body.stale, false);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.count, 1);

  shouldFail = true;

  const second = await request(app)
    .get('/api/usgs?days=10&force_refresh=true')
    .expect(200);

  assert.equal(second.body.stale, true);
  assert.equal(second.body.cached, true);
  assert.equal(second.body.count, 1);
  assert.equal(callCount, 2);
});
