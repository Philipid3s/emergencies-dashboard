const express = require('express');
const path = require('path');
const fs = require('fs');
const USGS = require('./usgs');
const { fetchJsonWithRetry } = require('./upstreamClient');

const DEFAULT_CACHE_TTL_MS = {
  usgs_earthquakes: 5 * 60 * 1000,
  noaa_nws: 5 * 60 * 1000,
  nasa_eonet: 30 * 60 * 1000,
  fema_api: 60 * 60 * 1000,
  cdc_media: 60 * 60 * 1000
};

const CATALOG_PATH = path.join(__dirname, 'feed_catalog.json');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toErrorPayload(error) {
  return {
    error: 'Upstream data source failure',
    message: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString()
  };
}

function parseBoolean(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function resolveGlobalDays(req, fallback = 10) {
  const explicitDays = req.query.days;
  return clamp(Number.parseInt(explicitDays, 10) || fallback, 1, 3650);
}

function centroidFromCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return null;
  }

  let count = 0;
  let sumLon = 0;
  let sumLat = 0;

  function visit(node) {
    if (!Array.isArray(node)) {
      return;
    }

    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumLon += node[0];
      sumLat += node[1];
      count += 1;
      return;
    }

    node.forEach(visit);
  }

  visit(coordinates);

  if (count === 0) {
    return null;
  }

  return [sumLat / count, sumLon / count];
}

function geometryToLatLon(geometry) {
  if (!geometry || !geometry.type) {
    return null;
  }

  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (typeof lat === 'number' && typeof lon === 'number') {
      return [lat, lon];
    }
    return null;
  }

  const centroid = centroidFromCoordinates(geometry.coordinates);
  return centroid;
}

