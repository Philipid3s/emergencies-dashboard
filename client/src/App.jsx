import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';

const MAP_CENTER = [14, 5];
const MAP_ZOOM = 2;

function safeExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function createPopupContent(title, lines, link) {
  const container = document.createElement('div');
  container.className = 'popup-content';

  const heading = document.createElement('strong');
  heading.textContent = title;
  container.appendChild(heading);

  lines.forEach((line) => {
    if (!line) {
      return;
    }
    const row = document.createElement('div');
    row.textContent = line;
    container.appendChild(row);
  });

  const safeUrl = safeExternalUrl(link);
  if (safeUrl) {
    const anchor = document.createElement('a');
    anchor.href = safeUrl;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    anchor.textContent = 'Source';
    container.appendChild(anchor);
  }

  return container;
}

function mapEarthquakeColor(level) {
  switch (level) {
    case 'green':
      return '#22c55e';
    case 'yellow':
      return '#eab308';
    case 'orange':
      return '#f97316';
    case 'red':
      return '#ef4444';
    default:
      return '#6366f1';
  }
}

function mapDisasterColor(datetime) {
  if (!datetime) {
    return '#eab308';
  }

  const now = Date.now();
  const ageInDays = (now - datetime) / 86400000;

  if (ageInDays <= 30) {
    return '#ef4444';
  }
  if (ageInDays <= 365) {
    return '#f97316';
  }
  return '#eab308';
}

function emojiForCategory(category, renderType) {
  if (renderType === 'earthquake') {
    return '🌎';
  }

  switch (category) {
    case 'weather_and_natural_disasters':
      return '⛈️';
    case 'earthquakes':
      return '🌎';
    case 'wildfires':
      return '🔥';
    case 'multi_hazard_natural_events':
      return '🌪️';
    case 'humanitarian_disasters':
      return '🆘';
    case 'air_quality':
      return '💨';
    case 'health_and_disease_outbreaks':
      return '🦠';
    case 'wars_and_conflicts':
      return '⚠️';
    default:
      return '📍';
  }
}

function createEmojiIcon(emoji, color) {
  return L.divIcon({
    className: 'emoji-marker-wrapper',
    html: `<span class="emoji-marker" style="border-color:${color}">${emoji}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -12]
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Request failed: ${response.status}`);
  }

  return body;
}

function matchesSearch(item, search) {
  if (!search) {
    return true;
  }

  const normalized = search.toLowerCase();
  return (
    item.title?.toLowerCase().includes(normalized) ||
    item.type?.toLowerCase().includes(normalized)
  );
}

