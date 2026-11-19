"""Select intermediate facilities using the road corridor, availability and detour."""
import math
from concurrent.futures import ThreadPoolExecutor
from .eta import _haversine_km

# An intermediate transfer this close to the destination only adds hub time.
HUB_MIN_REMAINING_MINUTES = 180
AVERAGE_TRUCK_KMH = 65

def ll(n): return (n["lat"], n["lon"])

def corridor_distance(n, geometry):
    # Local projection for point-to-segment distances (kilometres).
    scale = math.cos(math.radians(n["lat"]))
    def xy(p): return ((p[0]-n["lon"])*111.32*scale, (p[1]-n["lat"])*111.32)
    best = float("inf")
    for a, b in zip(geometry, geometry[1:]):
        x,y = xy(a); u,v = xy(b); dx,dy = u-x,v-y
        t = max(0,min(1,-(x*dx+y*dy)/(dx*dx+dy*dy or 1)))
        best = min(best, math.hypot(x+t*dx,y+t*dy))
    return best

def thin(geometry, min_km=0.5):
    """Keep one point per ~0.5 km. Against a 35 km corridor the error is negligible,
    and it makes the corridor check ~20x cheaper on a 15,000-point road line."""
    if len(geometry) < 3: return geometry
    out = [geometry[0]]
    for p in geometry[1:-1]:
        q = out[-1]
        dx = (p[0]-q[0])*111.32*math.cos(math.radians(p[1])); dy = (p[1]-q[1])*111.32
        if dx*dx+dy*dy >= min_km*min_km: out.append(p)
    out.append(geometry[-1])
    return out

# Road distance is on average about a quarter longer than the straight line.
ROAD_FACTOR = 1.25
ESTIMATE_SOURCE = "Estimated corridor (road service unavailable); confirm on the map before dispatch"

def estimate_leg(a, b):
    """Straight-line road estimate, used only when the road service gives no answer."""
    km = _haversine_km(a, b) * ROAD_FACTOR
    line = [[a[1] + (b[1] - a[1]) * t / 20, a[0] + (b[0] - a[0]) * t / 20] for t in range(21)]
    return {"geometry": line, "distance_km": round(km, 1), "duration_minutes": round(km / AVERAGE_TRUCK_KMH * 60), "estimated": True}

def select_hubs(origin, destination, available_hubs, existing_route, routing, constraints):
    # The free OSRM server often refuses or times out from cloud hosts (Vercel).
    # Without a fallback no hub was ever proposed there; estimates are labelled.
    if not existing_route.get("geometry"):
        existing_route = estimate_leg(ll(origin), ll(destination))
    corridor = thin(existing_route["geometry"])
    blocked = constraints.get("blocked", set())
    candidates = []
    baseline = existing_route["distance_km"]
    for n in available_hubs:
        if n["id"] in {origin["id"], destination["id"]} or n["id"] in blocked or not n.get("operational", True): continue
        if not n.get("transfer_enabled", True) or constraints.get("ldm",0) > n.get("capacity_ldm", 13.6): continue
        remaining = _haversine_km(ll(n), ll(destination))
        if remaining < 8: continue
        # Straight-line pre-check (road distance is at least this long); the road check follows below.
        if remaining / AVERAGE_TRUCK_KMH * 60 < HUB_MIN_REMAINING_MINUTES * 0.6: continue
        if corridor_distance(n, corridor) > constraints.get("corridor_km", 35): continue
        candidates.append((remaining, n))
    candidates.sort(key=lambda x:x[0])
    road_down = bool(existing_route.get("estimated"))
    def verify(item):
        _, n = item
        if road_down:  # the direct route already failed: estimate instead of 16 more timeouts
            left, right = estimate_leg(ll(origin), ll(n)), estimate_leg(ll(n), ll(destination))
        else:
            left = routing.leg(ll(origin), ll(n)); right = routing.leg(ll(n), ll(destination))
        if not left.get("geometry"): left = estimate_leg(ll(origin), ll(n))
        if not right.get("geometry"): right = estimate_leg(ll(n), ll(destination))
        estimated = existing_route.get("estimated") or left.get("estimated") or right.get("estimated")
        remaining_minutes = max(right.get("duration_minutes", 0), right["distance_km"] / AVERAGE_TRUCK_KMH * 60)
        if remaining_minutes < HUB_MIN_REMAINING_MINUTES: return None
        detour = left["distance_km"] + right["distance_km"] - baseline
        if detour > min(100, max(15, baseline*constraints.get("max_detour_ratio", .25))): return None
        return {"hub": n["id"], "name": n["name"], "reason": "Operational transfer facility near the road route; ranked by distance to destination after detour and capacity checks.",
                "distance_to_destination_km": right["distance_km"], "route_deviation_km": round(max(0,detour),1), "source": ESTIMATE_SOURCE if estimated else "OSRM road corridor + prototype transfer eligibility"}
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [r for r in pool.map(verify,candidates[:8]) if r]
    return sorted(results, key=lambda r:(r["distance_to_destination_km"],r["route_deviation_km"]))[:3]
