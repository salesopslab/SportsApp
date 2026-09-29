import { cached } from "./cache.js";

const BASE = process.env.WEATHER_API_BASE;
const KEY = process.env.WEATHER_API_KEY;

/**
 * Forecast for a stadium's coordinates, matched to the closest hourly slot to kickoff.
 * Dome/indoor venues should skip this call entirely at the caller level — no weather impact.
 */
export async function getGameWeather(lat, lon, kickoffIso) {
  return cached(`weather:${lat}:${lon}:${kickoffIso.slice(0, 13)}`, async () => {
    const url = new URL(`${BASE}/forecast`);
    url.searchParams.set("lat", lat);
    url.searchParams.set("lon", lon);
    url.searchParams.set("units", "imperial");
    url.searchParams.set("appid", KEY);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Weather API error ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();

    const kickoff = new Date(kickoffIso).getTime();
    const closest = data.list.reduce((best, slot) => {
      const slotTime = new Date(slot.dt * 1000).getTime();
      const bestTime = new Date(best.dt * 1000).getTime();
      return Math.abs(slotTime - kickoff) < Math.abs(bestTime - kickoff) ? slot : best;
    }, data.list[0]);

    return {
      tempF: closest.main.temp,
      windMph: closest.wind.speed,
      precipChance: closest.pop, // 0-1
      conditions: closest.weather[0]?.main,
      forecastFor: new Date(closest.dt * 1000).toISOString(),
      source: "OpenWeatherMap",
      retrieved_at: new Date().toISOString(),
    };
  });
}
