import { invoke, } from "@tauri-apps/api/core";
import { useEffect, useState, } from "react";

const CITY_CACHE_KEY = "philo:current-city";
const CITY_CACHE_TTL_MS = 30 * 60 * 1000;
const GEOCODE_LOOKUP_TIMEOUT_MS = 4_000;
const REVERSE_GEOCODE_URL = "https://nominatim.openstreetmap.org/reverse";

type CurrentCitySource = "cache" | "geolocation" | "timezone";

type CurrentCityState = {
  city: string;
  source: CurrentCitySource;
  timezoneCity: string;
};

type NativeCurrentPosition = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

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

async function getNativeCurrentPosition(): Promise<NativeCurrentPosition | null> {
  try {
    return await invoke<NativeCurrentPosition | null>("get_native_current_position",);
  } catch {
    return null;
  }
}

export function useCurrentCity(): CurrentCityState {
  const [state, setState,] = useState<CurrentCityState>(() => {
    const timezoneCity = getTimeZoneCity();
    const cachedCity = readCachedCity();

    if (cachedCity) {
      return {
        city: cachedCity,
        source: "cache",
        timezoneCity,
      };
    }

    return {
      city: "",
      source: "timezone",
      timezoneCity,
    };
  },);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const timezoneCity = getTimeZoneCity();

    async function refresh() {
      if (refreshing) return;
      refreshing = true;

      try {
        const position = await getNativeCurrentPosition();
        if (disposed) return;

        if (!position) {
          clearCachedCity();
          setState((prev,) => (
            !prev.city && prev.source === "timezone" && prev.timezoneCity === timezoneCity
              ? prev
              : {
                city: "",
                source: "timezone",
                timezoneCity,
              }
          ));
          return;
        }

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), GEOCODE_LOOKUP_TIMEOUT_MS,);

        try {
          const nextCity = await reverseGeocodeCity(
            position.latitude,
            position.longitude,
            controller.signal,
          );
          if (disposed) return;

          if (nextCity) {
            writeCachedCity(nextCity,);
            setState((prev,) => (
              prev.city === nextCity && prev.source === "geolocation" && prev.timezoneCity === timezoneCity
                ? prev
                : {
                  city: nextCity,
                  source: "geolocation",
                  timezoneCity,
                }
            ));
            return;
          }
        } finally {
          window.clearTimeout(timeoutId,);
        }

        clearCachedCity();
        setState((prev,) => (
          !prev.city && prev.source === "timezone" && prev.timezoneCity === timezoneCity
            ? prev
            : {
              city: "",
              source: "timezone",
              timezoneCity,
            }
        ));
      } catch (error) {
        if ((error as Error).name === "AbortError" || disposed) return;
        clearCachedCity();
        setState((prev,) => (
          !prev.city && prev.source === "timezone" && prev.timezoneCity === timezoneCity
            ? prev
            : {
              city: "",
              source: "timezone",
              timezoneCity,
            }
        ));
      } finally {
        refreshing = false;
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

  return state;
}
