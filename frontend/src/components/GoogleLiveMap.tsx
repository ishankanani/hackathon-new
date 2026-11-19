import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { Car, CloudSun, Expand, LocateFixed, RefreshCw } from "lucide-react";
import { dt, hm } from "../lib";
import type { LiveMapProps } from "./LiveMap";
import { loadGoogleMaps, GOOGLE_MAP_ID } from "./googleMapsApi";
import { googleMarker, googlePath, googlePosition, googleWeatherSurface } from "./googleWeatherSurface";
import type { WeatherMapSurface } from "./WeatherMapSurface";
import { MapWeatherSimulation } from "./MapWeatherSimulation";
import { createRouteIncidentMatcher, alternativeColor, alternativeLabelPoint } from "./mapRouteGeometry";
import { useRouteMapConditions } from "./useRouteMapConditions";
import { TRUCK_GLYPH } from "./truckGlyph";
import { RouteWeatherReadout } from "./RouteWeatherReadout";
import { HubEventSummary } from "./HubEventSummary";
import { hubNoticeDetails, hubNoticeMarker } from "./routeHubEvents";
import "../google-maps.css";

const EMPTY: never[] = [];
function information(title: string, lines: string[]) {
  const card = document.createElement("div"); card.className = "google-map-information";
  const heading = document.createElement("strong"); heading.textContent = title; card.append(heading);
  lines.filter(Boolean).forEach(text => { const p = document.createElement("p"); p.textContent = text; card.append(p); });
  return card;
}

