import { checkPermissions, getCurrentPosition, requestPermissions, } from "@tauri-apps/plugin-geolocation";
import { useEffect, useState, } from "react";

const CITY_CACHE_KEY = "philo:current-city";
const CITY_CACHE_TTL_MS = 30 * 60 * 1000;
const GEOLOCATION_TIMEOUT_MS = 10_000;
const GEOCODE_LOOKUP_TIMEOUT_MS = 4_000;
const REVERSE_GEOCODE_URL = "https://nominatim.openstreetmap.org/reverse";

function getTimeZoneCity(): string {
  if (typeof Intl === "undefined") return "";

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  if (!timeZone.includes("/",)) return "";

  return timeZone.split("/",).pop()?.replace(/_/g, " ",).trim() ?? "";
}

function readCachedCity(): string {
  if (typeof window === "undefined") return "";

  try {
    const raw = localStorage.getItem(CITY_CACHE_KEY,);
    if (!raw) return "";
    const parsed = JSON.parse(raw,) as { city?: unknown; expiresAt?: unknown; };
    if (
      typeof parsed.city !== "string"
      || !parsed.city.trim()
      || typeof parsed.expiresAt !== "number"
      || parsed.expiresAt <= Date.now()
    ) {
      localStorage.removeItem(CITY_CACHE_KEY,);
      return "";
    }
    return parsed.city.trim();
  } catch {
    localStorage.removeItem(CITY_CACHE_KEY,);
    return "";
  }
}

function writeCachedCity(city: string,) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(
      CITY_CACHE_KEY,
      JSON.stringify({
        city,
        expiresAt: Date.now() + CITY_CACHE_TTL_MS,
      },),
    );
  } catch {}
}

function clearCachedCity() {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(CITY_CACHE_KEY,);
  } catch {}
}

async function reverseGeocodeCity(latitude: number, longitude: number, signal: AbortSignal,): Promise<string> {
  const params = new URLSearchParams({
    format: "jsonv2",
    lat: String(latitude,),
    lon: String(longitude,),
    zoom: "10",
    addressdetails: "1",
  },);

  const response = await fetch(`${REVERSE_GEOCODE_URL}?${params.toString()}`, {
    signal,
    headers: {
      Accept: "application/json",
    },
  },);
  if (!response.ok) return "";

  const payload = await response.json() as {
    address?: {
      city?: unknown;
      town?: unknown;
      village?: unknown;
      municipality?: unknown;
      county?: unknown;
      state_district?: unknown;
      state?: unknown;
    };
  };
  const candidates = [
    payload.address?.city,
    payload.address?.town,
    payload.address?.village,
    payload.address?.municipality,
    payload.address?.county,
    payload.address?.state_district,
    payload.address?.state,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

export function useCurrentCity(): string {
  const [city, setCity,] = useState(() => readCachedCity() || getTimeZoneCity());

  useEffect(() => {
    let disposed = false;
    const fallbackCity = getTimeZoneCity();

    async function refresh() {
      try {
        let permissions = await checkPermissions();
        if (disposed) return;

        if (
          permissions.location === "prompt"
          || permissions.location === "prompt-with-rationale"
        ) {
          permissions = await requestPermissions(["location",],);
          if (disposed) return;
        }

        if (permissions.location !== "granted") {
          clearCachedCity();
          setCity(fallbackCity,);
          return;
        }

        const position = await getCurrentPosition({
          enableHighAccuracy: false,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: CITY_CACHE_TTL_MS,
        },);
        if (disposed) return;

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), GEOCODE_LOOKUP_TIMEOUT_MS,);

        try {
          const nextCity = await reverseGeocodeCity(
            position.coords.latitude,
            position.coords.longitude,
            controller.signal,
          );
          if (disposed) return;

          if (nextCity) {
            writeCachedCity(nextCity,);
            setCity((prev,) => (prev !== nextCity ? nextCity : prev));
            return;
          }
        } finally {
          window.clearTimeout(timeoutId,);
        }

        clearCachedCity();
        setCity(fallbackCity,);
      } catch (error) {
        if ((error as Error).name === "AbortError" || disposed) return;
        clearCachedCity();
        setCity(fallbackCity,);
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refresh().catch(console.error,);
      }
    }

    refresh().catch(console.error,);
    document.addEventListener("visibilitychange", onVisibilityChange,);
    window.addEventListener("focus", refresh,);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange,);
      window.removeEventListener("focus", refresh,);
    };
  }, [],);

  return city;
}