function stripHtml(input) {
  if (!input) {
    return '';
  }
  return String(input).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const US_STATE_CENTROIDS = {
  AL: [32.806671, -86.79113],
  AK: [61.370716, -152.404419],
  AZ: [33.729759, -111.431221],
  AR: [34.969704, -92.373123],
  CA: [36.116203, -119.681564],
  CO: [39.059811, -105.311104],
  CT: [41.597782, -72.755371],
  DE: [39.318523, -75.507141],
  FL: [27.766279, -81.686783],
  GA: [33.040619, -83.643074],
  HI: [21.094318, -157.498337],
  ID: [44.240459, -114.478828],
  IL: [40.349457, -88.986137],
  IN: [39.849426, -86.258278],
  IA: [42.011539, -93.210526],
  KS: [38.5266, -96.726486],
  KY: [37.66814, -84.670067],
  LA: [31.169546, -91.867805],
  ME: [44.693947, -69.381927],
  MD: [39.063946, -76.802101],
  MA: [42.230171, -71.530106],
  MI: [43.326618, -84.536095],
  MN: [45.694454, -93.900192],
  MS: [32.741646, -89.678696],
  MO: [38.456085, -92.288368],
  MT: [46.921925, -110.454353],
  NE: [41.12537, -98.268082],
  NV: [38.313515, -117.055374],
  NH: [43.452492, -71.563896],
  NJ: [40.298904, -74.521011],
  NM: [34.840515, -106.248482],
  NY: [42.165726, -74.948051],
  NC: [35.630066, -79.806419],
  ND: [47.528912, -99.784012],
  OH: [40.388783, -82.764915],
  OK: [35.565342, -96.928917],
  OR: [44.572021, -122.070938],
  PA: [40.590752, -77.209755],
  RI: [41.680893, -71.51178],
  SC: [33.856892, -80.945007],
  SD: [44.299782, -99.438828],
  TN: [35.747845, -86.692345],
  TX: [31.054487, -97.563461],
  UT: [40.150032, -111.862434],
  VT: [44.045876, -72.710686],
  VA: [37.769337, -78.169968],
  WA: [47.400902, -121.490494],
  WV: [38.491226, -80.954453],
  WI: [44.268543, -89.616508],
  WY: [42.755966, -107.30249],
  DC: [38.9072, -77.0369],
  PR: [18.2208, -66.5901],
  GU: [13.4443, 144.7937],
  VI: [18.3358, -64.8963],
  AS: [-14.271, -170.132],
  MP: [15.0979, 145.6739]
};
const USA_FALLBACK_COORD = [39.8283, -98.5795];

function mapFemaIncidentToCategory(incidentType) {
  const value = String(incidentType || '').toLowerCase();

  if (value.includes('fire')) {
    return 'wildfires';
  }
  if (value.includes('storm') || value.includes('hurricane') || value.includes('tornado') || value.includes('typhoon')) {
    return 'weather_and_natural_disasters';
  }
  if (value.includes('flood') || value.includes('mud') || value.includes('landslide')) {
    return 'multi_hazard_natural_events';
  }
  if (value.includes('earthquake') || value.includes('volcan')) {
    return 'earthquakes';
  }

  return 'humanitarian_disasters';
}

function loadFeedCatalog(catalogPath = CATALOG_PATH) {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
}

function flattenCatalog(catalog) {
  const grouped = catalog && catalog.emergency_dashboard_apis
    ? catalog.emergency_dashboard_apis
    : {};

  const layers = [];

  Object.entries(grouped).forEach(([category, feeds]) => {
    if (!Array.isArray(feeds)) {
      return;
    }

    feeds.forEach((feed) => {
      const name = feed.name || 'Unnamed feed';
      const id = feed.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      layers.push({ ...feed, id, category });
    });
  });

  return layers;
}

function createApp(options = {}) {
  const app = express();
  const cache = new Map();

  const createUSGS = options.createUSGS || ((dateFrom, dateTo) => new USGS(dateFrom, dateTo));
  const now = options.now || (() => new Date());
  const cacheTtlMs = { ...DEFAULT_CACHE_TTL_MS, ...(options.cacheTtlMs || {}) };
  const catalog = options.feedCatalog || loadFeedCatalog(options.feedCatalogPath);
  const catalogLayers = flattenCatalog(catalog);

  const adapters = {
    usgs_earthquakes: {
      resolve: (req) => {
        const days = clamp(resolveGlobalDays(req, 10), 1, 30);
        return { days };
      },
      load: async (params) => {
        const dateTo = now();
        const dateFrom = new Date(dateTo);
        dateFrom.setUTCDate(dateTo.getUTCDate() - params.days);

        const usgs = createUSGS(dateFrom, dateTo);
        const result = await usgs.loadEarthquakes();

        return {
          result,
          params,
          renderType: 'earthquake'
        };
      }
    },
    noaa_nws: {
      resolve: (req) => ({ days: resolveGlobalDays(req, 10) }),
      load: async (params) => {
        const payload = await fetchJsonWithRetry('https://api.weather.gov/alerts/active', {
          timeoutMs: 12000,
          maxAttempts: 3,
          retryDelayMs: 500
        });

        const features = Array.isArray(payload.features) ? payload.features : [];
        const cutoff = Date.now() - (params.days * 86400000);
        const result = features
          .map((feature) => {
            const coords = geometryToLatLon(feature.geometry);
            if (!coords) {
              return null;
            }

            const properties = feature.properties || {};
            const timestamp = properties.sent || properties.onset || null;
            const datetime = timestamp ? Date.parse(timestamp) : null;
            if (!datetime || datetime < cutoff) {
              return null;
            }
            const date = datetime ? new Date(datetime).toLocaleDateString('en-US') : null;

            return {
              type: properties.event || 'weather_alert',
              datetime,
              date,
              coordinates: [coords],
              title: properties.headline || properties.event || 'Weather alert',
              severity: properties.severity || null,
              url: properties['@id'] || null
            };
          })
          .filter(Boolean);

        return {
          result,
          params,
          renderType: 'disaster'
        };
      }
    },
    nasa_eonet: {
      resolve: (req) => ({ days: resolveGlobalDays(req, 10) }),
      load: async (params) => {
        const payload = await fetchJsonWithRetry('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=100', {
          timeoutMs: 12000,
          maxAttempts: 3,
          retryDelayMs: 500
        });

        const events = Array.isArray(payload.events) ? payload.events : [];
        const cutoff = Date.now() - (params.days * 86400000);
        const result = events.map((event) => {
          const geometries = Array.isArray(event.geometry) ? event.geometry : [];
          const coordinates = geometries
            .map((entry) => geometryToLatLon(entry))
            .filter((coord) => Array.isArray(coord) && coord.length === 2);

          const firstDate = geometries[0] && geometries[0].date ? Date.parse(geometries[0].date) : null;
          if (!firstDate || firstDate < cutoff) {
            return null;
          }
          const categories = Array.isArray(event.categories)
            ? event.categories.map((entry) => entry.title || entry.id).filter(Boolean)
            : [];

          return {
            type: categories.join(', ') || 'natural_event',
            datetime: firstDate,
            date: firstDate ? new Date(firstDate).toLocaleDateString('en-US') : null,
            coordinates,
            title: event.title || 'Natural event',
            url: event.link || null
          };
        }).filter(Boolean);

        return {
          result,
          params,
          renderType: 'disaster'
        };
      }
    },
    fema_api: {
      resolve: (req) => {
        const days = resolveGlobalDays(req, 10);
        const limit = clamp(Number.parseInt(req.query.fema_limit, 10) || 500, 10, 2000);
        return { days, limit };
      },
      load: async (params) => {
        const url = new URL('https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries');
        url.searchParams.set('$top', String(params.limit));
        url.searchParams.set('$orderby', 'declarationDate desc');
        url.searchParams.set(
          '$select',
          'disasterNumber,state,incidentType,declarationDate,designatedArea,declarationTitle'
        );

        const payload = await fetchJsonWithRetry(url.toString(), {
          timeoutMs: 12000,
          maxAttempts: 3,
          retryDelayMs: 500
        });

        const entries = Array.isArray(payload.DisasterDeclarationsSummaries)
          ? payload.DisasterDeclarationsSummaries
          : [];

        const cutoff = Date.now() - (params.days * 86400000);
        const result = entries
          .map((entry) => {
            const state = String(entry.state || '').toUpperCase();
            const centroid = US_STATE_CENTROIDS[state] || null;
            if (!centroid) {
              return null;
            }

            const declarationIso = entry.declarationDate || null;
            const datetime = declarationIso ? Date.parse(declarationIso) : null;
            if (!datetime || datetime < cutoff) {
              return null;
            }

            const disasterNumber = entry.disasterNumber ? String(entry.disasterNumber) : null;

            return {
              type: entry.incidentType || 'disaster_declaration',
              datetime,
              date: new Date(datetime).toLocaleDateString('en-US'),
              coordinates: [centroid],
              title: entry.declarationTitle || `${entry.incidentType || 'Disaster'} - ${state}`,
              severity: null,
              category: mapFemaIncidentToCategory(entry.incidentType),
              details: entry.designatedArea || state,
              url: disasterNumber ? `https://www.fema.gov/disaster/${disasterNumber}` : null
            };
          })
          .filter(Boolean);

        return {
          result,
          params,
          renderType: 'disaster'
        };
      }
    },
    cdc_media: {
      resolve: (req) => {
        const days = resolveGlobalDays(req, 10);
        const limit = clamp(Number.parseInt(req.query.cdc_limit, 10) || 200, 10, 500);
        return { days, limit };
      },
      load: async (params) => {
        const url = new URL('https://tools.cdc.gov/api/v2/resources/media');
        url.searchParams.set('format', 'json');
        url.searchParams.set('topic', 'All');
        url.searchParams.set('max', String(params.limit));
        url.searchParams.set('sort', '-datepublished');

        const payload = await fetchJsonWithRetry(url.toString(), {
          timeoutMs: 12000,
          maxAttempts: 3,
          retryDelayMs: 500
        });

        const entries = Array.isArray(payload.results) ? payload.results : [];
        const cutoff = Date.now() - (params.days * 86400000);

        const result = entries
          .map((entry) => {
            const isoDate = entry.datePublished || entry.dateModified || null;
            const datetime = isoDate ? Date.parse(isoDate) : null;
            if (!datetime || datetime < cutoff) {
              return null;
            }

            const firstGeoTag = Array.isArray(entry.geoTags) ? entry.geoTags[0] : null;
            const lat = firstGeoTag ? Number.parseFloat(firstGeoTag.latitude) : null;
            const lon = firstGeoTag ? Number.parseFloat(firstGeoTag.longitude) : null;
            const coord = Number.isFinite(lat) && Number.isFinite(lon)
              ? [lat, lon]
              : USA_FALLBACK_COORD;

            const title = entry.name || 'CDC media item';
            const mediaType = entry.mediaType || 'Media';
            const summary = stripHtml(entry.description);
            const safeSummary = summary ? summary.slice(0, 220) : '';

            return {
              type: 'health_alert',
              datetime,
              date: new Date(datetime).toLocaleDateString('en-US'),
              coordinates: [coord],
              title,
              severity: mediaType,
              details: safeSummary,
              url: entry.targetUrl || entry.sourceUrl || null
            };
          })
          .filter(Boolean);

        return {
          result,
          params,
          renderType: 'disaster'
        };
      }
    }
  };

  const layerDefinitions = catalogLayers.map((layer) => ({
    ...layer,
    supported: Boolean(adapters[layer.source_id])
  }));

  async function withCache(cacheKey, ttlMs, loader, cacheOptions = {}) {
    const forceRefresh = Boolean(cacheOptions.forceRefresh);
    const currentTime = Date.now();
    const cached = cache.get(cacheKey);

    if (!forceRefresh && cached && cached.expiresAt > currentTime) {
      return { data: cached.data, fromCache: true, stale: false };
    }

    try {
      const data = await loader();
      cache.set(cacheKey, {
        data,
        expiresAt: currentTime + ttlMs
      });
      return { data, fromCache: false, stale: false };
    } catch (error) {
      if (cached) {
        return { data: cached.data, fromCache: true, stale: true };
      }
      throw error;
    }
  }

  async function fetchLayerData(layerDef, req, forceRefresh) {
    const adapter = adapters[layerDef.source_id];

    if (!adapter) {
      return {
        id: layerDef.id,
        source_id: layerDef.source_id,
        name: layerDef.name,
        category: layerDef.category,
        supported: false,
        status: 'unsupported',
        count: 0,
        cached: false,
        stale: false,
        result: []
      };
    }

    const params = adapter.resolve(req);
    const cacheKey = `layer:${layerDef.id}:${JSON.stringify(params)}`;
    const ttl = cacheTtlMs[layerDef.source_id] || (Number(layerDef.polling_interval_minutes) || 5) * 60 * 1000;

    const cacheResult = await withCache(
      cacheKey,
      ttl,
      async () => adapter.load(params),
      { forceRefresh }
    );

    return {
      id: layerDef.id,
      source_id: layerDef.source_id,
      name: layerDef.name,
      category: layerDef.category,
      description: layerDef.description,
      renderType: cacheResult.data.renderType,
      status: 'ok',
      supported: true,
      enabled_by_default: Boolean(layerDef.enabled_by_default),
      count: cacheResult.data.result.length,
      cached: cacheResult.fromCache,
      stale: cacheResult.stale,
      params: cacheResult.data.params,
      result: cacheResult.data.result
    };
  }

  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'emergencies-dashboard-api',
      timestamp: now().toISOString()
    });
  });

  app.get('/api/catalog', (req, res) => {
    const layers = layerDefinitions.map((layer) => ({
      id: layer.id,
      source_id: layer.source_id,
      name: layer.name,
      category: layer.category,
      description: layer.description,
      format: layer.format,
      coverage: layer.coverage,
      polling_interval_minutes: layer.polling_interval_minutes,
      enabled_by_default: Boolean(layer.enabled_by_default),
      supported: layer.supported
    }));

    res.status(200).json({
      meta: catalog.meta || {},
      layers
    });
  });

  app.get('/api/layers', async (req, res) => {
    const forceRefresh = parseBoolean(req.query.force_refresh);
    const selectedIds = req.query.layer_ids
      ? String(req.query.layer_ids).split(',').map((id) => id.trim()).filter(Boolean)
      : null;

    const requestedLayers = layerDefinitions.filter((layer) => {
      if (selectedIds && selectedIds.length > 0) {
        return selectedIds.includes(layer.id);
      }
      return Boolean(layer.enabled_by_default);
    });

    const layerResults = await Promise.all(
      requestedLayers.map(async (layerDef) => {
        try {
          return await fetchLayerData(layerDef, req, forceRefresh);
        } catch (error) {
          return {
            id: layerDef.id,
            source_id: layerDef.source_id,
            name: layerDef.name,
            category: layerDef.category,
            description: layerDef.description,
            status: 'error',
            supported: true,
            enabled_by_default: Boolean(layerDef.enabled_by_default),
            count: 0,
            cached: false,
            stale: false,
            error: error instanceof Error ? error.message : String(error),
            result: []
          };
        }
      })
    );

    res.status(200).json({
      generatedAt: now().toISOString(),
      force_refresh: forceRefresh,
      layers: layerResults
    });
  });

  app.get('/api/usgs', async (req, res) => {
    const layerDef = layerDefinitions.find((layer) => layer.source_id === 'usgs_earthquakes' && layer.supported);

    if (!layerDef) {
      res.status(404).json({ error: 'USGS layer is not configured' });
      return;
    }

    try {
      const layer = await fetchLayerData(layerDef, req, parseBoolean(req.query.force_refresh));
      res.status(200).json({
        source: 'usgs',
        count: layer.count,
        days: layer.params.days,
        cached: layer.cached,
        stale: layer.stale,
        generatedAt: now().toISOString(),
        result: layer.result
      });
    } catch (error) {
      res.status(502).json(toErrorPayload(error));
    }
  });

  const clientDistPath = path.join(__dirname, 'client', 'dist');
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));

    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.sendFile(path.join(clientDistPath, 'index.html'));
    });
  }

  return app;
}

function startServer(port = Number(process.env.PORT) || 5000) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  startServer,
  clamp,
  toErrorPayload,
  loadFeedCatalog,
  flattenCatalog
};
