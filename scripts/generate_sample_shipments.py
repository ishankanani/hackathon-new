"""Create realistic sample journeys through the running app's own API.

Each journey is planned, approved and (where it has started) reported by the
server itself, so routes, ETAs, weather, costs and the database records are
exactly what the app would produce. Nothing is written to the database
directly.

Mix (default 100 journeys):
  50% delivered   - departed 1-30 days ago, arrival confirmed with actual cost
  15% in transit  - departed 1-6 hours ago, still on the road
  35% scheduled   - departing in the next 1-14 days

Usage (no extra packages needed):
    python scripts/generate_sample_shipments.py --url https://your-site.vercel.app
    python scripts/generate_sample_shipments.py --url http://127.0.0.1:8000 --count 20

With --disrupted N (default 0), N extra journeys first get a sample traffic
incident on their direct road. The app then recommends a hub route around it,
and approving that route shows up as a saving on the Savings page, computed by
the app against the direct road for the same departure and conditions.

Running it twice creates a second set; it never changes or deletes existing journeys.
"""
import argparse
import json
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SEGMENTS = ["Automotive", "Retail", "Industrial", "Chemicals", "Food", "Electronics", "Pharma"]
CONTAINERS = ["Swap body", "Curtainsider", "Box trailer", "Mega trailer"]


