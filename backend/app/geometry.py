"""Road-line simplification.

Routing providers return a point roughly every 70 m of road. Most of those
points sit on straight stretches and add nothing a map or a weather-zone check
can see, yet every saved journey stores several such lines, every new server
instance reads them all from the database, and the browser downloads them on
every journey it opens.

simplify() drops a point only when the line without it stays within
TOLERANCE_M metres of the original road (Douglas-Peucker). At 5 m, measured on
the project's own saved journeys, it keeps about a fifth of the points and
changes total route length by 0.03%. Weather zones are kilometres wide, so
zone checks, hub corridors and vehicle progress are unaffected.
"""
import math

TOLERANCE_M = 5.0


def simplify(coords, tolerance_m=TOLERANCE_M):
    """Simplified copy of a [[lon, lat], ...] line; anything else is returned as is."""
    if not isinstance(coords, list) or len(coords) < 3:
        return coords
    try:
        lat0 = math.radians(sum(point[1] for point in coords) / len(coords))
        kx, ky = 111_320 * math.cos(lat0), 110_540  # metres per degree, local projection
        xy = [(point[0] * kx, point[1] * ky) for point in coords]
    except (TypeError, IndexError):
        return coords
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    limit = tolerance_m * tolerance_m
    stack = [(0, len(coords) - 1)]
    while stack:
        first, last = stack.pop()
        (x1, y1), (x2, y2) = xy[first], xy[last]
        dx, dy = x2 - x1, y2 - y1
        length = dx * dx + dy * dy
        worst, index = 0.0, -1
        for k in range(first + 1, last):
            x, y = xy[k]
            if length:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length))
                px, py = x1 + t * dx - x, y1 + t * dy - y
            else:
                px, py = x - x1, y - y1
            distance = px * px + py * py
            if distance > worst:
                worst, index = distance, k
        if worst > limit:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [point for point, kept in zip(coords, keep) if kept]


def simplify_all(value, tolerance_m=TOLERANCE_M):
    """Simplify every road line ("geometry": [[lon, lat], ...]) inside a record, in place."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "geometry" and isinstance(item, list) and item and isinstance(item[0], list):
                value[key] = simplify(item, tolerance_m)
            else:
                simplify_all(item, tolerance_m)
    elif isinstance(value, list):
        for item in value:
            simplify_all(item, tolerance_m)
    return value
