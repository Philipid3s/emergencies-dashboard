const { fetchJsonWithRetry } = require('./upstreamClient');

const dateOptions = {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric'
};

const ALERT_LEVELS = new Set(['green', 'yellow', 'orange', 'red']);

function formatDateForApi(date) {
  return date.toISOString().slice(0, 10);
}

class USGS {
  constructor(dateFrom, dateTo) {
    const start = formatDateForApi(dateFrom);
    const end = formatDateForApi(dateTo);
    this.url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&endtime=${end}`;
  }

  toEarthquake(data) {
    const eventTime = data?.properties?.time;
    const coordinates = data?.geometry?.coordinates;

    return {
      type: (data?.properties?.type || 'earthquake').toLowerCase(),
      datetime: eventTime,
      date: eventTime ? new Date(eventTime).toLocaleDateString('en-US', dateOptions) : null,
      coordinates: Array.isArray(coordinates) ? [coordinates[1], coordinates[0]] : null,
      title: data?.properties?.title || 'Untitled earthquake',
      level: data?.properties?.alert || null,
      url: data?.properties?.url || null,
      magnitude: data?.properties?.mag ?? null
    };
  }

  async loadEarthquakes() {
    const json = await fetchJsonWithRetry(this.url, {
      timeoutMs: 10000,
      maxAttempts: 3,
      retryDelayMs: 400
    });

    const features = Array.isArray(json.features) ? json.features : [];

    return features
      .filter((entry) => ALERT_LEVELS.has(entry?.properties?.alert))
      .map((entry) => this.toEarthquake(entry))
      .filter((entry) => Array.isArray(entry.coordinates) && entry.coordinates.length === 2);
  }
}

module.exports = USGS;