def call(base, method, path, body=None, attempts=3):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")[:300]
            if error.code < 500 or attempt == attempts:
                raise RuntimeError(f"{method} {path} -> {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == attempts:
                raise RuntimeError(f"{method} {path} -> {error}") from None
        time.sleep(2 * attempt)


def iso(moment):
    return moment.replace(microsecond=0).isoformat()


def main():
    parser = argparse.ArgumentParser(description="Create sample journeys through the app's API.")
    parser.add_argument("--url", required=True, help="site address, e.g. https://your-site.vercel.app")
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--seed", type=int, default=7, help="change for a different random set")
    parser.add_argument("--past-days", type=float, default=30, help="delivered journeys spread over this many past days")
    parser.add_argument("--future-days", type=float, default=14, help="scheduled journeys spread over this many coming days")
    parser.add_argument("--disrupted", type=int, default=0, help="extra journeys rerouted around a sample traffic incident")
    args = parser.parse_args()
    base = args.url.rstrip("/") + "/api"
    rng = random.Random(args.seed)

    hubs = call(base, "GET", "/hubs")["hubs"]
    ids = [hub["id"] for hub in hubs]
    print(f"Connected: {len(ids)} locations. Creating {args.count} journeys...\n")

    delivered = round(args.count * 0.50)
    moving = round(args.count * 0.15)
    kinds = ["delivered"] * delivered + ["in transit"] * moving + ["scheduled"] * (args.count - delivered - moving)
    rng.shuffle(kinds)
    kinds = [(kind, False) for kind in kinds]
    # Disrupted journeys: half delivered, a few on the road, the rest upcoming.
    extra = ["delivered", "in transit", "scheduled", "delivered"] * args.disrupted
    kinds += [(kind, True) for kind in extra[:args.disrupted]]
    now = datetime.now(timezone.utc)
    made, failed = {"delivered": 0, "in transit": 0, "scheduled": 0}, []

    for number, (kind, disrupted) in enumerate(kinds, 1):
        origin, destination = rng.sample(ids, 2)
        if kind == "delivered":
            departure = now - timedelta(days=rng.uniform(1.5, args.past_days), hours=rng.uniform(0, 12))
        elif kind == "in transit":
            departure = now - timedelta(hours=rng.uniform(1, 6))
        else:
            departure = now + timedelta(days=rng.uniform(1, args.future_days), hours=rng.uniform(0, 10))
        departure = departure.replace(minute=rng.choice([0, 15, 30, 45]), second=0)
        weight = rng.choice([800, 1500, 2500, 4000, 6000, 8000, 12000, 16000, 20000])
        body = {
            "origin": origin, "destination": destination,
            "planned_departure": iso(departure),
            "required_delivery": iso(departure + timedelta(hours=rng.choice([18, 24, 36, 48]))),
            "weight_kg": weight,
            "value_eur": rng.choice([5000, 15000, 40000, 90000, 150000, 400000]),
            "customer_segment": rng.choice(SEGMENTS),
            "container": rng.choice(CONTAINERS),
        }
        try:
            choice = 0
            if disrupted:
                # Find a route with a hub alternative, then size the incident so the
                # alternative genuinely wins (time saved at EUR 50/h beats its extra cost).
                for _ in range(15):
                    preview = call(base, "POST", "/route", {"origin": origin, "destination": destination,
                                   "depart_at": iso(departure), "weight_kg": weight})
                    options = preview.get("options") or []
                    direct = next((o for o in options if len(o["path"]) == 2), None)
                    detour = next((o for o in options if len(o["path"]) == 3 and o.get("route_feasible") is not False), None)
                    if direct and detour:
                        extra_cost = detour["cost"]["transport_eur"] - direct["cost"]["transport_eur"]
                        needed = detour["total_minutes"] - direct["total_minutes"] + max(0, extra_cost) / 50 * 60
                        if needed < 900:
                            break
                    origin, destination = rng.sample(ids, 2)
                    body.update(origin=origin, destination=destination)
                else:
                    raise RuntimeError("no route with a useful hub alternative found")
                minutes = min(1440, int(max(needed, 0) + rng.uniform(90, 240)))
                call(base, "POST", "/events", {
                    "kind": "traffic", "origin": origin, "destination": destination, "minutes": minutes,
                    "reason": "Sample data: " + rng.choice(["motorway closure after accident", "roadworks, single lane",
                                                            "bridge closure, long diversion", "heavy congestion"]),
                    "start": iso(departure - timedelta(hours=3)), "end": iso(departure + timedelta(hours=30))})
            label = f"[{number:3}/{len(kinds)}] {origin:>3} -> {destination:<3} {kind:<10}{' rerouted' if disrupted else ''}"
            ship = call(base, "POST", "/shipments", body)
            if disrupted:  # approve the route around the incident
                choice = next((i for i, o in enumerate(ship["options"]) if len(o["path"]) > 2 and o.get("route_feasible") is not False), 0)
            option = ship["options"][choice]
            call(base, "POST", "/decisions", {
                "shipment_id": ship["id"], "action": "accept", "option": choice,
                "revision": option["revision"], "quote_id": option["quote_id"],
                "reason": "Sample data: rerouted around reported traffic incident" if disrupted else "Sample data: recommended route approved",
                "acknowledge_deadline": True,
                "decided_by": "Sample data"})
            if kind != "scheduled":
                call(base, "POST", f"/shipments/{ship['id']}/driver-update",
                     {"kind": "departed", "at": iso(departure), "reference": "Sample departure"})
            if kind == "in transit":
                # Put the truck on the map where the approved plan says it is now.
                call(base, "POST", f"/shipments/{ship['id']}/position", {"source": "PLAN ESTIMATE"})
            if kind == "delivered":
                minutes = option.get("total_minutes") or 600
                arrival = departure + timedelta(minutes=minutes * rng.uniform(0.95, 1.2))
                planned_cost = (option.get("cost") or {}).get("transport_eur") or ship.get("est_cost_eur") or 800
                call(base, "POST", f"/shipments/{ship['id']}/driver-update", {
                    "kind": "arrived", "at": iso(min(arrival, now - timedelta(minutes=5))),
                    "reference": f"POD-{rng.randint(100000, 999999)}",
                    "actual_cost_eur": round(planned_cost * rng.uniform(0.92, 1.15), 2)})
            made[kind] += 1
            print(f"{label} ok  {ship['id']}")
        except Exception as error:  # keep going; report at the end
            label = f"[{number:3}/{len(kinds)}] {origin:>3} -> {destination:<3} {kind:<10}"
            failed.append((label, str(error)))
            print(f"{label} FAILED  {error}")

    print(f"\nCreated: {made['delivered']} delivered, {made['in transit']} in transit, {made['scheduled']} scheduled.")
    if failed:
        print(f"{len(failed)} failed (see lines above).")
        sys.exit(1)


if __name__ == "__main__":
    main()
