# Global Emergencies Dashboard

Modernized stack for a live global emergencies map.

Repository: `emergencies-dashboard`

## Architecture

- Backend: Express API (`/api/catalog`, `/api/layers`, `/api/usgs`, `/api/health`)
- Frontend: Vite + React 18 + Leaflet
- Feed catalog: JSON-driven source configuration in `feed_catalog.json`
- Design system: Deep Indigo tokens via CSS variables

## Feed workflow

- Catalog is loaded on backend startup from `feed_catalog.json`
- Dashboard loads catalog + enabled layers on page load
- Layer checkboxes control which alert layers are queried and rendered
- `Refresh Data` forces upstream refresh (bypasses cache)

## Data sources currently supported in adapters

- USGS earthquakes (`source_id: usgs_earthquakes`)
- NOAA / NWS active alerts (`source_id: noaa_nws`)
- NASA EONET open events (`source_id: nasa_eonet`)
- FEMA disaster declarations (`source_id: fema_api`)
- CDC media feed (`source_id: cdc_media`)

## Reliability strategy

- Upstream retry with timeout for supported providers
- In-memory API cache (`USGS: 5m`, `NOAA: 5m`, `EONET: 30m`, `FEMA: 60m`, `CDC: 60m`)
- Stale cache fallback when upstream is temporarily unavailable

## Requirements

- Node.js 20+
- npm 9+

## Configuration

No required API credentials for currently connected open feeds.

## Run locally

1. Install backend dependencies:
   - `npm install`
2. Install frontend dependencies:
   - `npm --prefix client install`
3. Start both services:
   - `npm run dev`
4. Open frontend:
   - `http://localhost:5173`

## Quality checks

- Lint: `npm run lint`
- Test: `npm test`

## Production build

1. `npm run build`
2. `npm start`

The server serves compiled frontend assets from `client/dist`.
## Docker automation

A GitHub Actions workflow builds and pushes Docker images to `philipid3s/emergencies-dashboard`.

- Workflow file: `.github/workflows/docker-image.yml`
- Trigger: pushes to `main`, version tags (`v*`), and manual runs
- Target platforms: `linux/amd64`, `linux/arm64`

### Required GitHub repository secrets

- `DOCKERHUB_USERNAME` (for Docker Hub account `philipid3s`)
- `DOCKERHUB_TOKEN` (Docker Hub access token with push permissions)

### Local image build test

```bash
docker build -t emergencies-dashboard:local .
```

