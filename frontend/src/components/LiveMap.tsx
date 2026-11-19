import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { CloudSun, RefreshCw, Expand, LocateFixed, Car, TriangleAlert, Key, X, ExternalLink } from "lucide-react";
import { api, BASE } from "../api/client";
import type { NetNode, RouteOption, LiveWeather, AppSettings, Incident, WeatherZone, WeatherZoneInput } from "../api/types";
import { dt, hm } from "../lib";
import type { SimView } from "./JourneySimulator";
import { MapWeatherSimulation } from "./MapWeatherSimulation";
import { GoogleLiveMap } from "./GoogleLiveMap";
import { GOOGLE_MAPS_KEY, googleMapsRefused } from "./googleMapsApi";
import { createRouteIncidentMatcher } from "./mapRouteGeometry";
import { useRouteMapConditions } from "./useRouteMapConditions";
import { TRUCK_GLYPH } from "./truckGlyph";
import { RouteWeatherReadout } from "./RouteWeatherReadout";
import { HubEventSummary } from "./HubEventSummary";
import { hubNoticeDetails, hubNoticeMarker, type HubRouteNotice } from "./routeHubEvents";

function buildHubPopupHtml(
  n: NetNode,
  path: string[],
  alternatives: RouteOption[],
  forecasts: LiveWeather[],
  trafficSections: { geometry: number[][]; delay_minutes: number; description: string }[],
  incidents: Incident[],
  trafficConfigured: boolean
): string {
  const onPath = path.includes(n.id);
  const pathIdx = path.indexOf(n.id);
  const activeOpt = alternatives.find((o) => o.path.join("-") === path.join("-")) || alternatives[0];

  // 1. Time to reach
  let timeText = "Not on active route";
  let isHighlight = false;
  let isWarn = false;

  if (onPath) {
    isHighlight = true;
    if (pathIdx === 0) {
      timeText = "Departure Origin (0 min · Start)";
      if (activeOpt?.depart_at) {
        timeText += ` · ${dt(activeOpt.depart_at)}`;
      }
    } else if (pathIdx === path.length - 1 && activeOpt) {
      timeText = `Destination · ${hm(activeOpt.total_minutes)} (ETA: ${dt(activeOpt.eta)})`;
    } else if (activeOpt?.steps) {
      let cumulativeMinutes = 0;
      let arrivalTime = "";
      for (const step of activeOpt.steps) {
        cumulativeMinutes += step.minutes;
        if (step.location === n.id) {
          arrivalTime = step.start || step.end;
          break;
        }
      }
      if (cumulativeMinutes > 0) {
        timeText = `~${hm(cumulativeMinutes)} from origin`;
        if (arrivalTime) {
          timeText += ` · ETA: ${dt(arrivalTime)}`;
        }
      } else {
        timeText = "Active route corridor";
      }
    } else {
      timeText = "Intermediate hub on active route";
    }
  }

  // 2. Weather
  let matchedWx = forecasts.find((w) => w.id === n.id || w.name?.toLowerCase() === n.name.toLowerCase());
  if (!matchedWx && forecasts.length > 0) {
    let minD = Infinity;
    for (const w of forecasts) {
      const d = Math.hypot(w.lon - n.lon, w.lat - n.lat);
      if (d < minD && d < 1.5) {
        minD = d;
        matchedWx = w;
      }
    }
  }
  let wxText = "Fair · Normal driving visibility";
  if (matchedWx) {
    const cond = matchedWx.condition || matchedWx.status || "Clear";
    const temp = matchedWx.temperature_c != null ? `${matchedWx.temperature_c}°C` : "";
    const wind = matchedWx.wind_kmh != null ? `Wind ${matchedWx.wind_kmh} km/h` : "";
    const delay = matchedWx.delay_minutes ? ` (+${matchedWx.delay_minutes}m weather impact)` : "";
    wxText = [cond, temp, wind].filter(Boolean).join(" · ") + delay;
  }

  // 3. Traffic
  let trafficText = trafficConfigured ? "🟢 Normal traffic flow (TomTom Live)" : "🟢 Normal flow (Simulated corridor)";
  const sec = trafficSections.find((s) => s.description?.toLowerCase().includes(n.name.toLowerCase()) || s.description?.toLowerCase().includes(n.id.toLowerCase()));
  if (sec && sec.delay_minutes > 0) {
    trafficText = `⚠️ +${sec.delay_minutes}m corridor delay (${sec.description})`;
    isWarn = true;
  } else {
    const nearbyInc = incidents.find((i) => {
      const c = i.geometry?.type === "Point" ? (i.geometry.coordinates as number[]) : (i.geometry?.coordinates as number[][])?.[0];
      if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return false;
      const distKm = Math.hypot((c[0] - n.lon) * Math.cos((n.lat * Math.PI) / 180), c[1] - n.lat) * 111;
      return distKm < 35;
    });
    if (nearbyInc) {
      trafficText = `⚠️ ${nearbyInc.description} (${nearbyInc.delay_minutes}m delay)`;
      isWarn = true;
    }
  }

  return `
    <div class="hub-popup">
      <div class="hub-popup-header">
        <div class="hub-popup-title">
          <span class="hub-popup-dot"></span>
          <strong>${n.name}</strong>
        </div>
        <span class="hub-popup-badge ${n.type}">${n.type.toUpperCase()}</span>
      </div>
      <div class="hub-popup-body">
        <div class="hub-popup-row">
          <span class="hub-popup-icon">⏱️</span>
          <div>
            <div class="hub-popup-label">Time to Reach</div>
            <div class="hub-popup-val ${isHighlight ? "highlight" : ""}">${timeText}</div>
          </div>
        </div>
        <div class="hub-popup-row">
          <span class="hub-popup-icon">🚗</span>
          <div>
            <div class="hub-popup-label">Traffic Conditions</div>
            <div class="hub-popup-val ${isWarn ? "warn" : ""}">${trafficText}</div>
          </div>
        </div>
        <div class="hub-popup-row">
          <span class="hub-popup-icon">🌤️</span>
          <div>
            <div class="hub-popup-label">Local Weather</div>
            <div class="hub-popup-val">${wxText}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

export type BasemapId = "voyager" | "positron" | "osm";

export const BASEMAPS: Record<BasemapId, { name: string; spec: maplibregl.StyleSpecification | string }> = {
  voyager: {
    name: "OpenFreeMap Liberty",
    spec: "https://tiles.openfreemap.org/styles/liberty",
  },
  positron: {
    name: "OpenFreeMap Positron",
    spec: "https://tiles.openfreemap.org/styles/positron",
  },
  osm: {
    name: "OpenStreetMap",
    spec: {
      version: 8,
      sources: {
        "osm": {
          type: "raster",
          tiles: [`${BASE.replace(/\/$/, "")}/map-tiles/{z}/{x}/{y}.png`],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [
        {
          id: "map-background",
          type: "background",
          paint: { "background-color": "#e7eee7" },
        },
        {
          id: "osm-layer",
          type: "raster",
          source: "osm",
          minzoom: 0,
          maxzoom: 19,
        },
      ],
    },
  },
};

const HUB = "#1a3682", BRANCH = "#66738c", ROUTE = "#17765e";

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function popup(text: string) {
  return new maplibregl.Popup({ offset: 15, maxWidth: "280px" }).setText(text);
}


const EMPTY_ZONES: WeatherZone[] = [];
const EMPTY_HUB_NOTICES: HubRouteNotice[] = [];

export type LiveMapProps = Parameters<typeof OpenStreetMap>[0];

export function LiveMap(props: LiveMapProps) {
  const [backup, setBackup] = useState(false);
  if (GOOGLE_MAPS_KEY && !backup && !googleMapsRefused) return <GoogleLiveMap {...props} onFallback={() => setBackup(true)} />;
  return <>{backup && <div className="map-provider-switch">Backup map active. <button className="linkbtn" onClick={() => setBackup(false)}>Return to Google Maps</button></div>}<OpenStreetMap {...props} /></>;
}

function OpenStreetMap({
  demo = false,
  nodes,
  path,
  geometry,
  comparisonGeometry,
  completedGeometry,
  alternatives = [],
  showAlternatives = false,
  onSelect,
  routeWeather = [],
  trafficSections = [],
  hubNotices = EMPTY_HUB_NOTICES,
  onRefresh,
  sim,
  weatherZones = EMPTY_ZONES,
  plannedStart,
  plannedEnd,
  avoidanceStatus,
  onAddWeatherZone,
  onUpdateWeatherZone,
  onDeleteWeatherZone,
  onCancelWeatherZones,
}: {
  demo?: boolean;
  nodes: NetNode[];
  path: string[];
  geometry?: number[][] | null;
  comparisonGeometry?: number[][][] | null;
  completedGeometry?: number[][];
  alternatives?: RouteOption[];
  showAlternatives?: boolean;
  onSelect?: (i: number) => void;
  routeWeather?: LiveWeather[];
  trafficSections?: { geometry: number[][]; delay_minutes: number; description: string }[];
  hubNotices?: HubRouteNotice[];
  onRefresh?: () => void;
  sim?: SimView;
  weatherZones?: WeatherZone[];
  plannedStart?: string;
  plannedEnd?: string;
  avoidanceStatus?: RouteOption["avoidance_status"];
  onAddWeatherZone?: (zone: WeatherZoneInput) => Promise<void>;
  onUpdateWeatherZone?: (id: string, zone: WeatherZoneInput) => Promise<void>;
  onDeleteWeatherZone?: (id: string) => Promise<void>;
  onCancelWeatherZones?: (ids: string[]) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const loadedMap = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const weatherMarkers = useRef<maplibregl.Marker[]>([]);
  const incidentMarkers = useRef<maplibregl.Marker[]>([]);
  const truckMarker = useRef<maplibregl.Marker | null>(null);
  const blockMarker = useRef<maplibregl.Marker | null>(null);
  const currentHoverPopup = useRef<maplibregl.Popup | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const [webglAvailable] = useState(hasWebGL);
  const [fallback, setFallback] = useState(!webglAvailable);
  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const activeBasemap = useRef<BasemapId>("osm");
  const failedBasemaps = useRef(new Set<BasemapId>());
  const baseTileFailures = useRef({ count: 0, since: 0 });
  const [styleVersion, setStyleVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");

  const recoverBasemap = useCallback(() => {
    const failed = activeBasemap.current;
    if (failedBasemaps.current.has(failed)) return;
    failedBasemaps.current.add(failed);
    const next: BasemapId = failed === "osm" ? "voyager" : "osm";
    if (failedBasemaps.current.has(next)) {
      setError("Road-map providers unavailable. Showing the route without a basemap.");
      setFallback(true);
    } else {
      setError(`${BASEMAPS[failed].name} unavailable. Switched to ${BASEMAPS[next].name}.`);
      setBasemap(next);
    }
  }, []);

  const [wx, setWx] = useState(true);
  const [traffic, setTraffic] = useState(true);
  const [incidents, setIncidents] = useState(true);
  const [hubs, setHubs] = useState(true);
  const [offset, setOffset] = useState(-1);

  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyMsg, setKeyMsg] = useState("");
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);

  const saveTomTomKey = async (k: string) => {
    setKeySaving(true);
    setKeyMsg("");
    try {
      const res = await api.setTomTomKey(k);
      const s = await api.settings();
      setSettings(s);
      setKeyMsg(res.tomtom_configured ? "TomTom API key saved and activated!" : "Key cleared. Switched to Simulated Traffic.");
      setTick((t) => t + 1);
      onRefresh?.();
    } catch (err) {
      setKeyMsg(String(err));
    } finally {
      setKeySaving(false);
    }
  };

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const planned = useMemo(
    () => (geometry?.length ? geometry : path.flatMap((id) => { const n = byId.get(id); return n ? [[n.lon, n.lat]] : []; })),
    [geometry, path, byId]
  );
  // While a simulation is engaged the vehicle's actual path is what we draw.
  const coords = useMemo(
    () => (sim?.engaged && sim.activeCoords?.length ? sim.activeCoords : planned),
    [sim?.engaged, sim?.activeCoords, planned]
  );
  const coordKey = useMemo(() => JSON.stringify(coords), [coords]);
  const {data, loading, error: conditionsError} = useRouteMapConditions(planned, offset, tick, !demo);

  const fit = useCallback(() => {
    const m = map.current;
    if (!m) return;
    const frame = planned.length > 1 ? planned : coords;
    if (frame.length < 2) return;
    const b = new maplibregl.LngLatBounds();
    frame.forEach((p) => b.extend([p[0], p[1]]));
    // Avoid intermediate zoom tiles when switching between distant route options.
    m.fitBounds(b, { padding: 45, maxZoom: 9, duration: 0 });
  }, [planned, coords]);

  // Fit bounds when route changes or map becomes ready, but never during simulation frame updates
  const lastFitted = useRef("");
  const pathKey = JSON.stringify([planned[0], planned[planned.length - 1]]);
  useEffect(() => {
    if (!ready || !map.current) return;
    if (lastFitted.current === pathKey) return;
    lastFitted.current = pathKey;
    fit();
  }, [ready, pathKey, fit]);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 120000);
    return () => clearInterval(timer);
  }, []);

  // MapLibre initialization
  useEffect(() => {
    if (fallback || !ref.current) return;
    setReady(false);
    loadedMap.current = null;
    activeBasemap.current = basemap;
    baseTileFailures.current = { count: 0, since: 0 };
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: ref.current,
        style: BASEMAPS[basemap].spec,
        center: [10.2, 51],
        zoom: 5,
        attributionControl: { compact: true },
      });
    } catch {
      setFallback(true);
      return;
    }
    map.current = m;

    m.on("style.load", () => {
      loadedMap.current = m;
      lastFitted.current = "";
      setReady(true);
      setStyleVersion((v) => v + 1);
    });

    m.on("error", (e) => {
      const message = String(e.error?.message ?? "");
      if (/traffic-tiles/.test(message)) {
        setError("Traffic layer unavailable. Road routes remain visible.");
        return;
      }
      const sourceId = (e as { sourceId?: string }).sourceId;
      const baseFailed = activeBasemap.current === "osm"
        ? sourceId === "osm" || /map-tiles/.test(message)
        : sourceId === "openmaptiles" || sourceId === "ne2_shaded" || /tiles\.openfreemap\.org/.test(message);
      const styleFailed = !sourceId && !m.isStyleLoaded() && /style|fetch|network/i.test(message);
      if (styleFailed) { recoverBasemap(); return; }
      if (!baseFailed && !(sourceId == null && /failed to fetch|network error/i.test(message))) return;
      const now = Date.now();
      if (now - baseTileFailures.current.since > 8000) baseTileFailures.current = { count: 0, since: now };
      if (++baseTileFailures.current.count >= 3) recoverBasemap();
    });

    m.addControl(new maplibregl.NavigationControl(), "top-right");
    m.addControl(new maplibregl.ScaleControl());

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      try { m.resize(); } catch {}
    }) : null;
    if (ref.current && ro) ro.observe(ref.current);

    return () => {
      ro?.disconnect();
      truckMarker.current?.remove(); truckMarker.current = null;
      blockMarker.current?.remove(); blockMarker.current = null;
      loadedMap.current = null;
      setReady(false);
      m.remove();
      map.current = null;
    };
  }, [fallback, recoverBasemap]);

  useEffect(() => {
    if (fallback || ready || !map.current) return;
    const timer = window.setTimeout(recoverBasemap, 10000);
    return () => window.clearTimeout(timer);
  }, [fallback, ready, basemap, recoverBasemap]);

  // Handle switching basemaps
  useEffect(() => {
    const m = map.current;
    if (!m || activeBasemap.current === basemap) return;
    try {
      activeBasemap.current = basemap;
      baseTileFailures.current = { count: 0, since: 0 };
      loadedMap.current = null;
      setReady(false);
      m.setStyle(BASEMAPS[basemap].spec, { diff: false });
    } catch {
      setError("Map style could not be changed. Try another style.");
    }
  }, [basemap]);

  // Vector sources and layers setup
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;

    if (!m.getSource("alternatives")) {
      m.addSource("alternatives", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "alternatives-line",
        type: "line",
        source: "alternatives",
        paint: { "line-color": "#82909c", "line-width": 5, "line-opacity": 0.45 },
      });
    }

    if (!m.getSource("weather-comparison")) {
      m.addSource("weather-comparison", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "weather-comparison-line", type: "line", source: "weather-comparison",
        paint: { "line-color": "#d86135", "line-width": 5, "line-opacity": 0.95, "line-dasharray": [2, 1.4] } });
    }

    if (!m.getSource("route")) {
      if (!m.getSource("completed-road")) {
        m.addSource("completed-road",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
        m.addLayer({id:"completed-road-line",type:"line",source:"completed-road",paint:{"line-color":"#7f8a92","line-width":5,"line-opacity":.7}});
      }
      m.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "route-l",
        type: "line",
        source: "route",
        paint: { "line-color": ROUTE, "line-width": 5, "line-opacity": 0.95 },
      });
    }

    if (!m.getSource("abandoned")) {
      m.addSource("abandoned", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "abandoned-line",
        type: "line",
        source: "abandoned",
        paint: { "line-color": "#c0392b", "line-width": 4, "line-opacity": 0.55, "line-dasharray": [1.5, 1.5] },
      });
    }

    if (!m.getSource("traffic-sections")) {
      m.addSource("traffic-sections", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "traffic-sections-line",
        type: "line",
        source: "traffic-sections",
        paint: { "line-color": "#de7043", "line-width": 7 },
      });
    }

    const click = (e: maplibregl.MapLayerMouseEvent) => {
      const i = Number(e.features?.[0]?.properties?.index);
      if (Number.isInteger(i)) onSelectRef.current?.(i);
    };

    const sectionClick = (e: maplibregl.MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties;
      popup(`${p?.description ?? "Traffic"} · ${p?.delay ?? 0} minutes provider traffic impact (included in ETA)`)
        .setLngLat(e.lngLat)
        .addTo(m);
    };

    m.on("click", "alternatives-line", click);
    m.on("click", "traffic-sections-line", sectionClick);

    return () => {
      m.off("click", "alternatives-line", click);
      m.off("click", "traffic-sections-line", sectionClick);
    };
  }, [ready, styleVersion]);

  // Update route geometry
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    const src = m.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData({
        type: "FeatureCollection",
        features: coords.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }] : [],
      });
    }
  }, [ready, styleVersion, coordKey, coords]);

  // Update alternative route geometries
  const altKey = useMemo(
    () => alternatives.map((o) => (o.quote_id || "") + (o.path?.join("-") || "")).join("|"),
    [alternatives]
  );
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    const alt = m.getSource("alternatives") as maplibregl.GeoJSONSource | undefined;
    if (alt) {
      const features = (showAlternatives ? alternatives : [])
        .filter((o) => o.geometry?.length)
        .map((o) => ({
          type: "Feature" as const,
          properties: { index: alternatives.indexOf(o) },
          geometry: { type: "LineString" as const, coordinates: o.geometry! },
        }));
      alt.setData({ type: "FeatureCollection", features });
    }
  }, [ready, styleVersion, altKey, alternatives, showAlternatives]);

  const comparisonKey = useMemo(() => JSON.stringify(comparisonGeometry ?? []), [comparisonGeometry]);
  useEffect(()=>{
    const m=map.current;if(!m||!ready||loadedMap.current!==m)return;
    const source=m.getSource("completed-road") as maplibregl.GeoJSONSource|undefined;
    source?.setData({type:"FeatureCollection",features:completedGeometry&&completedGeometry.length>1?[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:completedGeometry}}]:[]});
  },[ready,styleVersion,completedGeometry]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    const source = m.getSource("weather-comparison") as maplibregl.GeoJSONSource | undefined;
    if (source) source.setData({ type: "FeatureCollection", features: (comparisonGeometry ?? []).filter(line => line.length > 1).map((line, index) => ({
      type: "Feature" as const, properties: { index }, geometry: { type: "LineString" as const, coordinates: line },
    })) });
  }, [ready, styleVersion, comparisonKey, comparisonGeometry]);

  // Update abandoned leg geometry for simulation reroute
  const ghostKey = useMemo(() => JSON.stringify(sim?.ghostCoords ?? []), [sim?.ghostCoords]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    const ghostSource = m.getSource("abandoned") as maplibregl.GeoJSONSource | undefined;
    if (ghostSource) {
      ghostSource.setData({
        type: "FeatureCollection",
        features: sim?.ghostCoords && sim.ghostCoords.length > 1 ? [{
          type: "Feature" as const,
          properties: {},
          geometry: { type: "LineString" as const, coordinates: sim.ghostCoords },
        }] : [],
      });
    }
  }, [ready, styleVersion, ghostKey, sim?.ghostCoords]);

  // Update traffic sections geometry
  const trafficKey = useMemo(() => JSON.stringify(trafficSections ?? []), [trafficSections]);
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    const sectionSource = m.getSource("traffic-sections") as maplibregl.GeoJSONSource | undefined;
    if (sectionSource) {
      sectionSource.setData({
        type: "FeatureCollection",
        features: (trafficSections ?? [])
          .filter((s) => s.geometry.length > 1)
          .map((s) => ({
            type: "Feature" as const,
            properties: { delay: s.delay_minutes, description: s.description },
            geometry: { type: "LineString" as const, coordinates: s.geometry },
          })),
      });
    }
  }, [ready, styleVersion, trafficKey, trafficSections]);

  // Weather forecasts along the route or general map conditions
  const forecasts = offset === -1 && routeWeather.length ? routeWeather : data?.weather ?? [];
  const forecastsKey = useMemo(
    () => forecasts.map((w) => `${w.id}:${w.condition}:${w.temperature_c}`).join("|"),
    [forecasts]
  );

  // Facilities / Hub markers with interactive hover dialog
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    currentHoverPopup.current?.remove();
    currentHoverPopup.current = null;
    if (!hubs) return;
    const onPath = new Set(path);
    markers.current = nodes.map((n) => {
      const el = document.createElement("button");
      el.setAttribute("aria-label", `${n.name} facility`);
      el.className = `facility-marker ${onPath.has(n.id) ? "on-route" : ""}`;

      const popupHtml = buildHubPopupHtml(
        n,
        path,
        alternatives,
        forecasts,
        trafficSections,
        data?.incidents.items ?? [],
        !!data?.traffic_configured
      );

      const pop = new maplibregl.Popup({
        offset: 14,
        maxWidth: "310px",
        closeButton: false,
        closeOnClick: false,
        className: "hub-hover-popup",
      }).setHTML(popupHtml);

      el.addEventListener("mouseenter", () => {
        currentHoverPopup.current?.remove();
        currentHoverPopup.current = pop;
        pop.setLngLat([n.lon, n.lat]).addTo(m);
      });
      el.addEventListener("mouseleave", () => {
        pop.remove();
        if (currentHoverPopup.current === pop) {
          currentHoverPopup.current = null;
        }
      });
      el.addEventListener("click", () => {
        currentHoverPopup.current?.remove();
        currentHoverPopup.current = pop;
        pop.setLngLat([n.lon, n.lat]).addTo(m);
      });

      return new maplibregl.Marker({ element: el })
        .setLngLat([n.lon, n.lat])
        .addTo(m);
    });
  }, [ready, nodes, path, hubs, alternatives, forecastsKey, trafficKey, data]);

  const hubNoticesKey = JSON.stringify(hubNotices);
  // Keep pins and open popups when polling returns identical operational records.
  useEffect(() => {
    const m = map.current;
    if (!ready || fallback || !m || loadedMap.current !== m) return;
    const pins = hubNotices.map(notice => new maplibregl.Marker({element:hubNoticeMarker(notice),anchor:"bottom",offset:[0,-16]})
      .setLngLat([notice.node.lon,notice.node.lat])
      .setPopup(new maplibregl.Popup({offset:35,maxWidth:"330px",className:"hub-event-popup"}).setText(`${notice.node.name} · ${notice.title}\n${hubNoticeDetails(notice,dt).join("\n")}`))
      .addTo(m));
    return () => pins.forEach(pin => pin.remove());
  }, [ready, fallback, hubNoticesKey]);

  // Weather markers
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    weatherMarkers.current.forEach((x) => x.remove());
    weatherMarkers.current = [];
    if (!wx) return;
    const unique = new Map(forecasts.map((w) => [w.id, w]));
    weatherMarkers.current = [...unique.values()].map((w) => {
      const el = document.createElement("button");
      el.className = `weather-marker wx-${w.level ?? "unknown"}`;
      el.textContent = w.condition?.includes("Snow") ? "❄" : w.condition?.includes("Rain") ? "☂" : w.condition === "Clear" ? "☀" : "☁";
      el.title = `${w.condition ?? w.status} · ${w.temperature_c ?? "—"}°C`;
      return new maplibregl.Marker({ element: el, offset: [0, -20] })
        .setLngLat([w.lon, w.lat])
        .setPopup(popup(`${w.source} · ${w.status}
${w.condition ?? "Forecast unavailable"} · ${w.temperature_c ?? "—"}°C
Wind ${w.wind_kmh ?? "—"} km/h · visibility ${w.visibility_m ?? "—"} m
Valid ${dt(w.valid_at)}
Retrieved ${dt(w.fetched_at)}
Weather impact rule: +${w.delay_minutes ?? 0}m (estimate)`))
        .addTo(m);
    });
  }, [ready, forecastsKey, wx, forecasts]);

  // Incidents & Traffic Flow
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    incidentMarkers.current.forEach((x) => x.remove());
    incidentMarkers.current = [];
    if (traffic && incidents && offset <= 0 && data?.incidents.items.length) {
      const match = createRouteIncidentMatcher(planned);
      incidentMarkers.current = (data?.incidents.items ?? []).flatMap((i) => {
        const c = match(i);
        if (!c) return [];
        const el = document.createElement("button");
        el.className = "incident-marker";
        el.textContent = "!";
        el.title = i.description;
        return [new maplibregl.Marker({ element: el })
          .setLngLat(c)
          .setPopup(popup(`${i.description}\n${i.delay_minutes}m reported delay · ${i.source}\nCurrent incident near route; exact impact comes from routing.`))
          .addTo(m)];
      });
    }
    // TomTom's flow tiles cover the full viewport. Show only traffic sections
    // returned with the selected route, so nearby roads stay visually clear.
    if (m.getLayer("traffic-flow-layer")) m.removeLayer("traffic-flow-layer");
    if (m.getSource("traffic-flow")) m.removeSource("traffic-flow");
    if (m.getLayer("traffic-sections-line")) {
      m.setLayoutProperty("traffic-sections-line", "visibility", traffic && offset <= 0 ? "visible" : "none");
    }
  }, [ready, styleVersion, data, traffic, incidents, offset, planned]);

  // The map reads the replay clock directly, independently of React's readouts.
  const pausedTruck = sim?.running ? null : sim?.truck;
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    if (!sim?.engaged || !sim.sampleTruck) {
      truckMarker.current?.remove();
      truckMarker.current = null;
      return;
    }
    const first = sim.sampleTruck();
    if (!first) return;
    if (!truckMarker.current) {
      const el = document.createElement("div");
      el.className = "truck-marker";
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "Simulated freight truck");
      el.setAttribute("title", "Simulated freight vehicle");
      el.innerHTML = TRUCK_GLYPH;
      truckMarker.current = new maplibregl.Marker({ element: el, rotationAlignment: "map" })
        .setLngLat(first.position)
        .setRotation(first.bearing)
        .addTo(m);
    }
    let frame = 0;
    let last = performance.now();
    let heading = truckMarker.current.getRotation();
    const draw = (now: number) => {
      const sample = sim.sampleTruck();
      const marker = truckMarker.current;
      if (!sample || !marker || loadedMap.current !== m) return;
      const [lon, lat] = sample.position;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      const elapsed = Math.min(100, Math.max(1, now - last));
      last = now;
      const turn = ((sample.bearing - heading + 540) % 360 + 360) % 360 - 180;
      heading += turn * (1 - Math.exp(-elapsed / 80));
      marker.setLngLat([lon, lat]).setRotation(heading);
      marker.getElement().classList.toggle("is-moving", sample.moving);
      // A fixed map orientation avoids camera spins on tight road bends.
      if (sim.followTruck) m.jumpTo({ center: [lon, lat] });
      if (sim.running || Math.abs(turn) > 0.25) frame = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => cancelAnimationFrame(frame);
  }, [ready, styleVersion, sim?.engaged, sim?.sampleTruck, sim?.running, sim?.followTruck, pausedTruck]);

  // Blockage marker
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || loadedMap.current !== m) return;
    blockMarker.current?.remove();
    blockMarker.current = null;
    if (!sim?.blockage) return;
    const [lon, lat] = sim.blockage.position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const el = document.createElement("button");
    el.className = "blockage-marker";
    el.textContent = "⛔";
    el.title = sim.blockage.reason;
    blockMarker.current = new maplibregl.Marker({ element: el })
      .setLngLat([lon, lat])
      .setPopup(popup(`${sim.blockage.reason}\nSimulated obstruction · not a provider incident`))
      .addTo(m);
  }, [ready, sim?.blockage]);

  useEffect(() => () => {
    truckMarker.current?.remove();
    blockMarker.current?.remove();
  }, []);

  const refresh = () => {
    setTick((t) => t + 1);
    onRefresh?.();
  };

  return (
    <div className="live-map-shell" ref={shell}>
      <div className="live-controls">
        <div className="layer-toggles">
          {[
            ["Weather", wx, setWx, CloudSun],
            ["Traffic", traffic, setTraffic, Car],
          ].map(([label, enabled, setter, Icon]) => {
            const I = Icon as typeof CloudSun;
            return (
              <button
                key={String(label)}
                disabled={demo && label !== "Hubs"}
                aria-pressed={enabled as boolean}
                onClick={() => (setter as (v: boolean) => void)(!enabled)}
              >
                <I size={13} />
                {String(label)}
              </button>
            );
          })}
          <details className="map-settings" open>
            <summary>Map settings</summary>
            <div className="map-settings-menu">
              {([
                ["Incidents", incidents, setIncidents, TriangleAlert],
                ["Hubs", hubs, setHubs, LocateFixed],
              ] as const).map(([label, enabled, setter, Icon]) => (
                <button key={label} aria-pressed={enabled} onClick={() => setter(!enabled)}>
                  <Icon size={13} />{label}
                </button>
              ))}
          <div className="basemap-selector" style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 2 }}>
            <span style={{ fontSize: "11px", color: "var(--muted)", fontWeight: 600 }}>Map:</span>
            <select
              aria-label="Basemap style"
              value={basemap}
              onChange={(e) => {
                const next = e.target.value as BasemapId;
                failedBasemaps.current.delete(next);
                setError("");
                setBasemap(next);
              }}
              style={{ fontSize: "11px", padding: "3px 6px", borderRadius: 6, border: "1px solid var(--line)", background: "#fff", color: "var(--text)", fontWeight: 600 }}
            >
              <option value="osm">OpenStreetMap</option>
              <option value="voyager">OpenFreeMap Liberty (Detailed)</option>
              <option value="positron">OpenFreeMap Positron (Light)</option>
            </select>
          </div>
          <button
            className={`key-btn ${settings?.tomtom_configured ? "key-btn--active" : "key-btn--sim"}`}
            onClick={() => {
              setShowKeyModal(true);
              setKeyInput("");
              setKeyMsg("");
            }}
            title={settings?.tomtom_configured ? "TomTom Live Key Active · Click to edit" : "Simulated Traffic active · Click to add real TomTom key"}
          >
            <Key size={13} />
            {settings?.tomtom_configured ? "TomTom: Live" : "Traffic: Simulated (Add Key)"}
          </button>
            </div>
          </details>
        </div>
        <div className="map-actions">
          <button aria-label="Fit route" onClick={fit}><LocateFixed size={15} /></button>
          <button
            aria-label="Fullscreen map"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else void shell.current?.requestFullscreen().catch(() => setError("Fullscreen is unavailable in this browser"));
            }}
          >
            <Expand size={15} />
          </button>
          <button disabled={loading || demo} aria-label="Refresh live conditions and ETA" onClick={refresh}>
            <RefreshCw size={15} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>
      {demo && <div className="map-note">DEMO · Captured road geometry and illustrative timings. Live weather and traffic overlays disabled.</div>}
      <div className="forecast-controls">
        <label>
          Weather preview
          <select aria-label="Weather forecast time" disabled={demo} value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
            <option value={-1}>At planned passage</option>
            <option value={0}>Now</option>
            <option value={3}>In 3 hours</option>
            <option value={6}>In 6 hours</option>
            <option value={12}>In 12 hours</option>
          </select>
        </label>
        <span>
          {loading ? "Fetching conditions…" : `Updated ${data ? dt(data.fetched_at) : "—"}`}
          <small>{demo ? "Demo replay · live overlays disabled" : offset > 0 ? "Future weather · traffic hidden" : `Traffic ${data?.traffic_configured ? "live" : "simulated"} · weather forecast`}</small>
        </span>
      </div>
      <MapWeatherSimulation mapRef={map} mapContainerRef={ref} ready={ready} styleVersion={styleVersion}
        fallback={fallback} demo={demo} routeCoords={planned} weatherZones={weatherZones}
        plannedStart={plannedStart} plannedEnd={plannedEnd} avoidanceStatus={avoidanceStatus}
        onAddWeatherZone={onAddWeatherZone} onUpdateWeatherZone={onUpdateWeatherZone} onDeleteWeatherZone={onDeleteWeatherZone}
        onCancelWeatherZones={onCancelWeatherZones}>
        {fallback ? <Fallback nodes={nodes} path={path} geometry={geometry} sim={sim} hubNotices={hubNotices}/> : <div ref={ref} className="maplibre" />}
      </MapWeatherSimulation>
      <div className="map-legend">
        <span><i style={{ background: "#17765e" }} /> Selected route</span>
        {showAlternatives&&<span><i style={{ background: "#82909c" }} /> Alternatives · click to compare</span>}
        {!!comparisonGeometry?.length && <span><i className="legend-dash" style={{ background: "#d86135" }} /> Weather-affected segment</span>}
        <span><i style={{ background: "#de7043" }} /> Traffic impact</span>
        {weatherZones.length > 0 && <span><i style={{ background: "#d15e7d" }} /> Simulated weather zone</span>}
        {sim?.ghostCoords && <span><i className="legend-dash" style={{ background: "#c0392b" }} /> Abandoned leg</span>}
      </div>
      {data?.incidents.status === "ERROR" && <div className="map-note">Traffic incidents could not be refreshed. Coverage may be incomplete.</div>}
      {fallback && webglAvailable && <div className="map-note">Road-map tiles are temporarily unavailable. <button className="linkbtn" onClick={() => { failedBasemaps.current.clear(); baseTileFailures.current = { count: 0, since: 0 }; setBasemap("osm"); setError(""); setFallback(false); }}>Retry road map</button></div>}
      {error && !(fallback && webglAvailable) && <div role="alert" className="map-note">{error}</div>}
      {conditionsError && <div role="status" className="map-note">Weather and traffic could not refresh: {conditionsError}</div>}
      <HubEventSummary notices={hubNotices}/>
      <RouteWeatherReadout forecasts={forecasts}/>
      {showKeyModal && (
        <div className="key-modal-overlay" onClick={() => setShowKeyModal(false)}>
          <div className="key-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3>TomTom Traffic Configuration</h3>
              <button className="sim-ghost" onClick={() => setShowKeyModal(false)}><X size={16} /></button>
            </div>
            <p>
              The platform uses TomTom for live truck-specific routing, raster flow tiles, and incident feeds. Without an API key, the platform operates in <b>Simulated Traffic Mode</b> (realistic congestion on A81/A6 corridors).
            </p>
            <label style={{ display: "block", fontSize: "11.5px", fontWeight: 700, marginBottom: 6 }}>TomTom API Key</label>
            <input
              type="password"
              placeholder={settings?.tomtom_configured ? `Current key: ${settings.tomtom_masked}` : "Paste your TomTom API key here..."}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            {keyMsg && <div style={{ fontSize: "12px", marginBottom: 12, color: keyMsg.includes("!") ? "var(--ok)" : "var(--bad)" }}>{keyMsg}</div>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <a href="https://developer.tomtom.com" target="_blank" rel="noreferrer" style={{ fontSize: "11px", display: "inline-flex", alignItems: "center", gap: 4, color: "var(--blue)" }}>
                Get free key at developer.tomtom.com <ExternalLink size={12} />
              </a>
              <div className="key-modal-actions">
                {settings?.tomtom_configured && (
                  <button className="btn btn--sm btn--ghost" disabled={keySaving} onClick={() => void saveTomTomKey("")}>
                    Clear Key (Use Simulation)
                  </button>
                )}
                <button className="btn btn--sm btn--mint" disabled={keySaving || !keyInput.trim()} onClick={() => void saveTomTomKey(keyInput.trim())}>
                  {keySaving ? "Saving…" : "Save & Activate"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Fallback({
  nodes,
  path,
  geometry,
  sim,
  hubNotices,
}: {
  nodes: NetNode[];
  path: string[];
  geometry?: number[][] | null;
  sim?: SimView;
  hubNotices: HubRouteNotice[];
}) {
  const W = 760, H = 360, P = 30;
  const lons = nodes.map((n) => n.lon), lats = nodes.map((n) => n.lat);
  const lo0 = Math.min(...lons), lo1 = Math.max(...lons), la0 = Math.min(...lats), la1 = Math.max(...lats);
  const X = (lon: number) => P + ((lon - lo0) / (lo1 - lo0 || 1)) * (W - 2 * P);
  const Y = (lat: number) => P + ((la1 - lat) / (la1 - la0 || 1)) * (H - 2 * P);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const onPath = new Set(path);

  const activePoints = sim?.engaged && sim.activeCoords?.length
    ? sim.activeCoords
    : (geometry && geometry.length > 1
      ? geometry
      : path.flatMap((id) => { const n = byId.get(id); return n ? [[n.lon, n.lat]] : []; }));

  return (
    <div className="mapwrap mapfallback">
      <div className="map-lbl">{geometry ? "Basemap offline · actual road geometry retained" : "Basemap offline · schematic connection (not a road route)"}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%" }}>
        {activePoints.length > 1 && (
          <polyline fill="none" stroke={ROUTE} strokeWidth={3} points={activePoints.map(([lon, lat]) => `${X(lon)},${Y(lat)}`).join(" ")} />
        )}
        {sim?.ghostCoords && sim.ghostCoords.length > 1 && (
          <polyline fill="none" stroke="#c0392b" strokeWidth={3} strokeDasharray="4 4" points={sim.ghostCoords.map(([lon, lat]) => `${X(lon)},${Y(lat)}`).join(" ")} />
        )}
        {nodes.map((n) => {
          const x = X(n.lon), y = Y(n.lat), isHub = n.type === "hub", hot = onPath.has(n.id);
          return isHub
            ? <rect key={n.id} x={x - 6} y={y - 6} width={12} height={12} rx={2} fill={HUB} />
            : <circle key={n.id} cx={x} cy={y} r={hot ? 5 : 3.5} fill={hot ? ROUTE : "#fff"} stroke={hot ? ROUTE : BRANCH} strokeWidth={1.8} />;
        })}
        {nodes.filter((n) => n.type === "hub" || onPath.has(n.id)).map((n) => (
          <text key={n.id + "t"} x={X(n.lon) + 8} y={Y(n.lat) + 3} fontSize={10} fontWeight={700} fill="#334">{n.name}</text>
        ))}
        {hubNotices.map(notice => <g key={notice.node.id} role="img" aria-label={`${notice.node.name}: ${notice.title}`} transform={`translate(${X(notice.node.lon)},${Y(notice.node.lat)-24})`}>
          <title>{hubNoticeDetails(notice,dt).join("\n")}</title>
          <rect x={-55} y={-13} width={110} height={22} rx={5} fill={notice.kind==="closure"?"#aa4438":notice.kind==="delay"?"#94641e":"#526c61"}/>
          <text textAnchor="middle" y={2} fill="#fff" fontSize={10} fontWeight={700}>{notice.title}</text>
        </g>)}
        {sim?.blockage && (
          <g transform={`translate(${X(sim.blockage.position[0]) - 8}, ${Y(sim.blockage.position[1]) - 8})`}>
            <circle cx={8} cy={8} r={9} fill="#c0392b" />
            <text x={8} y={12} textAnchor="middle" fill="#fff" fontSize={11} fontWeight={900}>⛔</text>
          </g>
        )}
        {sim?.engaged && sim?.truck && (
          <g transform={`translate(${X(sim.truck.position[0])}, ${Y(sim.truck.position[1])}) rotate(${Math.round(sim.truck.bearing)})`}>
            <circle cx={0} cy={0} r={13} fill="#fff" stroke="#17765e" strokeWidth={1.5} />
            <rect x={-4} y={-10} width={8} height={6} rx={1.5} fill="#fbd33b" stroke="#173e37" />
            <rect x={-4} y={-3} width={8} height={13} rx={1} fill="#e4efe8" stroke="#173e37" />
          </g>
        )}
      </svg>
    </div>
  );
}