function toLayerToggleMap(layers) {
  const next = {};
  layers.forEach((layer) => {
    next[layer.id] = Boolean(layer.enabled_by_default && layer.supported);
  });
  return next;
}

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);

  const [catalogLayers, setCatalogLayers] = useState([]);
  const [layerData, setLayerData] = useState([]);
  const [activeLayers, setActiveLayers] = useState({});
  const [timeWindowDays, setTimeWindowDays] = useState(10);
  const [search, setSearch] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] = useState('summary');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [manualRefreshTick, setManualRefreshTick] = useState(0);
  const previousManualRefreshTickRef = useRef(0);

  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) {
      return;
    }

    const map = L.map(mapContainerRef.current, {
      zoomControl: true,
      worldCopyJump: true
    }).setView(MAP_CENTER, MAP_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    layerGroupRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    async function loadCatalog() {
      try {
        const payload = await fetchJson('/api/catalog');
        if (!isActive) {
          return;
        }

        const connectedLayers = Array.isArray(payload.layers)
          ? payload.layers.filter((layer) => layer.supported)
          : [];
        setCatalogLayers(connectedLayers);
        setActiveLayers(toLayerToggleMap(connectedLayers));
      } catch (requestError) {
        if (isActive) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      }
    }

    loadCatalog();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    async function loadLayers(forceRefresh) {
      if (catalogLayers.length === 0) {
        return;
      }

      setLoading(true);
      setError('');

      const enabledIds = catalogLayers
        .filter((layer) => activeLayers[layer.id])
        .map((layer) => layer.id);

      if (enabledIds.length === 0) {
        setLayerData([]);
        setLoading(false);
        return;
      }

      const query = new URLSearchParams();
      query.set('days', String(timeWindowDays));
      query.set('layer_ids', enabledIds.join(','));
      if (forceRefresh) {
        query.set('force_refresh', 'true');
      }

      try {
        const payload = await fetchJson(`/api/layers?${query.toString()}`);

        if (!isActive) {
          return;
        }

        const layers = Array.isArray(payload.layers) ? payload.layers : [];
        setLayerData(layers);
      } catch (requestError) {
        if (isActive) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
          setLayerData([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    }

    const shouldForceRefresh = manualRefreshTick !== previousManualRefreshTickRef.current;
    loadLayers(shouldForceRefresh);
    previousManualRefreshTickRef.current = manualRefreshTick;

    return () => {
      isActive = false;
    };
  }, [catalogLayers, activeLayers, timeWindowDays, manualRefreshTick]);

  const filteredLayers = useMemo(() => {
    const cutoff = Date.now() - 30 * 86400000;

    return layerData.map((layer) => {
      const filtered = (Array.isArray(layer.result) ? layer.result : []).filter((entry) => {
        if (!matchesSearch(entry, search)) {
          return false;
        }
        if (!recentOnly) {
          return true;
        }
        return entry.datetime && entry.datetime >= cutoff;
      });

      return {
        ...layer,
        filtered
      };
    });
  }, [layerData, search, recentOnly]);

  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;

    if (!map || !layerGroup) {
      return;
    }

    layerGroup.clearLayers();
    const bounds = [];

    filteredLayers.forEach((layer) => {
      if (layer.status !== 'ok') {
        return;
      }

      layer.filtered.forEach((entry) => {
        if (layer.renderType === 'earthquake') {
          if (!Array.isArray(entry.coordinates) || entry.coordinates.length !== 2) {
            return;
          }

          const marker = L.marker(entry.coordinates, {
            icon: createEmojiIcon(
              emojiForCategory(entry.category || layer.category, layer.renderType),
              mapEarthquakeColor(entry.level)
            )
          });

          marker.bindPopup(
            createPopupContent(
              entry.title || 'Earthquake',
              [
                entry.date,
                entry.type,
                entry.level ? `Alert level: ${entry.level}` : null,
                entry.magnitude !== null ? `Magnitude: ${entry.magnitude}` : null
              ],
              entry.url
            )
          );

          marker.addTo(layerGroup);
          bounds.push(entry.coordinates);
          return;
        }

        if (!Array.isArray(entry.coordinates)) {
          return;
        }

        entry.coordinates.forEach((coord) => {
          if (!Array.isArray(coord) || coord.length !== 2) {
            return;
          }

          const color = mapDisasterColor(entry.datetime);
          const marker = L.marker(coord, {
            icon: createEmojiIcon(
              emojiForCategory(entry.category || layer.category, layer.renderType),
              color
            )
          });

          marker.bindPopup(
            createPopupContent(
              entry.title || 'Disaster',
              [entry.date, entry.type, entry.severity, entry.details, layer.name],
              entry.url
            )
          );

          marker.addTo(layerGroup);
          bounds.push(coord);
        });
      });
    });

    if (bounds.length > 0) {
      map.fitBounds(bounds, { padding: [20, 20], maxZoom: 5 });
    }
  }, [filteredLayers]);

  const displayedCount = useMemo(
    () => filteredLayers.reduce((acc, layer) => acc + layer.filtered.length, 0),
    [filteredLayers]
  );

  const categoryLegend = useMemo(() => {
    const seen = new Map();
    catalogLayers.forEach((layer) => {
      if (!seen.has(layer.category)) {
        seen.set(layer.category, emojiForCategory(layer.category, layer.renderType));
      }
    });
    return Array.from(seen.entries()).map(([category, emoji]) => ({ category, emoji }));
  }, [catalogLayers]);

  function resetViewport() {
    if (mapRef.current) {
      mapRef.current.setView(MAP_CENTER, MAP_ZOOM);
    }
  }

  return (
    <main className="page-shell">
      <header className="panel page-header">
        <div>
          <p className="eyebrow">Global Situational Awareness</p>
          <h1>Global Emergencies Dashboard</h1>
          <p className="subtitle">
            Catalog-driven multi-feed emergency layers with on-demand refresh.
          </p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={() => setManualRefreshTick((value) => value + 1)}>
            Refresh Data
          </button>
          <button className="btn btn-secondary" onClick={resetViewport}>
            Reset View
          </button>
        </div>
      </header>

      <section className="workspace-grid">
        <aside className="sidebar-stack">
          <article className="panel panel-compact">
            <div className="tab-row">
              <button
                type="button"
                className={`tab-btn ${activeSidebarTab === 'summary' ? 'is-active' : ''}`}
                onClick={() => setActiveSidebarTab('summary')}
              >
                Summary
              </button>
              <button
                type="button"
                className={`tab-btn ${activeSidebarTab === 'filters' ? 'is-active' : ''}`}
                onClick={() => setActiveSidebarTab('filters')}
              >
                Filters
              </button>
            </div>

            {activeSidebarTab === 'summary' ? (
              <div className="metrics">
                <h2>Summary</h2>
                <div className="metric">
                  <span>Active layers</span>
                  <strong>{Object.values(activeLayers).filter(Boolean).length}</strong>
                </div>
                <div className="metric">
                  <span>Displayed alerts</span>
                  <strong>{displayedCount}</strong>
                </div>
                <div className="metric">
                  <span>Status</span>
                  <strong>{loading ? 'Loading...' : error ? 'Error' : 'Live'}</strong>
                </div>
                {error ? <p className="error">{error}</p> : null}
                {filteredLayers.map((layer) => (
                  <div className="metric" key={`metric-${layer.id}`}>
                    <span>{layer.name}</span>
                    <strong>{layer.status === 'ok' ? layer.filtered.length : 0}</strong>
                  </div>
                ))}
                <p className="field-label">Map legend</p>
                <div className="legend-list">
                  {categoryLegend.map((item) => (
                    <div className="legend-item" key={item.category}>
                      <span>{item.emoji}</span>
                      <small>{item.category.replaceAll('_', ' ')}</small>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <h2>Filters</h2>
                <label className="field-label" htmlFor="search-input">
                  Search incidents
                </label>
                <input
                  id="search-input"
                  className="input"
                  type="text"
                  placeholder="Type event or disaster name"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />

                <label className="field-label" htmlFor="days-slider">
                  Global window: {timeWindowDays} days
                </label>
                <input
                  id="days-slider"
                  className="slider"
                  type="range"
                  min="1"
                  max="365"
                  value={timeWindowDays}
                  onChange={(event) => setTimeWindowDays(Number(event.target.value))}
                />

                <p className="field-label">Alert layers</p>
                <div className="checks-row checks-column">
                  {catalogLayers.map((layer) => (
                    <label className="checkbox" key={layer.id}>
                      <input
                        type="checkbox"
                        disabled={!layer.supported}
                        checked={Boolean(activeLayers[layer.id])}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setActiveLayers((previous) => ({
                            ...previous,
                            [layer.id]: checked
                          }));
                        }}
                      />
                      <span>
                        {layer.name}
                      </span>
                </label>
              ))}
                </div>

                <button
                  type="button"
                  className={`toggle ${recentOnly ? 'is-active' : ''}`}
                  onClick={() => setRecentOnly((value) => !value)}
                >
                  {recentOnly ? 'Recent only (30d)' : 'All dates'}
                </button>
              </div>
            )}
          </article>
        </aside>

        <section className="panel map-panel">
          <div ref={mapContainerRef} className="map-canvas" aria-label="World emergency map" />
        </section>
      </section>
    </main>
  );
}