export function GoogleLiveMap({ nodes, path, geometry, completedGeometry = EMPTY, comparisonGeometry,
  alternatives = EMPTY, showAlternatives = false, onSelect, routeWeather = EMPTY, trafficSections = EMPTY, hubNotices = EMPTY, sim, demo = false,
  weatherZones = EMPTY, plannedStart, plannedEnd, avoidanceStatus, onAddWeatherZone, onUpdateWeatherZone,
  onDeleteWeatherZone, onCancelWeatherZones, onRefresh, onFallback,
}: LiveMapProps & { onFallback: () => void }) {
  const container = useRef<HTMLDivElement | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const map = useRef<google.maps.Map | null>(null);
  const unusedMapLibre = useRef<maplibregl.Map | null>(null);
  const sdk = useRef<typeof google.maps | null>(null);
  const info = useRef<google.maps.InfoWindow | null>(null);
  const selectedLine = useRef<google.maps.Polyline | null>(null);
  const facilities = useRef(new Map<string, {button: HTMLButtonElement; marker: google.maps.marker.AdvancedMarkerElement}>());
  const [surface, setSurface] = useState<WeatherMapSurface | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState(0);
  const [tick, setTick] = useState(0);
  const [weather, setWeather] = useState(true);
  const [traffic, setTraffic] = useState(true);
  const [hubs, setHubs] = useState(true);
  const [incidents, setIncidents] = useState(true);
  const [mapType, setMapType] = useState("roadmap");
  const [offset, setOffset] = useState(-1);
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const planned = useMemo(() => geometry?.length ? geometry : path.flatMap(id => { const n = byId.get(id); return n ? [[n.lon, n.lat]] : []; }), [geometry, path, byId]);
  const coords = sim?.engaged && sim.activeCoords?.length ? sim.activeCoords : planned;
  const cameraKey = JSON.stringify([planned[0], planned[planned.length - 1]]);
  const hubNoticesKey = JSON.stringify(hubNotices);
  const {data, loading, error: conditionsError} = useRouteMapConditions(planned, offset, tick, !demo);
  const forecasts = offset === -1 && routeWeather.length ? routeWeather : data?.weather ?? EMPTY;
  const facilityContext = useRef({path, alternatives, forecasts});
  facilityContext.current = {path, alternatives, forecasts};
  const choose = useRef(onSelect); choose.current = onSelect;
  const fallback = useRef(onFallback); fallback.current = onFallback;
  const lastFit = useRef("");

  useEffect(() => {
    let alive = true;
    setReady(false); lastFit.current = "";
    let dispose = () => {};
    // Google rejected the key: its map is unusable and drawing markers on it crashes
    // the page, so switch to the built-in map straight away.
    const authError = (event: Event) => { alive = false; setReady(false); setError((event as CustomEvent<string>).detail); dispose(); fallback.current(); };
    window.addEventListener("dachser-google-maps-error", authError);
    loadGoogleMaps().then(maps => {
      if (!alive || !container.current) return;
      sdk.current = maps;
      const native = new maps.Map(container.current, { center: { lat: 51, lng: 10.2 }, zoom: 5, mapId: GOOGLE_MAP_ID,
        mapTypeId: "roadmap", streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
        gestureHandling: "cooperative", rotateControl: false, tilt: 0, clickableIcons: false, scaleControl: true });
      map.current = native;
      info.current = new maps.InfoWindow();
      const adapter = googleWeatherSurface(maps, native, () => { if (alive) setReady(true); });
      setSurface(adapter.surface);
      const observer = new ResizeObserver(entries => { if (entries[0]?.contentRect.width > 0 && entries[0]?.contentRect.height > 0) { maps.event.trigger(native, "resize"); setLayout(v => v + 1); } });
      observer.observe(container.current);
      dispose = () => { observer.disconnect(); adapter.dispose(); info.current?.close(); maps.event.clearInstanceListeners(native); map.current = null; };
    }).catch(e => { if (alive) setError(String(e).replace(/^Error:\s*/, "")); });
    return () => { alive = false; window.removeEventListener("dachser-google-maps-error", authError); dispose(); };
  }, []);

  const fit = useCallback(() => {
    const native = map.current, maps = sdk.current;
    if (!native || !maps || planned.length < 2) return;
    const bounds = new maps.LatLngBounds();
    [planned, ...(showAlternatives ? alternatives : EMPTY).flatMap(o => o.geometry?.length ? [o.geometry] : [])].forEach(road => googlePath(road).forEach(point => bounds.extend(point)));
    native.fitBounds(bounds, 42);
    maps.event.addListenerOnce(native, "idle", () => { if ((native.getZoom() ?? 5) > 10) native.setZoom(10); });
  }, [planned, alternatives, showAlternatives]);
  useEffect(() => {
    if (ready && container.current?.clientWidth && lastFit.current !== cameraKey) { lastFit.current = cameraKey; fit(); }
  }, [ready, cameraKey, fit, layout]);
  useEffect(() => { map.current?.setMapTypeId(mapType); }, [mapType, ready]);

  useEffect(() => { const timer = window.setInterval(() => { if (!document.hidden && container.current?.offsetParent) setTick(t => t + 1); }, 120000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    if (!ready || !map.current || !sdk.current) return;
    const line = new sdk.current.Polyline({map: map.current, strokeColor: "#17765e", strokeWeight: 6, strokeOpacity: 1, zIndex: 6, clickable: false});
    selectedLine.current = line;
    return () => { line.setMap(null); selectedLine.current = null; };
  }, [ready]);
  useEffect(() => { selectedLine.current?.setPath(googlePath(coords)); }, [ready, coords]);

  // Supporting lines can change independently of the selected road.
  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !maps || !native) return;
    const lines: google.maps.Polyline[] = [];
    const labels: google.maps.marker.AdvancedMarkerElement[] = [];
    function line(points: number[][], color: string, width: number, opacity: number, z: number, dashed = false) {
      if (points.length < 2) return null;
      const item = new maps!.Polyline({ map: native, path: googlePath(points), strokeColor: color, strokeWeight: width,
        strokeOpacity: dashed ? 0 : opacity, zIndex: z,
        icons: dashed ? [{ icon: { path: "M 0,-1 0,1", strokeColor: color, strokeOpacity: opacity, scale: 2 }, offset: "0", repeat: "12px" }] : undefined });
      lines.push(item); return item;
    }
    line(completedGeometry, "#7f8a92", 5, .7, 2);
    (showAlternatives ? alternatives : EMPTY).forEach((option, i) => {
      if (!option.geometry?.length || option.geometry === planned) return;
      line(option.geometry, "#ffffff", 13, .9, 2);
      const color = alternativeColor(i);
      const item = line(option.geometry, color, 9, .85, 3);
      item?.addListener("click", () => choose.current?.(i));
      const point = alternativeLabelPoint(option.geometry, planned);
      if (point) {
        const button = document.createElement("button"); button.className = "google-route-label";
        button.style.setProperty("--route-color", color); button.textContent = `${i + 1} · ${hm(option.total_minutes)}`;
        button.setAttribute("aria-label", `View route option ${i + 1}: ${option.label}`);
        button.addEventListener("click", () => choose.current?.(i));
        const marker = googleMarker(maps, native, googlePosition(point), button, button.getAttribute("aria-label")!);
        marker.zIndex = 40 + i; labels.push(marker);
      }
    });
    comparisonGeometry?.forEach(points => line(points, "#d86135", 5, .85, 4, true));
    if (traffic && offset <= 0) trafficSections.forEach(section => {
      const item = line(section.geometry, "#de7043", 7, 1, 7);
      item?.addListener("click", (event: google.maps.MapMouseEvent) => {
        info.current?.setContent(information("Traffic on this route", [section.description, `${section.delay_minutes} minutes · included in the route estimate`]));
        if (event.latLng) info.current?.setPosition(event.latLng); info.current?.open(native);
      });
    });
    if (sim?.ghostCoords) line(sim.ghostCoords, "#82909c", 4, .75, 5, true);
    return () => { lines.forEach(item => { maps.event.clearInstanceListeners(item); item.setMap(null); }); labels.forEach(marker => { marker.map = null; }); };
  }, [ready, planned, alternatives, showAlternatives, completedGeometry, comparisonGeometry, trafficSections, traffic, offset, sim?.ghostCoords]);

  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !hubs || !maps || !native) return;
    const pins = new Map<string, {button: HTMLButtonElement; marker: google.maps.marker.AdvancedMarkerElement}>();
    for (const node of nodes) {
      const title = `${node.name} facility`;
      const button = document.createElement("button");
      button.className = "facility-marker"; button.title = title; button.setAttribute("aria-label", title);
      const marker = googleMarker(maps, native, {lat: node.lat, lng: node.lon}, button, title);
      button.addEventListener("click", () => {
        const current = facilityContext.current;
        const option = current.alternatives.find(o => o.path === current.path);
        const step = option?.steps.find(s => s.location === node.id);
        const forecast = current.forecasts.find(w => w.id === node.id || w.name === node.name);
        info.current?.setContent(information(title, [
          current.path.includes(node.id) ? "On selected journey" : "Network facility",
          step ? `${step.type.replace(/_/g, " ")} · ${dt(step.start)}` : "",
          forecast ? `${forecast.condition ?? forecast.status} · ${forecast.temperature_c ?? "—"}°C` : "",
        ]));
        info.current?.open({map: native, anchor: marker, shouldFocus: false});
      });
      pins.set(node.id, {button, marker});
    }
    facilities.current = pins;
    return () => { pins.forEach(({marker}) => { marker.map = null; }); pins.clear(); };
  }, [ready, nodes, hubs]);

  useEffect(() => {
    const selected = new Set(path);
    facilities.current.forEach(({button, marker}, id) => {
      const onRoute = selected.has(id);
      button.classList.toggle("on-route", onRoute);
      marker.zIndex = onRoute ? 30 : 20;
    });
  }, [ready, nodes, path, hubs]);

  // Refresh forecast and incident markers without rebuilding the facility layer.
  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !maps || !native) return;
    const markers: google.maps.marker.AdvancedMarkerElement[] = [];
    function pin(point: number[], className: string, text: string, title: string, lines: string[]) {
      const button = document.createElement("button"); button.className = className; button.textContent = text; button.title = title; button.setAttribute("aria-label", title);
      const marker = googleMarker(maps!, native!, googlePosition(point), button, title);
      marker.zIndex = className.includes("on-route") ? 30 : 20;
      button.addEventListener("click", () => { info.current?.setContent(information(title, lines)); info.current?.open({ map: native, anchor: marker, shouldFocus: false }); });
      markers.push(marker); return marker;
    }
    if (weather) [...new Map(forecasts.map(w => [w.id, w])).values()].forEach(w => pin([w.lon, w.lat], `weather-marker wx-${w.level ?? "unknown"}`,
      /snow/i.test(w.condition ?? "") ? "❄" : /rain/i.test(w.condition ?? "") ? "☂" : w.condition === "Clear" ? "☀" : "☁",
      `${w.condition ?? w.status} · ${w.temperature_c ?? "—"}°C`, [`${w.source} · ${w.status}`, `Wind ${w.wind_kmh ?? "—"} km/h`, `Forecast for ${dt(w.valid_at)}`, `Estimated weather impact: +${w.delay_minutes ?? 0} min`]));
    if (traffic && incidents && offset <= 0 && data?.incidents.items.length) {
      const shown: google.maps.Point[] = [];
      let count = 0;
      const match = createRouteIncidentMatcher(planned);
      for (const incident of [...data.incidents.items].sort((a, b) => b.delay_minutes - a.delay_minutes)) {
        const point = match(incident); if (!point) continue;
        const pixel = surface?.project([point[0], point[1]]);
        if (pixel && shown.some(p => Math.hypot(p.x - pixel.x, p.y - pixel.y) < 28)) continue;
        if (pixel) shown.push(new maps.Point(pixel.x, pixel.y));
        pin(point, "incident-marker", "!", incident.description, [`${incident.delay_minutes} min reported delay · ${incident.source}`, "Current incident near the selected road. Routing determines its ETA impact."]);
        if (++count >= 16) break;
      }
    }
    return () => markers.forEach(marker => { maps.event.clearInstanceListeners(marker); marker.map = null; });
  }, [ready, forecasts, weather, traffic, incidents, offset, data, planned, surface]);

  // Manager notices remain visible independently of weather/traffic layer toggles.
  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !maps || !native) return;
    const markers = hubNotices.map(notice => {
      const button = hubNoticeMarker(notice);
      const marker = googleMarker(maps, native, {lat:notice.node.lat,lng:notice.node.lon}, button, button.title);
      marker.zIndex = 90; marker.anchorTop = "calc(-100% - 16px)";
      marker.collisionBehavior = maps.CollisionBehavior.REQUIRED;
      button.addEventListener("click", () => {
        info.current?.setContent(information(`${notice.node.name} · ${notice.title}`, hubNoticeDetails(notice, dt)));
        info.current?.open({map:native,anchor:marker,shouldFocus:false});
      });
      return marker;
    });
    return () => { info.current?.close(); markers.forEach(marker => { maps.event.clearInstanceListeners(marker); marker.map = null; }); };
  }, [ready, hubNoticesKey]);

  // Sample the same replay clock as the planner; Google owns geographic placement.
  const pausedTruck = sim?.running ? null : sim?.truck;
  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !maps || !native || !sim?.engaged) return;
    const first = sim.sampleTruck(); if (!first) return;
    const element = document.createElement("div"); element.className = "truck-marker"; element.innerHTML = TRUCK_GLYPH;
    const marker = googleMarker(maps, native, googlePosition(first.position), element, "Simulated freight truck"); marker.zIndex = 100;
    let frame = 0, last = performance.now(), heading = first.bearing;
    const draw = (now: number) => {
      const sample = sim.sampleTruck(); if (!sample) return;
      const elapsed = Math.min(100, Math.max(1, now - last)); last = now;
      const turn = ((sample.bearing - heading + 540) % 360 + 360) % 360 - 180;
      heading += turn * (1 - Math.exp(-elapsed / 80));
      marker.position = googlePosition(sample.position);
      element.style.transform = `rotate(${heading}deg)`;
      element.classList.toggle("is-moving", sample.moving);
      if (sim.followTruck) native.setCenter(googlePosition(sample.position));
      if (sim.running || Math.abs(turn) > .25) frame = requestAnimationFrame(draw);
    };
    draw(performance.now());
    return () => { cancelAnimationFrame(frame); marker.map = null; };
  }, [ready, sim?.engaged, sim?.sampleTruck, sim?.running, sim?.followTruck, pausedTruck]);

  useEffect(() => {
    const maps = sdk.current, native = map.current;
    if (!ready || !maps || !native || !sim?.blockage) return;
    const button = document.createElement("button"); button.className = "blockage-marker"; button.textContent = "⛔"; button.title = sim.blockage.reason;
    const marker = googleMarker(maps, native, googlePosition(sim.blockage.position), button, sim.blockage.reason); marker.zIndex = 60;
    return () => { marker.map = null; };
  }, [ready, sim?.blockage]);

  return <div className="live-map-shell google-live-map" ref={shell}>
    <section className="organized-map-controls" aria-label="Map display and conditions">
      <div className="organized-map-heading">
        <div className="organized-map-title"><strong>Google Maps</strong><div className="organized-layer-toggles">
          <button aria-pressed={weather} disabled={demo} onClick={() => setWeather(v => !v)}><CloudSun size={13}/>Weather</button>
          <button aria-pressed={traffic} disabled={demo} onClick={() => setTraffic(v => !v)}><Car size={13}/>Traffic</button>
        </div></div>
        <div className="organized-map-actions">
          <button aria-label="Fit route" title="Fit selected route" onClick={fit}><LocateFixed size={15}/></button>
          <button aria-label="Fullscreen map" title="Fullscreen map" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void shell.current?.requestFullscreen().catch(() => setError("Fullscreen is unavailable in this browser.")); }}><Expand size={15}/></button>
          <button disabled={loading || demo} aria-label="Refresh live conditions and ETA" title="Refresh conditions and estimates" onClick={() => { setTick(t => t + 1); onRefresh?.(); }}><RefreshCw size={15} className={loading ? "spin" : ""}/></button>
        </div>
      </div>
      <div className="organized-map-fields">
        <label>Map style<select aria-label="Google map style" value={mapType} onChange={e => setMapType(e.target.value)}><option value="roadmap">Road map</option><option value="satellite">Satellite</option><option value="hybrid">Satellite with labels</option><option value="terrain">Terrain</option></select></label>
        <label>Forecast time<select aria-label="Weather forecast time" disabled={demo} value={offset} onChange={e => setOffset(Number(e.target.value))}><option value={-1}>At planned passage</option><option value={0}>Now</option><option value={3}>In 3 hours</option><option value={6}>In 6 hours</option><option value={12}>In 12 hours</option></select></label>
        <div className="organized-map-switches"><button aria-pressed={hubs} onClick={() => setHubs(v => !v)}>Facilities</button><button aria-pressed={incidents} onClick={() => setIncidents(v => !v)}>Route incidents</button></div>
      </div>
      <div className="organized-map-status"><span><i/>{demo ? "Recorded demo" : offset > 0 ? "Future weather · traffic hidden" : data?.incidents.status === "ERROR" ? "Traffic feed unavailable" : data?.traffic_configured ? "Traffic feed connected" : "Traffic simulation"}</span><span>{loading ? "Updating conditions…" : data ? `Updated ${dt(data.fetched_at)}` : "Route forecasts"}</span></div>
    </section>
    {error && <div className="map-note" role="alert">{error} <button className="linkbtn" onClick={onFallback}>Use backup map</button></div>}
    {conditionsError && <div className="map-note" role="alert">Weather and traffic could not refresh: {conditionsError}</div>}
    <MapWeatherSimulation mapRef={unusedMapLibre} mapContainerRef={container} surface={surface} ready={ready} styleVersion={0} fallback={!ready} demo={demo} routeCoords={planned} weatherZones={weatherZones} plannedStart={plannedStart} plannedEnd={plannedEnd} avoidanceStatus={avoidanceStatus} onAddWeatherZone={onAddWeatherZone} onUpdateWeatherZone={onUpdateWeatherZone} onDeleteWeatherZone={onDeleteWeatherZone} onCancelWeatherZones={onCancelWeatherZones}>
      <div ref={container} className="google-map-canvas" aria-label="Google Maps journey map" />
      {!ready && !error && <div className="google-map-loading" role="status">Loading Google Maps…</div>}
    </MapWeatherSimulation>
    <div className="map-legend"><span><i style={{ background: "#17765e" }} />Selected route</span>{showAlternatives && alternatives.map((option,i) => option.geometry?.length && option.geometry!==planned ? <button key={option.route_id ?? i} onClick={()=>choose.current?.(i)} aria-label={`View route option ${i+1}`}><i style={{background:alternativeColor(i)}}/>Option {i+1}</button> : null)}<span><i style={{ background: "#de7043" }} />Traffic on route</span>{weatherZones.length > 0 && <span><i style={{ background: "#d15e7d" }} />Simulated weather</span>}{!!completedGeometry.length && <span>Grey · completed road</span>}</div>
    <HubEventSummary notices={hubNotices}/>
    <RouteWeatherReadout forecasts={forecasts}/>
  </div>;
}
