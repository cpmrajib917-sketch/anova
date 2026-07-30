// Player Preloading & Caching Engine
// Provides zero-latency stream resolution, DNS pre-connect, and background iframe warming

import { apiCache } from './api';

export interface PreloadedStream {
  url: string;
  isCustom?: boolean;
  type?: string;
  languageAvailable?: string;
  timestamp: number;
}

const memoryStreamCache: Record<string, PreloadedStream> = {};

function getCacheKey(id: string, episode: number | string, audio: string = 'sub'): string {
  return `stream_cache_${String(id).toLowerCase().trim()}_ep${episode}_${audio.toLowerCase()}`;
}

/**
 * Pre-connects to third-party streaming domains to accelerate TCP/TLS handshakes
 */
export function preconnectStreamDomain(url: string) {
  if (typeof window === 'undefined' || !url) return;
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (!origin || origin.includes(window.location.hostname)) return;

    // Check if preconnect link already exists
    const existing = document.querySelector(`link[rel="preconnect"][href="${origin}"]`);
    if (!existing) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);

      const dnsLink = document.createElement('link');
      dnsLink.rel = 'dns-prefetch';
      dnsLink.href = origin;
      document.head.appendChild(dnsLink);
    }
  } catch (_) {}
}

/**
 * Pre-fetches the stream URL for a given anime episode in the background
 */
export async function prefetchEpisodeStream(
  id: string,
  episode: number | string = 1,
  audio: string = 'sub',
  animeTitle?: string
): Promise<PreloadedStream | null> {
  if (typeof window === 'undefined' || !id) return null;

  const cacheKey = getCacheKey(id, episode, audio);

  // 1. Check in-memory cache
  if (memoryStreamCache[cacheKey]) {
    const item = memoryStreamCache[cacheKey];
    // Cache valid for 30 minutes
    if (Date.now() - item.timestamp < 30 * 60 * 1000) {
      return item;
    }
  }

  // 2. Check apiCache / sessionStorage
  const cachedFromApi = apiCache.get(cacheKey);
  if (cachedFromApi && cachedFromApi.url) {
    memoryStreamCache[cacheKey] = cachedFromApi;
    preconnectStreamDomain(cachedFromApi.url);
    return cachedFromApi;
  }

  try {
    let season = "1";
    if (animeTitle) {
      const seasonMatch = animeTitle.match(/season\s*(\d+)/i) || animeTitle.match(/(\d+)(?:st|nd|rd|th)\s*season/i);
      if (seasonMatch) season = seasonMatch[1];
    }

    const targetLang = audio === 'dub' ? 'hindi' : 'japanese';
    const resolverUrl = `/api/resolve-anova-stream?id=${encodeURIComponent(id)}&season=${season}&ep=${episode}&lang=${targetLang}`;

    console.log(`[PlayerPreloader] Pre-fetching stream for ${id} Ep ${episode} (${audio})...`);

    const res = await fetch(resolverUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && data.url) {
        const streamData: PreloadedStream = {
          url: data.url,
          languageAvailable: targetLang,
          timestamp: Date.now()
        };

        memoryStreamCache[cacheKey] = streamData;
        apiCache.set(cacheKey, streamData);
        preconnectStreamDomain(data.url);

        console.log(`[PlayerPreloader] Stream preloaded successfully:`, data.url);
        return streamData;
      }
    }
  } catch (err) {
    console.warn('[PlayerPreloader] Pre-fetch attempt encountered non-fatal error:', err);
  }

  return null;
}

/**
 * Retrieves a preloaded stream from cache instantly
 */
export function getPreloadedStream(
  id: string,
  episode: number | string = 1,
  audio: string = 'sub'
): PreloadedStream | null {
  const cacheKey = getCacheKey(id, episode, audio);
  
  if (memoryStreamCache[cacheKey]) {
    const item = memoryStreamCache[cacheKey];
    if (Date.now() - item.timestamp < 30 * 60 * 1000) {
      return item;
    }
  }

  const cachedFromApi = apiCache.get(cacheKey);
  if (cachedFromApi && cachedFromApi.url) {
    memoryStreamCache[cacheKey] = cachedFromApi;
    return cachedFromApi;
  }

  return null;
}

/**
 * Stores custom episode stream in cache
 */
export function setPreloadedStream(
  id: string,
  episode: number | string,
  audio: string,
  url: string,
  isCustom = false
) {
  const cacheKey = getCacheKey(id, episode, audio);
  const data: PreloadedStream = {
    url,
    isCustom,
    timestamp: Date.now()
  };
  memoryStreamCache[cacheKey] = data;
  apiCache.set(cacheKey, data);
  preconnectStreamDomain(url);
}
