let pending: Promise<typeof google.maps> | null = null;

declare global {
  interface Window {
    __dachserGoogleMapsReady?: () => void;
    gm_authFailure?: () => void;
  }
}

export const GOOGLE_MAPS_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? "").trim();
/** Set once Google rejects the key (e.g. this site is not on the key's allowed websites). */
export let googleMapsRefused = false;

export const GOOGLE_MAP_ID = (import.meta.env.VITE_GOOGLE_MAP_ID ?? "DEMO_MAP_ID").trim();

/** A single script/load per page, shared by the planner and Control Room. */
export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (!GOOGLE_MAPS_KEY) return Promise.reject(new Error("Google Maps needs a browser API key."));
  if (googleMapsRefused) return Promise.reject(new Error("Google Maps rejected the API key for this website."));
  if (typeof google !== "undefined" && google.maps?.Map && google.maps.marker?.AdvancedMarkerElement) return Promise.resolve(google.maps);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timer = window.setTimeout(() => reject(new Error("Google Maps did not load. Check the connection and API key.")), 20000);
    window.__dachserGoogleMapsReady = () => { clearTimeout(timer); resolve(google.maps); };
    window.gm_authFailure = () => {
      clearTimeout(timer);
      googleMapsRefused = true;
      const message = "Google Maps could not authenticate. Check Maps JavaScript API and the key's allowed websites.";
      reject(new Error(message));
      window.dispatchEvent(new CustomEvent("dachser-google-maps-error", { detail: message }));
    };
    script.onerror = () => { clearTimeout(timer); reject(new Error("Google Maps is unreachable. Check your connection.")); };
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({ key: GOOGLE_MAPS_KEY, callback: "__dachserGoogleMapsReady", loading: "async", libraries: "maps,marker", v: "quarterly", auth_referrer_policy: "origin" })}`;
    document.head.appendChild(script);
  });
  return pending;
}
