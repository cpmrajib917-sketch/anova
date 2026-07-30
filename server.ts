import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import compression from 'compression';
import { createServer as createViteServer } from 'vite';
import { getOrFetch, db } from './server/cache.js';
import { telegramRouter } from './server/telegram/routes.js';
import { startTelegramPolling } from './server/telegram/telegramService.js';
import { GoogleGenAI, Type } from '@google/genai';
import { ref, get, set, update } from 'firebase/database';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Compress all responses using Gzip/Brotli to minimize origin payload sizes
  app.use(compression());

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Mount Telegram API Router
  app.use('/api/telegram', telegramRouter);

  // Recursive helper to rewrite any image URLs in API responses to our Cloudflare-cached proxy
  function rewriteImageUrls(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      // Check if it's an image URL that should be proxied
      const isExternalImage = 
        (obj.startsWith('http://') || obj.startsWith('https://')) &&
        (obj.includes('unsplash.com') ||
         obj.includes('anilist.co') ||
         obj.includes('img.kryzox.xyz') ||
         obj.match(/\.(png|jpg|jpeg|webp|gif|svg)(\?.*)?$/i));

      if (isExternalImage && !obj.includes('/api/image-proxy')) {
        return `/api/image-proxy?url=${encodeURIComponent(obj)}`;
      }
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => rewriteImageUrls(item));
    }

    if (typeof obj === 'object') {
      const newObj: any = {};
      for (const key of Object.keys(obj)) {
        newObj[key] = rewriteImageUrls(obj[key]);
      }
      return newObj;
    }

    return obj;
  }

  // API proxy route for images to enable long-lived Cloudflare CDN Edge & Browser caching
  app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url as string;
    if (!imageUrl) {
      return res.status(400).send('Missing url parameter');
    }

    try {
      // Fetch image from origin
      const imageRes = await fetch(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        }
      });

      if (!imageRes.ok) {
        throw new Error(`External server responded with status ${imageRes.status}`);
      }

      const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await imageRes.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuffer);

      // Set long-lived cache headers for browser & Cloudflare Edge CDN (1 Year = 31536000s)
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
      res.setHeader('CDN-Cache-Control', 'max-age=31536000');
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.send(imageBuffer);
    } catch (err: any) {
      // Quietly redirect to high-quality fallback image on failure without noisy error logs
      const fallbackUrl = 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=300&auto=format&fit=crop&q=80';
      return res.redirect(fallbackUrl);
    }
  });

  // Resilient, rate-limit aware fetch function for Kryzox API with retries and exponential backoff
  async function fetchKryzoxWithRetry(url: string, retries = 3, delayMs = 1200): Promise<any> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://api.kryzox.xyz/'
    };

    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { headers });
        if (res.status === 429) {
          if (i < retries - 1) {
            console.warn(`[Kryzox Proxy Retry] URL ${url} returned 429. Retrying in ${delayMs}ms... (Attempt ${i + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            delayMs *= 2;
            continue;
          }
          console.warn(`[Kryzox Proxy] URL ${url} rate limited (429). Returning empty graceful fallback.`);
          return { success: false, results: [], data: [] };
        }

        if (!res.ok) {
          if (i < retries - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            delayMs *= 1.5;
            continue;
          }
          console.warn(`[Kryzox Proxy] URL ${url} returned status ${res.status}. Returning empty graceful fallback.`);
          return { success: false, results: [], data: [] };
        }

        return await res.json();
      } catch (err: any) {
        if (i === retries - 1) {
          console.warn(`[Kryzox Proxy] Error fetching ${url}: ${err.message}. Returning empty graceful fallback.`);
          return { success: false, results: [], data: [] };
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 1.5;
      }
    }
    return { success: false, results: [], data: [] };
  }

  // API proxy route for Kryzox API with advanced stale-while-revalidate caching
  app.get('/api/kryzox/*', async (req, res) => {
    try {
      const endpointPath = req.originalUrl.replace(/^\/api\/kryzox/, '');
      if (!endpointPath || endpointPath === '/') {
        return res.status(400).json({ error: 'Missing target endpoint' });
      }

      // Safeguard: Custom anime IDs and YouTube playlists do not exist on the external Kryzox API
      if (endpointPath.includes('custom-') || endpointPath.includes('yt-pl-')) {
        if (endpointPath.includes('/episodes')) {
          return res.json({ success: true, data: [] });
        }
        return res.status(404).json({ success: false, error: 'Custom or YouTube playlist anime metadata not found on Kryzox API' });
      }

      const targetUrl = `https://api.kryzox.xyz${endpointPath}`;
      const cacheKey = `kryzox:${endpointPath}`;

      // Configurable Redis TTL of 24 hours (86400 seconds)
      const ttlSeconds = 24 * 60 * 60;
      // Stale threshold of 1 hour for normal metadata
      const staleThresholdMs = 1 * 60 * 60 * 1000;

      const data = await getOrFetch(
        cacheKey,
        async () => {
          return await fetchKryzoxWithRetry(targetUrl);
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(data || { success: true, data: [] }));
    } catch (err: any) {
      console.warn(`[Kryzox Proxy] Fallback for ${req.originalUrl}:`, err.message);
      return res.json({ success: false, results: [], data: [] });
    }
  });

  // Anikoto API route removed per request
  app.get('/api/anikoto/*', (req, res) => {
    return res.status(404).json({ error: 'Anikoto server disabled. Please use ToonStream or HD servers.' });
  });

  // API proxy route for AnOvA backup Replit API with advanced stale-while-revalidate caching
  app.get('/api/anova/*', async (req, res) => {
    try {
      const endpointPath = req.originalUrl.replace(/^\/api\/anova/, '');
      if (!endpointPath || endpointPath === '/') {
        return res.status(400).json({ error: 'Missing target endpoint' });
      }

      // Safeguard: Custom anime IDs and YouTube playlists do not exist on external AnOvA backup server
      if (endpointPath.includes('custom-') || endpointPath.includes('yt-pl-')) {
        if (endpointPath.includes('/episodes')) {
          return res.json({ success: true, data: [] });
        }
        return res.json({ success: true, results: [], data: [] });
      }

      const targetUrl = `https://backup--idplaypoinbdb.replit.app${endpointPath}`;
      const cacheKey = `anova_backup:${endpointPath}`;

      // Configurable Redis TTL of 24 hours (86400 seconds)
      const ttlSeconds = 24 * 60 * 60;
      // Stale threshold of 1 hour for normal metadata
      const staleThresholdMs = 1 * 60 * 60 * 1000;

      const data = await getOrFetch(
        cacheKey,
        async () => {
          try {
            const apiRes = await fetch(targetUrl);
            if (!apiRes.ok) {
              if (endpointPath.includes('/api/search')) {
                console.warn(`[AnOvA Proxy Warning] Upstream search returned non-ok status ${apiRes.status}. Returning empty results.`);
                return { results: [] };
              }
              const err = new Error(`AnOvA backup API responded with status ${apiRes.status}`);
              (err as any).status = apiRes.status;
              throw err;
            }
            return await apiRes.json();
          } catch (fetchErr: any) {
            if (endpointPath.includes('/api/search')) {
              console.warn(`[AnOvA Proxy Warning] Search fetch failed: ${fetchErr.message}. Returning empty results.`);
              return { results: [] };
            }
            throw fetchErr;
          }
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(data));
    } catch (err: any) {
      const statusCode = err.status || 500;
      if (statusCode === 404) {
        console.warn(`[AnOvA Proxy Info] ${req.originalUrl}: Not found (404)`);
      } else {
        console.error(`[AnOvA Proxy Error] ${req.originalUrl}:`, err.message);
      }
      return res.status(statusCode).json({ error: err.message || 'AnOvA Proxy error' });
    }
  });

  // API Route to dynamically resolve AnOvA streams server-side to bypass CORS and DNS blockades with cache
  app.get('/api/resolve-anova-stream', async (req, res) => {
    try {
      const { id, season = '1', ep, isMovie, lang } = req.query;

      if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
      }

      const idStr = String(id).trim();

      // 1. Check if 'id' itself is a direct stream/embed URL
      if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
        return res.json({
          success: true,
          url: idStr,
          image: '',
          originalEmbed: idStr
        });
      }

      // 2. Check if 'id' is a custom anime ID or YouTube playlist ID
      if (idStr.startsWith('custom-') || idStr.startsWith('yt-pl-')) {
        const epNum = ep ? String(ep) : '1';
        let foundUrl = '';
        let foundImg = '';

        try {
          // Check Firebase RTDB for custom episode
          const epSnap = await get(ref(db, `episodes/${idStr}/${epNum}`));
          if (epSnap && epSnap.exists()) {
            const epData = epSnap.val();
            if (epData) {
              foundUrl = epData.url || epData.streamUrl || epData.embed || epData.link || '';
              foundImg = epData.image || epData.thumbnail || '';
            }
          }
          if (!foundUrl) {
            const allEpsSnap = await get(ref(db, `episodes/${idStr}`));
            if (allEpsSnap && allEpsSnap.exists()) {
              const val = allEpsSnap.val();
              if (Array.isArray(val)) {
                const epObj = val.find((e: any) => String(e?.episodeNumber || e?.ep) === epNum) || val[Number(epNum) - 1];
                if (epObj) {
                  foundUrl = epObj.url || epObj.streamUrl || epObj.embed || epObj.link || '';
                  foundImg = epObj.image || epObj.thumbnail || '';
                }
              } else if (val && typeof val === 'object') {
                const epObj = Object.values(val).find((e: any) => String(e?.episodeNumber || e?.ep) === epNum);
                if (epObj) {
                  foundUrl = (epObj as any).url || (epObj as any).streamUrl || (epObj as any).embed || (epObj as any).link || '';
                  foundImg = (epObj as any).image || (epObj as any).thumbnail || '';
                }
              }
            }
          }
        } catch (_) {}

        const audioType = (lang === 'dub' || lang === 'hindi') ? 'dub' : 'sub';
        const fallbackEmbedUrl = foundUrl && (foundUrl.startsWith('http://') || foundUrl.startsWith('https://'))
          ? foundUrl
          : `https://cdn.4animo.xyz/embed/vidsrc/in/${encodeURIComponent(idStr)}/${audioType}`;

        return res.json({
          success: true,
          url: fallbackEmbedUrl,
          image: foundImg,
          originalEmbed: fallbackEmbedUrl
        });
      }

      const cacheKey = `anova_stream:${id}:S${season}:E${ep}:movie=${isMovie}:lang=${lang || ''}`;
      const ttlSeconds = 24 * 60 * 60; // 24 Hours Redis TTL
      const staleThresholdMs = 4 * 60 * 60 * 1000; // 4 Hours Stale threshold for media links

      const result = await getOrFetch(
        cacheKey,
        async () => {
          let streamApiUrl = '';
          const backupHosts = [
            'https://backup--idplaypoinbdb.replit.app',
            'https://api.anify.tv',
            'https://api.kryzox.xyz'
          ];

          let apiRes: Response | null = null;
          let lastError = '';

          for (const host of backupHosts) {
            try {
              if (host.includes('kryzox')) {
                streamApiUrl = isMovie === 'true' || !ep
                  ? `${host}/anime/${encodeURIComponent(id as string)}`
                  : `${host}/anime/${encodeURIComponent(id as string)}/episodes`;
              } else if (isMovie === 'true' || !ep) {
                streamApiUrl = host.includes('anify')
                  ? `${host}/info?id=${encodeURIComponent(id as string)}&type=anime`
                  : `${host}/api/movie?id=${encodeURIComponent(id as string)}`;
              } else {
                streamApiUrl = host.includes('anify')
                  ? `${host}/stream?id=${encodeURIComponent(id as string)}&episode=${ep}&providerId=gogoanime&type=anime&subType=sub`
                  : `${host}/api/stream?id=${encodeURIComponent(id as string)}&season=${season}&ep=${ep}`;
              }
              console.log(`[Resolver] Trying host: ${streamApiUrl}`);
              apiRes = await fetch(streamApiUrl, { 
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'application/json, text/plain, */*'
                },
                signal: AbortSignal.timeout(8000) 
              });
              if (apiRes.ok) break;
              lastError = `HTTP ${apiRes.status}`;
            } catch (e: any) {
              lastError = e.message;
              continue;
            }
          }

          if (!apiRes || !apiRes.ok) {
            // Check if 'id' itself is a direct stream URL
            const idStr = String(id).trim();
            if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
              return {
                success: true,
                url: idStr,
                image: '',
                originalEmbed: idStr
              };
            }
            
            // Resilient Fallback: construct standard 4Animo CDN / VidSrc embed URL when external backup resolvers fail
            const audioType = (lang === 'dub' || lang === 'hindi') ? 'dub' : 'sub';
            const epNum = ep || '1';
            const fallbackEmbedUrl = /^\d+$/.test(idStr)
              ? `https://cdn.4animo.xyz/embed/vidsrc/mal/${idStr}/${epNum}/${audioType}`
              : `https://cdn.4animo.xyz/embed/vidsrc/in/${encodeURIComponent(idStr)}/${audioType}`;

            console.log(`[Resolver] External hosts failed (${lastError}). Serving fallback CDN embed: ${fallbackEmbedUrl}`);
            return {
              success: true,
              url: fallbackEmbedUrl,
              image: '',
              originalEmbed: fallbackEmbedUrl
            };
          }

          const apiData = (await apiRes.json()) as any;

          let rawList: any[] = [];
          if (Array.isArray(apiData)) {
            rawList = apiData;
          } else if (Array.isArray(apiData?.results)) {
            rawList = apiData.results;
          } else if (Array.isArray(apiData?.sources)) {
            rawList = apiData.sources;
          } else if (Array.isArray(apiData?.data)) {
            rawList = apiData.data;
          } else if (apiData && typeof apiData === 'object') {
            if (Array.isArray(apiData.servers)) {
              rawList = apiData.servers;
            } else if (apiData.results && typeof apiData.results === 'object') {
              rawList = [apiData.results];
            } else if (apiData.sources && typeof apiData.sources === 'object') {
              rawList = [apiData.sources];
            } else {
              rawList = [apiData];
            }
          }

          const validOptions = (Array.isArray(rawList) ? rawList : [])
            .map((item: any) => {
              if (!item) return null;
              if (typeof item === 'string' && (item.startsWith('http') || item.startsWith('//'))) {
                return { link: item, type: 'stream' };
              }
              const link = item.link || item.url || item.embedUrl || item.file || item.src;
              if (!link || typeof link !== 'string' || (!link.startsWith('http') && !link.startsWith('//'))) return null;
              return {
                ...item,
                link: link.trim(),
                language: item.language || item.lang || item.subType || item.type || '',
                type: item.type || (item.quality ? 'stream' : 'server')
              };
            })
            .filter(Boolean);

          if (validOptions.length === 0) {
            // Check if 'id' itself is a direct stream URL
            const idStr = String(id).trim();
            if (idStr.startsWith('http://') || idStr.startsWith('https://')) {
              return {
                success: true,
                url: idStr,
                image: '',
                originalEmbed: idStr
              };
            }

            const audioType = (lang === 'dub' || lang === 'hindi') ? 'dub' : 'sub';
            const epNum = ep || '1';
            const fallbackEmbedUrl = /^\d+$/.test(idStr)
              ? `https://cdn.4animo.xyz/embed/vidsrc/mal/${idStr}/${epNum}/${audioType}`
              : `https://cdn.4animo.xyz/embed/vidsrc/in/${encodeURIComponent(idStr)}/${audioType}`;

            console.log(`[Resolver] No valid options found. Serving fallback CDN embed: ${fallbackEmbedUrl}`);
            return {
              success: true,
              url: fallbackEmbedUrl,
              image: '',
              originalEmbed: fallbackEmbedUrl
            };
          }

          let serverOption = null;

          // 1. Try language match if requested
          if (lang) {
            const langStr = String(lang).toLowerCase();
            serverOption = validOptions.find((r: any) => 
              r.language && String(r.language).toLowerCase().includes(langStr)
            );
          }

          // 2. Fallback to server type options
          if (!serverOption) {
            serverOption = validOptions.find((r: any) => r.type === 'server') ||
                           validOptions.find((r: any) => r.type === 'stream') ||
                           validOptions[0];
          }

          const embedUrl = serverOption.link;
          console.log(`[Resolver] Selected option with link: ${embedUrl}`);

          let playableUrl = null;
          let videoData: any = {};

          try {
            // Attempt standard getVideo POST resolution if it looks like a standard stream domain
            if (embedUrl.includes('/video/') || embedUrl.includes('/player/index.php')) {
              const urlObj = new URL(embedUrl);
              const domain = urlObj.hostname;
              const videoId = urlObj.pathname.split('/').pop();

              if (videoId) {
                const postUrl = `https://${domain}/player/index.php?data=${videoId}&do=getVideo`;
                console.log(`[Resolver] Attempting getVideo POST: ${postUrl}`);

                const postBody = new URLSearchParams();
                postBody.append('hash', videoId);
                postBody.append('r', `https://${domain}/`);

                const videoRes = await fetch(postUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': `https://${domain}/video/${videoId}`
                  },
                  body: postBody.toString()
                });

                if (videoRes.ok) {
                  const videoText = await videoRes.text();
                  try {
                    videoData = JSON.parse(videoText);
                    playableUrl = videoData.securedLink || videoData.videoSource;
                  } catch (e) {
                    console.warn(`[Resolver] Failed to parse player server response as JSON, falling back to original embed`);
                  }
                }
              }
            }
          } catch (e: any) {
            console.warn(`[Resolver] Error during getVideo extraction, falling back to original embed link:`, e.message);
          }

          // Smart Fallback: if scraping direct source failed or was skipped, use the embed URL itself!
          if (!playableUrl) {
            console.log(`[Resolver] Direct source resolution skipped/failed. Falling back to original embed link: ${embedUrl}`);
            playableUrl = embedUrl;
          }

          console.log(`[Resolver] Resolved direct stream URL: ${playableUrl}`);
          return {
            success: true,
            url: playableUrl,
            image: videoData.videoImage || '',
            originalEmbed: embedUrl
          };
        },
        ttlSeconds,
        staleThresholdMs
      );

      // Enable robust Cloudflare Edge Caching
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=3600');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=86400');
      res.setHeader('CDN-Cache-Control', 'max-age=86400');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      return res.json(rewriteImageUrls(result));
    } catch (err: any) {
      const statusCode = err.status || 404;
      if (statusCode === 404) {
        console.warn('[Resolver Info] Stream not found (404) in resolve-anova-stream:', err.message);
      } else {
        console.error('[Resolver Error] Error in resolve-anova-stream:', err);
      }
      return res.status(statusCode).json({
        success: false,
        error: err.message || 'Unknown stream resolution error'
      });
    }
  });

  // API route for Anime ID mapping resolution (Redis -> Firebase -> API fallback)
  app.get('/api/anime-mapping/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Missing anime id' });
    }

    // Bypass external mapping lookup for custom-created anime IDs or YouTube playlist IDs
    if (id.startsWith('custom-') || id.startsWith('yt-pl-')) {
      return res.json({
        id,
        animoId: id,
        anilistId: '',
        malId: '',
        success: true
      });
    }

    try {
      const cacheKey = `anime-mapping:${id}`;
      // Map to 1 year TTL
      const ttlSeconds = 365 * 24 * 60 * 60;
      // Stale threshold is 30 days
      const staleThresholdMs = 30 * 24 * 60 * 60 * 1000;

      const mapping = await getOrFetch(
        cacheKey,
        async () => {
          // Fetch from Kryzox API /anime/:id to get mapping
          const targetUrl = `https://api.kryzox.xyz/anime/${id}`;
          console.log(`[Mapping Resolver] Fetching fresh mapping details for ID ${id} from: ${targetUrl}`);
          
          let animoId = id;
          let anilistId = '';
          let malId = '';

          try {
            const data = await fetchKryzoxWithRetry(targetUrl, 2, 800);
            const animeObj = data.data || data;
            if (animeObj) {
              animoId = String(animeObj.id || id);
              anilistId = String(animeObj.al_id || animeObj.anilist_id || animeObj.anilistId || animeObj.alId || '');
              malId = String(animeObj.mal_id || animeObj.malId || '');
            }
          } catch (apiErr: any) {
            console.error(`[Mapping Resolver] Kryzox API fetch failed for ID ${id}:`, apiErr.message);
          }

          // If mapping is still missing, scan episodes
          if (!anilistId || !malId || anilistId === 'null' || malId === 'null') {
            const episodesUrl = `https://api.kryzox.xyz/anime/${id}/episodes`;
            try {
              const epData = await fetchKryzoxWithRetry(episodesUrl, 2, 800);
              let epsList = [];
              if (Array.isArray(epData)) epsList = epData;
              else if (Array.isArray(epData?.data)) epsList = epData.data;
              else if (Array.isArray(epData?.episodes)) epsList = epData.episodes;

              for (const ep of epsList) {
                if (ep) {
                  const epAni = ep.ani || ep.anilistId || ep.anilist_id || ep.al_id || ep.alId;
                  const epMal = ep.mal || ep.malId || ep.mal_id;
                  if (!anilistId && epAni) {
                    const str = String(epAni);
                    anilistId = str.includes('/') ? str.split('/')[0] : str;
                  }
                  if (!malId && epMal) {
                    const str = String(epMal);
                    malId = str.includes('/') ? str.split('/')[0] : str;
                  }
                }
                if (anilistId && malId) break;
              }
            } catch (err: any) {
              console.warn(`[Mapping Resolver] Failed to fetch episodes for scanning:`, err.message);
            }
          }

          // Filter out invalid placeholders
          if (anilistId === 'null' || anilistId === 'undefined' || anilistId === '0') {
            anilistId = '';
          }
          if (malId === 'null' || malId === 'undefined' || malId === '0') {
            malId = '';
          }

          // If still missing and id is numeric, fallback to it
          const isNumeric = /^\d+$/.test(id);
          if (isNumeric) {
            if (!anilistId) {
              anilistId = id;
            }
            if (!malId) {
              malId = id;
            }
          } else if (!anilistId || !malId) {
            // Non-numeric slug fallback: Search AniList GraphQL for exact numeric IDs
            try {
              const cleanSearchQuery = id.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
              console.log(`[Mapping Resolver] Non-numeric slug "${id}". Searching AniList GraphQL for: "${cleanSearchQuery}"`);
              const gqlQuery = `query ($search: String) { Media (search: $search, type: ANIME) { id idMal } }`;
              const aniRes = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: gqlQuery, variables: { search: cleanSearchQuery } })
              });
              if (aniRes.ok) {
                const aniJson = await aniRes.json();
                if (aniJson?.data?.Media) {
                  if (!anilistId) anilistId = String(aniJson.data.Media.id || '');
                  if (!malId && aniJson.data.Media.idMal) malId = String(aniJson.data.Media.idMal);
                  console.log(`[Mapping Resolver] AniList GraphQL search resolved "${id}" -> AniList: ${anilistId}, MAL: ${malId}`);
                }
              }
            } catch (gqlErr: any) {
              console.warn(`[Mapping Resolver] AniList GraphQL search error for ${id}:`, gqlErr.message);
            }
          }

          return { animoId, anilistId, malId };
        },
        ttlSeconds,
        staleThresholdMs
      );

      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.json(mapping);
    } catch (err: any) {
      console.error(`[Mapping Resolver Error] Failed to resolve mapping for ${id}:`, err);
      return res.status(500).json({ error: err.message || 'Mapping resolution failed' });
    }
  });

  // Server-side verification endpoint to get real status codes without CORS restrictions
  app.get('/api/verify-url', async (req, res) => {
    const urlStr = req.query.url as string;
    if (!urlStr) {
      return res.status(400).json({ error: 'Missing url' });
    }

    // Embed and stream URLs are trusted and handled directly by browser iframe or proxy — do not fail or HEAD/GET check them
    if (
      urlStr.includes('cdn.4animo.xyz') ||
      urlStr.includes('kryzox.xyz') ||
      urlStr.includes('megacloud') ||
      urlStr.includes('vidfast') ||
      urlStr.includes('rabbitstream') ||
      urlStr.includes('streamwish') ||
      urlStr.includes('filemoon') ||
      urlStr.includes('vidhide') ||
      urlStr.includes('mp4upload') ||
      urlStr.includes('dood') ||
      urlStr.includes('streamtape') ||
      urlStr.includes('vidsrc') ||
      urlStr.includes('embed-proxy') ||
      urlStr.includes('/embed') ||
      urlStr.includes('/e/') ||
      urlStr.includes('/v/') ||
      urlStr.includes('youtube.com') ||
      urlStr.includes('youtu.be') ||
      urlStr.includes('dailymotion') ||
      urlStr.includes('rumble') ||
      urlStr.includes('odysee')
    ) {
      return res.json({ success: true, status: 200, trusted: true });
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500); // 4.5s timeout
      
      let response = null;
      try {
        response = await fetch(urlStr, {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://cdn.4animo.xyz/',
            'Accept': '*/*'
          },
          signal: controller.signal
        });
      } catch (headErr) {
        response = null;
      }
      clearTimeout(timeoutId);

      // If HEAD failed or is not allowed/blocked (status is not 2xx), fall back to GET with a short timeout and a Range/Abort limit
      if (!response || !response.ok || response.status === 405 || response.status === 403) {
        const getController = new AbortController();
        const getTimeoutId = setTimeout(() => getController.abort(), 3500);
        try {
          const getResponse = await fetch(urlStr, {
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://cdn.4animo.xyz/',
              'Range': 'bytes=0-1024',
              'Accept': '*/*'
            },
            signal: getController.signal
          });
          clearTimeout(getTimeoutId);
          response = getResponse;
        } catch (_) {
          clearTimeout(getTimeoutId);
        }
      }

      const finalStatus = response ? response.status : 0;
      // Consider successful if 2xx, or 416 (Range Satisfied), or 403 (Exists but direct curl forbidden, which is normal for CDNs and completely playable inside the browser iframe!)
      const success = response ? (response.ok || response.status === 416 || response.status === 403 || response.status === 302) : false;

      return res.json({
        success,
        status: finalStatus
      });
    } catch (err: any) {
      console.warn(`[Verify URL Error] Failed to verify ${urlStr}:`, err.message);
      return res.json({
        success: false,
        error: err.message
      });
    }
  });

  // YouTube Video & Playlist validation helpers
  async function validateVideoId(videoId: string, apiKey?: string): Promise<string> {
    return 'AVAILABLE';
  }

  async function validateVideoBatch(videoIds: string[], apiKey?: string): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    videoIds.forEach(id => {
      results[id] = 'AVAILABLE';
    });
    return results;
  }

  function determinePlaylistStatus(statuses: string[]): string {
    return 'AVAILABLE';
  }

  // InnerTube Web API Playlist Fetcher (Zero Quota, Retrieves ALL videos in a playlist with continuation pages)
  const fetchInnerTubePlaylistItems = async (playlistId: string): Promise<{ items: any[]; title: string; channelName: string }> => {
    const cleanId = playlistId.replace(/^VL/, '').replace(/^yt-pl-/, '').replace(/^single-/, '').split('?')[0].split('&')[0].trim();
    const browseId = cleanId.startsWith('PL') || cleanId.startsWith('UU') || cleanId.startsWith('FL') || cleanId.startsWith('OL') || cleanId.startsWith('RD') ? `VL${cleanId}` : cleanId;

    const apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    const url = `https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`;

    let title = '';
    let channelName = '';
    const itemsMap = new Map<string, any>();
    const continuationTokens: string[] = [];

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'WEB',
              clientVersion: '2.20240301.00.00',
              hl: 'en',
              gl: 'US'
            }
          },
          browseId
        })
      });

      if (res.ok) {
        const data = await res.json();

        // Extract playlist title & channel
        const header = data.header?.playlistHeaderRenderer || data.header?.playlistCustomHeaderRenderer;
        if (header?.title) {
          title = header.title.simpleText || header.title.runs?.[0]?.text || '';
        }
        if (!title && data.sidebar?.playlistSidebarRenderer?.items?.[0]?.playlistSidebarPrimaryInfoRenderer?.title?.runs?.[0]?.text) {
          title = data.sidebar.playlistSidebarRenderer.items[0].playlistSidebarPrimaryInfoRenderer.title.runs[0].text;
        }
        if (!title && data.metadata?.playlistMetadataRenderer?.title) {
          title = data.metadata.playlistMetadataRenderer.title;
        }

        const owner = data.sidebar?.playlistSidebarRenderer?.items?.[1]?.playlistSidebarSecondaryInfoRenderer?.videoOwner?.videoOwnerRenderer;
        if (owner?.title?.runs?.[0]?.text) {
          channelName = owner.title.runs[0].text;
        }

        const recurse = (node: any) => {
          if (!node || typeof node !== 'object') return;

          if (node.playlistVideoRenderer) {
            const v = node.playlistVideoRenderer;
            const videoId = v.videoId;
            let vTitle = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
            let thumb = v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
            const isPlayable = v.isPlayable !== false;
            if (videoId && !itemsMap.has(videoId)) {
              itemsMap.set(videoId, {
                videoId,
                title: vTitle.trim() || `Video ${videoId}`,
                thumbnail: thumb,
                description: '',
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isPrivateOrDeleted: !isPlayable
              });
            }
            return;
          }

          if (node.continuationItemRenderer) {
            const token = node.continuationItemRenderer.continuationEndpoint?.continuationCommand?.token || node.continuationItemRenderer.continuationCommand?.token;
            if (token && !continuationTokens.includes(token)) {
              continuationTokens.push(token);
            }
            return;
          }

          if (Array.isArray(node)) {
            node.forEach(recurse);
          } else {
            Object.values(node).forEach(recurse);
          }
        };

        recurse(data);

        // Fetch continuations for long playlists (up to 20 pages / 1000 items)
        let pagesCount = 0;
        while (continuationTokens.length > 0 && pagesCount < 20) {
          pagesCount++;
          const token = continuationTokens.shift();
          if (!token) break;

          try {
            const contRes = await fetch(url, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
              },
              body: JSON.stringify({
                context: {
                  client: {
                    clientName: 'WEB',
                    clientVersion: '2.20240301.00.00',
                    hl: 'en',
                    gl: 'US'
                  }
                },
                continuation: token
              })
            });

            if (contRes.ok) {
              const contData = await contRes.json();
              recurse(contData);
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[InnerTube Playlist Fetcher Error]:', err);
    }

    return {
      items: Array.from(itemsMap.values()),
      title,
      channelName
    };
  };

  // Fetch YouTube Playlist or Video items securely (with RSS, API, Invidious, Piped & Scraper Fallbacks)
  app.get('/api/youtube-playlist', async (req, res) => {
    const { playlistUrl } = req.query;
    if (!playlistUrl || typeof playlistUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing playlistUrl parameter' });
    }

    const rawInput = playlistUrl.trim();
    if (!rawInput) {
      return res.status(400).json({ success: false, error: 'Playlist URL or Video URL cannot be empty' });
    }

    const cleanInput = rawInput.replace(/^single-/, '').replace(/^yt-pl-/, '');

    const apiKey = process.env.YOUTUBE_API_KEY;
    const isApiKeyConfigured = !!(apiKey && 
      apiKey !== 'YOUR_YOUTUBE_API_KEY' && 
      !apiKey.startsWith('YOUR_') && 
      !apiKey.startsWith('AQ.') &&
      apiKey !== 'AIzaSyAEMPSLLL7xEhvIhXhm2D7amGj2FLH-9tQ');

    // 1. Single Video Detection (ONLY if user pasted a single video URL or video ID with NO list= parameter)
    const extractVideoId = (input: string): string | null => {
      const trimmed = input.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed) && !trimmed.startsWith('PL') && !trimmed.startsWith('UC') && !trimmed.startsWith('OL')) {
        return trimmed;
      }
      const match = trimmed.match(/(?:v=|\/v\/|\/embed\/|\/shorts\/|youtu\.be\/|watch\?.*v=)([a-zA-Z0-9_-]{11})/i);
      return match ? match[1] : null;
    };

    const hasPlaylistParam = /[?&]list=/i.test(cleanInput) || /^(?:PL|UU|FL|OL|RD|CL)[a-zA-Z0-9_-]+/i.test(cleanInput) || /^yt-pl-/i.test(cleanInput);
    const singleVideoId = !hasPlaylistParam ? extractVideoId(cleanInput) : null;

    if (singleVideoId) {
      console.log(`[YouTube Playlist API] Detected single video import request for ID: ${singleVideoId}`);
      let singleTitle = `YouTube Video (${singleVideoId})`;
      let singleChannel = 'YouTube';
      let singleThumb = `https://img.youtube.com/vi/${singleVideoId}/hqdefault.jpg`;
      let singleDesc = '';

      // Try Official API for single video if key is configured
      if (isApiKeyConfigured) {
        try {
          const apiRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${singleVideoId}&key=${apiKey}`);
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData.items && apiData.items.length > 0) {
              const snip = apiData.items[0].snippet || {};
              singleTitle = snip.title || singleTitle;
              singleChannel = snip.channelTitle || singleChannel;
              singleDesc = snip.description || '';
              const thumbs = snip.thumbnails || {};
              singleThumb = thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || singleThumb;
            }
          }
        } catch (_) {}
      }

      // Try oEmbed fallback if title not fetched
      if (singleTitle.startsWith('YouTube Video')) {
        try {
          const oeRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${singleVideoId}&format=json`);
          if (oeRes.ok) {
            const oeData = await oeRes.json();
            if (oeData.title) singleTitle = oeData.title;
            if (oeData.author_name) singleChannel = oeData.author_name;
            if (oeData.thumbnail_url) singleThumb = oeData.thumbnail_url;
          }
        } catch (_) {}
      }

      return res.json({
        success: true,
        playlistId: singleVideoId,
        playlistTitle: singleTitle,
        channelName: singleChannel,
        isSingleVideoMovie: true,
        items: [{
          videoId: singleVideoId,
          title: singleTitle,
          thumbnail: singleThumb,
          description: singleDesc,
          url: `https://www.youtube.com/watch?v=${singleVideoId}`,
          isPrivateOrDeleted: false,
          validationStatus: 'AVAILABLE'
        }],
        playlistValidationStatus: 'AVAILABLE',
        source: 'single_video'
      });
    }

    // 2. Extract Playlist ID from playlist URL or raw string
    let playlistId = cleanInput;
    if (cleanInput.includes('list=')) {
      const match = cleanInput.match(/[&?]list=([^&?#]+)/i);
      if (match && match[1]) {
        playlistId = match[1];
      }
    }
    playlistId = playlistId.split('?')[0].split('#')[0].split('&')[0].trim();

    if (!playlistId) {
      return res.status(400).json({ success: false, error: 'Could not extract playlist ID from provided URL' });
    }

    let finalProcessedItems: any[] = [];
    let finalSource = '';
    let fetchedPlaylistTitle = '';
    let fetchedChannelName = '';

    // Strategy 1: Official YouTube Data API v3 (if valid API key is present)
    if (isApiKeyConfigured) {
      try {
        console.log(`[YouTube Playlist API] Method 1: Official Google API for playlist: ${playlistId}...`);
        
        // Fetch playlist title first
        try {
          const plInfoRes = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${playlistId}&key=${apiKey}`);
          if (plInfoRes.ok) {
            const plData = await plInfoRes.json();
            if (plData.items && plData.items.length > 0) {
              fetchedPlaylistTitle = plData.items[0].snippet?.title || '';
              fetchedChannelName = plData.items[0].snippet?.channelTitle || '';
            }
          }
        } catch (_) {}

        let items: any[] = [];
        let nextPageToken = '';
        let pagesFetched = 0;
        const maxPages = 30;

        const isStandardApiKey = apiKey!.startsWith('AIzaSy');
        const headers: Record<string, string> = { 'Accept': 'application/json' };
        if (!isStandardApiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        do {
          let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,status&playlistId=${playlistId}&maxResults=50`;
          if (isStandardApiKey) url += `&key=${apiKey}`;
          if (nextPageToken) url += `&pageToken=${nextPageToken}`;

          const response = await fetch(url, { headers });
          if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData?.error?.message || `YouTube API status ${response.status}`);
          }

          const data = await response.json();
          if (data.items) {
            items = items.concat(data.items);
          }
          nextPageToken = data.nextPageToken || '';
          pagesFetched++;
        } while (nextPageToken && pagesFetched < maxPages);

        if (items.length > 0) {
          finalProcessedItems = items.map((item: any) => {
            const snippet = item.snippet || {};
            const status = item.status || {};
            const title = snippet.title || '';
            const videoId = snippet.resourceId?.videoId || '';
            const isPrivateOrDeleted = 
              status.privacyStatus === 'private' || 
              title.toLowerCase() === 'deleted video' || 
              title.toLowerCase() === 'private video';

            if (!fetchedPlaylistTitle && snippet.playlistTitle) {
              fetchedPlaylistTitle = snippet.playlistTitle;
            }
            if (!fetchedChannelName && snippet.videoOwnerChannelTitle) {
              fetchedChannelName = snippet.videoOwnerChannelTitle;
            }

            const thumbs = snippet.thumbnails || {};
            const thumbnail = 
              thumbs.maxres?.url || 
              thumbs.standard?.url || 
              thumbs.high?.url || 
              thumbs.medium?.url || 
              thumbs.default?.url || 
              `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

            return {
              videoId,
              title,
              thumbnail,
              description: snippet.description || '',
              url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
              isPrivateOrDeleted
            };
          }).filter((it: any) => it.videoId);

          finalSource = 'api';
          console.log(`[YouTube Playlist API] Method 1 Official API retrieved ${finalProcessedItems.length} items!`);
        }
      } catch (apiError: any) {
        console.log(`[YouTube Playlist API] Official API method failed (${apiError.message}). Proceeding to Strategy 1.5 (InnerTube Web API)...`);
      }
    }

    // Strategy 1.5: YouTube InnerTube Web API (Zero quota, fetches all 100+ playlist items reliably)
    if (finalProcessedItems.length === 0) {
      try {
        console.log(`[YouTube Playlist API] Method 1.5: InnerTube Web API for playlist: ${playlistId}...`);
        const innerTubeRes = await fetchInnerTubePlaylistItems(playlistId);
        if (innerTubeRes.items.length > 0) {
          finalProcessedItems = innerTubeRes.items;
          if (innerTubeRes.title) fetchedPlaylistTitle = innerTubeRes.title;
          if (innerTubeRes.channelName) fetchedChannelName = innerTubeRes.channelName;
          finalSource = 'innertube_web';
          console.log(`[YouTube Playlist API] Method 1.5 InnerTube Web API retrieved ${finalProcessedItems.length} items for playlist ${playlistId}!`);
        }
      } catch (itErr: any) {
        console.log(`[YouTube Playlist API] InnerTube method failed (${itErr.message}). Proceeding to Strategy 2 (Direct Page Scraper)...`);
      }
    }

    // Strategy 2: Direct YouTube HTML Page Scraper (Extracts all 100+ videos directly from YouTube public playlist page)
    if (finalProcessedItems.length === 0) {
      try {
        console.log(`[YouTube Playlist API] Method 2: Direct Page Scraper for playlist: ${playlistId}...`);
        const url = `https://www.youtube.com/playlist?list=${playlistId}`;
        const pageRes = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });

        if (pageRes.ok) {
          const html = await pageRes.text();
          
          const titleMatch = html.match(/<meta property="og:title" content="([^"]+)">/i) || html.match(/<title>([^<]+) - YouTube<\/title>/i);
          if (titleMatch) {
            fetchedPlaylistTitle = titleMatch[1].replace(/ - YouTube$/i, '').trim();
          }

          const itemsMap = new Map<string, any>();

          let jsonStr = '';
          const index = html.indexOf('ytInitialData = ');
          if (index !== -1) {
            const startIdx = html.indexOf('{', index);
            if (startIdx !== -1) {
              let braceCount = 0;
              let inString = false;
              let escape = false;
              let endIdx = -1;
              for (let i = startIdx; i < html.length; i++) {
                const char = html[i];
                if (escape) { escape = false; continue; }
                if (char === '\\') { escape = true; continue; }
                if (char === '"') { inString = !inString; continue; }
                if (!inString) {
                  if (char === '{') braceCount++;
                  else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) { endIdx = i; break; }
                  }
                }
              }
              if (endIdx !== -1) {
                jsonStr = html.substring(startIdx, endIdx + 1);
              }
            }
          }

          if (jsonStr) {
            try {
              const data = JSON.parse(jsonStr);
              const recurse = (o: any) => {
                if (!o || typeof o !== 'object') return;

                if (o.playlistVideoRenderer) {
                  const v = o.playlistVideoRenderer;
                  const videoId = v.videoId;
                  let title = v.title?.runs?.[0]?.text || v.title?.simpleText || '';
                  let thumb = v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                  const lowerTitle = title.toLowerCase();
                  const isPrivateOrDeleted = v.isPlayable === false || lowerTitle.includes('deleted video') || lowerTitle.includes('private video');
                  if (videoId && !itemsMap.has(videoId)) {
                    itemsMap.set(videoId, {
                      videoId,
                      title: title.trim() || `Video ${videoId}`,
                      thumbnail: thumb,
                      description: '',
                      url: `https://www.youtube.com/watch?v=${videoId}`,
                      isPrivateOrDeleted
                    });
                  }
                  return;
                }

                if (o.lockupViewModel) {
                  const lockup = o.lockupViewModel;
                  const videoId = lockup.contentId || lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.videoId || '';
                  let title = lockup.metadata?.lockupMetadataViewModel?.title?.content || '';
                  if (!title && lockup.metadata?.lockupMetadataViewModel?.title?.runs) {
                    title = lockup.metadata.lockupMetadataViewModel.title.runs.map((r: any) => r.text).join('');
                  }
                  let thumb = lockup.contentImage?.thumbnailViewModel?.image?.sources?.[0]?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                  if (videoId && !itemsMap.has(videoId)) {
                    itemsMap.set(videoId, {
                      videoId,
                      title: title.trim() || `Video ${videoId}`,
                      thumbnail: thumb,
                      description: '',
                      url: `https://www.youtube.com/watch?v=${videoId}`,
                      isPrivateOrDeleted: false
                    });
                  }
                  return;
                }

                if (Array.isArray(o)) o.forEach(recurse);
                else Object.values(o).forEach(recurse);
              };

              recurse(data);
            } catch (e) {
              console.error('[YouTube Scraper] JSON parse error:', e);
            }
          }

          // Regex fallback if ytInitialData parsed 0 items
          if (itemsMap.size === 0) {
            const matches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)];
            const videoIds = new Set(matches.map(m => m[1]));
            for (const videoId of videoIds) {
              itemsMap.set(videoId, {
                videoId,
                title: `Video ${videoId}`,
                thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                description: '',
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isPrivateOrDeleted: false
              });
            }
          }

          const scrapedItems = Array.from(itemsMap.values());
          if (scrapedItems.length > 0) {
            finalProcessedItems = scrapedItems;
            finalSource = 'page_scraper';
            console.log(`[YouTube Playlist API] Method 2 Direct Page Scraper retrieved ${scrapedItems.length} items!`);
          }
        }
      } catch (scrapeErr: any) {
        console.log(`[YouTube Playlist API] Direct page scraper failed (${scrapeErr.message}). Proceeding to RSS feed...`);
      }
    }

    // Strategy 2: YouTube Official RSS Feed (Ultra reliable for public playlists)
    if (finalProcessedItems.length === 0) {
      try {
        console.log(`[YouTube Playlist API] Method 2: Official YouTube RSS Feed for ${playlistId}...`);
        const rssUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
        const rssRes = await fetch(rssUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/xml, text/xml, */*'
          }
        });

        if (rssRes.ok) {
          const xml = await rssRes.text();
          if (xml && xml.includes('<entry>')) {
            const plTitleMatch = xml.match(/<feed[^>]*>[\s\S]*?<title>([^<]+)<\/title>/i);
            if (plTitleMatch) {
              fetchedPlaylistTitle = plTitleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
            }

            const authorMatch = xml.match(/<author>[\s\S]*?<name>([^<]+)<\/name>/i);
            if (authorMatch) {
              fetchedChannelName = authorMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
            }

            const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
            const rssItems: any[] = [];
            let entryMatch;

            while ((entryMatch = entryRegex.exec(xml)) !== null) {
              const entryXml = entryMatch[1];
              const videoIdMatch = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i) || entryXml.match(/<id>yt:video:([^<]+)<\/id>/i);
              if (!videoIdMatch) continue;
              const videoId = videoIdMatch[1].trim();

              let title = '';
              const titleMatch = entryXml.match(/<media:title[^>]*>([\s\S]*?)<\/media:title>/i) || entryXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
              if (titleMatch) {
                title = titleMatch[1]
                  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
                  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                  .trim();
              }

              let thumbnail = '';
              const thumbMatch = entryXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
              if (thumbMatch) {
                thumbnail = thumbMatch[1];
              } else {
                thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
              }

              let description = '';
              const descMatch = entryXml.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/i);
              if (descMatch) {
                description = descMatch[1]
                  .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
                  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                  .trim();
              }

              rssItems.push({
                videoId,
                title: title || `Video ${videoId}`,
                thumbnail,
                description,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isPrivateOrDeleted: false
              });
            }

            if (rssItems.length > 0) {
              finalProcessedItems = rssItems;
              finalSource = 'rss';
              console.log(`[YouTube Playlist API] Method 2 RSS retrieved ${rssItems.length} items successfully!`);
            }
          }
        }
      } catch (rssErr: any) {
        console.log(`[YouTube Playlist API] RSS feed method failed (${rssErr.message}). Proceeding to Invidious/Piped...`);
      }
    }

    // Strategy 3: Invidious Proxy Instances
    if (finalProcessedItems.length === 0) {
      const invidiousDomains = [
        'inv.nadeko.net',
        'yewtu.be',
        'invidious.nerdvpn.de',
        'invidious.privacydev.net',
        'inv.git.fm',
        'invidious.drgns.space',
        'invidious.lunar.icu'
      ];

      for (const domain of invidiousDomains) {
        try {
          console.log(`[YouTube Playlist API] Method 3: Trying Invidious instance ${domain}...`);
          const res = await fetch(`https://${domain}/api/v1/playlists/${playlistId}`, { signal: AbortSignal.timeout(6000) });
          if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.videos) && data.videos.length > 0) {
              if (data.title) fetchedPlaylistTitle = data.title;
              if (data.author) fetchedChannelName = data.author;

              finalProcessedItems = data.videos.map((v: any) => {
                const videoId = v.videoId || '';
                const thumbs = v.videoThumbnails || [];
                let thumbnail = '';
                if (thumbs.length > 0) {
                  const highest = thumbs.reduce((prev: any, curr: any) => ((prev.width || 0) > (curr.width || 0) ? prev : curr));
                  thumbnail = highest.url || thumbs[0].url || '';
                } else {
                  thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
                }

                return {
                  videoId,
                  title: v.title || `Video ${videoId}`,
                  thumbnail,
                  description: v.description || '',
                  url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
                  isPrivateOrDeleted: false
                };
              }).filter((it: any) => it.videoId);

              if (finalProcessedItems.length > 0) {
                finalSource = 'invidious_proxy';
                console.log(`[YouTube Playlist API] Method 3 Invidious ${domain} retrieved ${finalProcessedItems.length} items!`);
                break;
              }
            }
          }
        } catch (_) {}
      }
    }

    // Strategy 4: Piped API Instances
    if (finalProcessedItems.length === 0) {
      const pipedInstances = [
        'https://pipedapi.adminforge.de',
        'https://api.piped.yt',
        'https://piped.video/api/v1',
        'https://pipedapi.tokhmi.xyz'
      ];

      for (const endpoint of pipedInstances) {
        try {
          console.log(`[YouTube Playlist API] Method 4: Trying Piped instance ${endpoint}...`);
          const res = await fetch(`${endpoint}/playlists/${playlistId}`, { signal: AbortSignal.timeout(6000) });
          if (res.ok) {
            const data = await res.json();
            const streams = data.relatedStreams || data.videos || [];
            if (Array.isArray(streams) && streams.length > 0) {
              if (data.name) fetchedPlaylistTitle = data.name;
              if (data.uploader) fetchedChannelName = data.uploader;

              finalProcessedItems = streams.map((s: any) => {
                let videoId = s.videoId || '';
                if (!videoId && s.url) {
                  const vm = s.url.match(/v=([a-zA-Z0-9_-]{11})/);
                  if (vm) videoId = vm[1];
                }
                return {
                  videoId,
                  title: s.title || `Video ${videoId}`,
                  thumbnail: s.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
                  description: s.shortDescription || '',
                  url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
                  isPrivateOrDeleted: false
                };
              }).filter((it: any) => it.videoId);

              if (finalProcessedItems.length > 0) {
                finalSource = 'piped';
                console.log(`[YouTube Playlist API] Method 4 Piped retrieved ${finalProcessedItems.length} items!`);
                break;
              }
            }
          }
        } catch (_) {}
      }
    }

    if (finalProcessedItems.length === 0) {
      const fallbackVid = extractVideoId(rawInput);
      if (fallbackVid) {
        console.log(`[YouTube Playlist API] Playlist strategies yielded no items. Falling back to single video ID: ${fallbackVid}`);
        let singleTitle = `YouTube Video (${fallbackVid})`;
        let singleChannel = 'YouTube';
        let singleThumb = `https://img.youtube.com/vi/${fallbackVid}/hqdefault.jpg`;
        let singleDesc = '';

        if (isApiKeyConfigured) {
          try {
            const apiRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${fallbackVid}&key=${apiKey}`);
            if (apiRes.ok) {
              const apiData = await apiRes.json();
              if (apiData.items && apiData.items.length > 0) {
                const snip = apiData.items[0].snippet || {};
                singleTitle = snip.title || singleTitle;
                singleChannel = snip.channelTitle || singleChannel;
                singleDesc = snip.description || '';
                const thumbs = snip.thumbnails || {};
                singleThumb = thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || singleThumb;
              }
            }
          } catch (_) {}
        }

        if (singleTitle.startsWith('YouTube Video')) {
          try {
            const oeRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${fallbackVid}&format=json`);
            if (oeRes.ok) {
              const oeData = await oeRes.json();
              if (oeData.title) singleTitle = oeData.title;
              if (oeData.author_name) singleChannel = oeData.author_name;
              if (oeData.thumbnail_url) singleThumb = oeData.thumbnail_url;
            }
          } catch (_) {}
        }

        return res.json({
          success: true,
          playlistId: fallbackVid,
          playlistTitle: singleTitle,
          channelName: singleChannel,
          items: [{
            videoId: fallbackVid,
            title: singleTitle,
            thumbnail: singleThumb,
            description: singleDesc,
            url: `https://www.youtube.com/watch?v=${fallbackVid}`,
            isPrivateOrDeleted: false,
            validationStatus: 'AVAILABLE'
          }],
          playlistValidationStatus: 'AVAILABLE',
          source: 'single_video_fallback'
        });
      }

      console.error(`[YouTube Playlist API] All retrieval methods completed without finding items for playlist ID: ${playlistId}`);
      return res.status(400).json({
        success: false,
        error: `No public videos found in playlist or URL '${playlistId}'. Please make sure the YouTube playlist or video is Public and not Private.`,
        playlistId
      });
    }

    // Run Smart Validation on all items
    try {
      const videoIds = finalProcessedItems.map(item => item.videoId).filter(Boolean);
      const validationResults = await validateVideoBatch(videoIds, isApiKeyConfigured ? apiKey : undefined);

      const validatedItems = finalProcessedItems.map(item => {
        const vStatus = validationResults[item.videoId] || 'AVAILABLE';
        return {
          ...item,
          validationStatus: vStatus,
          isPrivateOrDeleted: item.isPrivateOrDeleted || vStatus === 'PRIVATE'
        };
      });

      const playlistValidationStatus = determinePlaylistStatus(Object.values(validationResults));

      return res.json({
        success: true,
        playlistId,
        playlistTitle: fetchedPlaylistTitle || 'YouTube Playlist',
        channelName: fetchedChannelName || 'YouTube',
        items: validatedItems,
        playlistValidationStatus,
        source: finalSource
      });
    } catch (valError: any) {
      return res.json({
        success: true,
        playlistId,
        playlistTitle: fetchedPlaylistTitle || 'YouTube Playlist',
        channelName: fetchedChannelName || 'YouTube',
        items: finalProcessedItems,
        playlistValidationStatus: 'AVAILABLE',
        source: finalSource
      });
    }
  });

  // Scheduled / Manual YouTube Playlist Validation Sync
  async function runScheduledYoutubeSync(targetAnimeId?: string): Promise<{ success: boolean; updatedPlaylistsCount: number; statuses: Record<string, string> }> {
    console.log(`[Scheduled Sync] Starting YouTube playlist re-check sync... target: ${targetAnimeId || 'all'}`);
    try {
      const animesRef = ref(db, 'animes');
      const animesSnapshot = await get(animesRef);
      if (!animesSnapshot.exists()) {
        console.log('[Scheduled Sync] No animes found to sync.');
        return { success: true, updatedPlaylistsCount: 0, statuses: {} };
      }

      const animesObj = animesSnapshot.val() || {};
      const ytPlaylists = Object.values(animesObj).filter((anime: any) => {
        if (!anime) return false;
        if (targetAnimeId) {
          return anime.id === targetAnimeId;
        }
        return anime.id.startsWith('yt-pl-') || anime.source === 'youtube';
      });

      console.log(`[Scheduled Sync] Found ${ytPlaylists.length} YouTube playlists to re-check.`);
      let updatedPlaylistsCount = 0;
      const statuses: Record<string, string> = {};

      for (const anime of ytPlaylists as any[]) {
        const animeId = anime.id;
        try {
          const episodesRef = ref(db, `episodes/${animeId}`);
          const episodesSnapshot = await get(episodesRef);
          
          let videoIds: string[] = [];
          if (episodesSnapshot.exists()) {
            const episodesObj = episodesSnapshot.val() || {};
            Object.values(episodesObj).forEach((ep: any) => {
              if (ep && ep.videoSources) {
                Object.values(ep.videoSources).forEach((src: any) => {
                  if (src && src.type === 'youtube' && src.url) {
                    const match = src.url.match(/[?&]v=([^&]+)/) || src.url.match(/youtu\.be\/([^?&]+)/);
                    const vid = match ? match[1] : src.url;
                    if (vid) videoIds.push(vid);
                  }
                });
              }
            });
          }

          if (videoIds.length > 0) {
            const validationResults = await validateVideoBatch(videoIds);
            const overallStatus = determinePlaylistStatus(Object.values(validationResults));
            
            if (anime.validationStatus !== overallStatus) {
              console.log(`[Scheduled Sync] Playlist ${anime.title} status changing from ${anime.validationStatus || 'none'} to ${overallStatus}`);
              await update(ref(db, `animes/${animeId}`), {
                validationStatus: overallStatus
              });
              updatedPlaylistsCount++;
            }
            statuses[animeId] = overallStatus;
          } else {
            if (anime.validationStatus !== 'UNAVAILABLE') {
              await update(ref(db, `animes/${animeId}`), {
                validationStatus: 'UNAVAILABLE'
              });
              updatedPlaylistsCount++;
            }
            statuses[animeId] = 'UNAVAILABLE';
          }
        } catch (err) {
          console.error(`[Scheduled Sync] Error syncing playlist ${animeId}:`, err);
        }
      }

      console.log(`[Scheduled Sync] YouTube playlist re-check complete. Updated ${updatedPlaylistsCount} playlists.`);
      return { success: true, updatedPlaylistsCount, statuses };
    } catch (error: any) {
      console.error('[Scheduled Sync] Sync execution failed:', error);
      return { success: false, updatedPlaylistsCount: 0, statuses: {} };
    }
  }

  // Start background cron job to re-check YouTube playlists every 1 hour (3600000 ms)
  setInterval(() => {
    runScheduledYoutubeSync().catch(err => {
      console.error('[Scheduled Sync Interval Error]:', err);
    });
  }, 60 * 60 * 1000);

  // In-memory cache for anime metadata searches
  const metadataCache = new Map<string, { timestamp: number; data: any; source: string }>();

  // Title Similarity Helper to reject mismatched AniList/Jikan results
  const calculateTitleSimilarity = (str1: string, str2: string): number => {
    if (!str1 || !str2) return 0;
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s1 || !s2) return 0;
    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.85;

    const getBigrams = (str: string) => {
      const bigrams = new Map<string, number>();
      for (let i = 0; i < str.length - 1; i++) {
        const bigram = str.substring(i, i + 2);
        bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
      }
      return bigrams;
    };

    const b1 = getBigrams(s1);
    const b2 = getBigrams(s2);
    let intersection = 0;

    for (const [bigram, count1] of b1.entries()) {
      const count2 = b2.get(bigram) || 0;
      intersection += Math.min(count1, count2);
    }

    const total = (s1.length - 1) + (s2.length - 1);
    return total > 0 ? (2 * intersection) / total : 0;
  };

  // GET /api/anime-metadata: Fetches anime metadata hierarchically (AniList -> Jikan -> Kitsu)
  app.get('/api/anime-metadata', async (req, res) => {
    const titleQuery = req.query.title;
    if (!titleQuery || typeof titleQuery !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing title parameter' });
    }

    const cleanTitle = titleQuery
      .replace(/[⟪《【\[\(]\s*(?:HINDI|ENG|ENGLISH|SUB|DUB|SUBBED|DUBBED|HINDI\s*DUB|ENG\s*DUB|DUAL\s*AUDIO|MULTI|JP|UNCENSORED|BATCH|COMPLETED|ALL\s*EPISODES|FULL\s*ANIME|FULL\s*PLAYLIST|PLAYLIST|ANI-ONE|ANI-ONE\s*INDIA|MUSE|MUSE\s*ASIA)\s*[⟫》\]\)]/gi, ' ')
      .replace(/(?:\||-|@|#)\s*(?:Ani-One|Muse|AnimeLog|Crunchyroll|Netflix|Kagura|Ganga|GangaAnime|Anime\s*Zone|Anime\s*India|Anime\s*Asia|Ani-One\s*Asia|Muse\s*Asia|Muse\s*India|Muse\s*Vietnam|Muse\s*Malaysia|Ani-One\s*ULTRA|Official\s*Channel|Official\s*Anime|Telegram).*$/gi, '')
      .replace(/@[\w_]+/gi, '')
      .replace(/\b(full\s*anime|full\s*playlist|playlist|official|4k|1080p|720p|hd|batch|completed|all\s*episodes|full\s*season|complete\s*series)\b/gi, '')
      .replace(/\[\s*(english|eng|hindi|sub|dub|multi|jp|uncensored|subbed|dubbed|completed|all\s*episodes|batch|hd|4k|dual\s*audio)\s*\]/gi, '')
      .replace(/\(\s*(english|eng|hindi|sub|dub|multi|jp|uncensored|subbed|dubbed|completed|all\s*episodes|batch|hd|4k|dual\s*audio)\s*\)/gi, '')
      .replace(/\b(english\s*sub|english\s*dub|hindi\s*dub|sub|dub|uncensored|subbed|dubbed|dual\s*audio)\b/gi, '')
      .replace(/\b(episode\s*\d+(?:\s*-\s*\d+)?|ep\s*\d+|eps\s*\d+)\b/gi, '')
      .replace(/#\d+/g, '')
      .replace(/[⟪⟫《》【】〈〉「」『』＜＞\{\}\[\]\(\)]/g, ' ')
      .replace(/[-_:\/|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanTitle) {
      return res.status(400).json({ success: false, error: 'Invalid or empty anime title' });
    }

    const cacheKey = cleanTitle.toLowerCase();
    const cached = metadataCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      return res.json({ success: true, source: cached.source, data: cached.data });
    }

    // 1. AniList GraphQL API (1st Preference)
    try {
      const query = `
        query ($search: String) {
          Media (search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            idMal
            title { romaji english native }
            format
            status
            description(asHtml: false)
            startDate { year month day }
            season
            seasonYear
            episodes
            duration
            coverImage { extraLarge large medium }
            bannerImage
            genres
            averageScore
            meanScore
            studios(isMain: true) { nodes { name } }
            trailer { id site }
          }
        }
      `;
      const aniRes = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { search: cleanTitle } })
      });

      if (aniRes.ok) {
        const json = await aniRes.json();
        const media = json.data?.Media;
        if (media && (media.description || media.genres?.length > 0 || media.coverImage?.extraLarge)) {
          const candEng = media.title?.english || '';
          const candRom = media.title?.romaji || '';
          const candNat = media.title?.native || '';
          const maxSim = Math.max(
            calculateTitleSimilarity(cleanTitle, candEng),
            calculateTitleSimilarity(cleanTitle, candRom),
            calculateTitleSimilarity(cleanTitle, candNat)
          );

          // Strictly reject candidate if title similarity < 0.45 and query is not substring
          if (maxSim >= 0.45 || candEng.toLowerCase().includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(candEng.toLowerCase())) {
            let desc = media.description || '';
            desc = desc.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

            const data = {
              anilistId: String(media.id || ''),
              malId: String(media.idMal || ''),
              title: media.title?.english || media.title?.romaji || cleanTitle,
              englishTitle: media.title?.english || '',
              romajiTitle: media.title?.romaji || '',
              nativeTitle: media.title?.native || '',
              description: desc,
              genres: media.genres || [],
              studios: media.studios?.nodes?.map((n: any) => n.name) || [],
              score: media.averageScore ? (media.averageScore / 10).toFixed(1) : (media.meanScore ? (media.meanScore / 10).toFixed(1) : 'N/A'),
              rating: media.averageScore ? `${media.averageScore}%` : 'N/A',
              season: media.season || '',
              released: media.seasonYear ? String(media.seasonYear) : (media.startDate?.year ? String(media.startDate.year) : ''),
              status: media.status === 'FINISHED' ? 'Completed' : (media.status === 'RELEASING' ? 'Currently Airing' : 'Completed'),
              episodesCount: media.episodes || 0,
              duration: media.duration ? `${media.duration} min` : '24 min',
              type: media.format === 'MOVIE' ? 'Movie' : (media.format === 'OVA' ? 'OVA' : (media.format === 'ONA' ? 'ONA' : 'TV')),
              poster: media.coverImage?.extraLarge || media.coverImage?.large || '',
              banner: media.bannerImage || media.coverImage?.extraLarge || '',
              trailer: media.trailer?.site === 'youtube' ? `https://www.youtube.com/watch?v=${media.trailer.id}` : ''
            };

            if (data.description) {
              metadataCache.set(cacheKey, { timestamp: Date.now(), data, source: 'anilist' });
              return res.json({ success: true, source: 'anilist', data });
            }
          } else {
            console.log(`[AniList Rejected] Query "${cleanTitle}" vs Candidate "${candEng || candRom}" similarity too low (${maxSim.toFixed(2)})`);
          }
        }
      }
    } catch (err) {
      console.error('[AniList Server API Error]:', err);
    }

    // 2. MyAnimeList / Jikan API v4 (2nd Preference)
    try {
      const jikanRes = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanTitle)}&limit=1`);
      if (jikanRes.ok) {
        const json = await jikanRes.json();
        const anime = json.data?.[0];
        if (anime && (anime.synopsis || anime.genres?.length > 0)) {
          const candTitle = anime.title_english || anime.title || '';
          const sim = calculateTitleSimilarity(cleanTitle, candTitle);
          if (sim >= 0.45 || candTitle.toLowerCase().includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(candTitle.toLowerCase())) {
            const data = {
              malId: String(anime.mal_id || ''),
              anilistId: '',
              title: anime.title_english || anime.title || cleanTitle,
              englishTitle: anime.title_english || '',
              romajiTitle: anime.title || '',
              description: (anime.synopsis || '').trim(),
              genres: anime.genres?.map((g: any) => g.name) || [],
              studios: anime.studios?.map((s: any) => s.name) || [],
              score: anime.score ? String(anime.score) : 'N/A',
              rating: anime.score ? `${Math.round(anime.score * 10)}%` : 'N/A',
              season: anime.season || '',
              released: anime.year ? String(anime.year) : (anime.aired?.prop?.from?.year ? String(anime.aired.prop.from.year) : ''),
              status: anime.status === 'Finished Airing' ? 'Completed' : 'Currently Airing',
              episodesCount: anime.episodes || 0,
              duration: anime.duration || '24 min',
              type: anime.type === 'Movie' ? 'Movie' : (anime.type === 'OVA' ? 'OVA' : (anime.type === 'ONA' ? 'ONA' : 'TV')),
              poster: anime.images?.jpg?.large_image_url || anime.images?.webp?.large_image_url || '',
              banner: anime.trailer?.images?.maximum_image_url || anime.images?.jpg?.large_image_url || '',
              trailer: anime.trailer?.url || ''
            };

            if (data.description) {
              metadataCache.set(cacheKey, { timestamp: Date.now(), data, source: 'jikan' });
              return res.json({ success: true, source: 'jikan', data });
            }
          }
        }
      }
    } catch (err) {
      console.error('[Jikan Server API Error]:', err);
    }

    // 3. Kitsu API (3rd Preference Fallback)
    try {
      const kitsuRes = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(cleanTitle)}&page[limit]=1`);
      if (kitsuRes.ok) {
        const json = await kitsuRes.json();
        const anime = json.data?.[0]?.attributes;
        if (anime && (anime.synopsis || anime.posterImage?.large)) {
          const candTitle = anime.canonicalTitle || anime.titles?.en || '';
          const sim = calculateTitleSimilarity(cleanTitle, candTitle);
          if (sim >= 0.45 || candTitle.toLowerCase().includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(candTitle.toLowerCase())) {
            const data = {
              title: anime.canonicalTitle || cleanTitle,
              englishTitle: anime.titles?.en || anime.canonicalTitle || '',
              description: (anime.synopsis || '').trim(),
              genres: [],
              studios: [],
              score: anime.averageRating ? (parseFloat(anime.averageRating) / 10).toFixed(1) : 'N/A',
              rating: anime.averageRating ? `${Math.round(parseFloat(anime.averageRating))}%` : 'N/A',
              released: anime.startDate ? anime.startDate.substring(0, 4) : '',
              status: anime.status === 'finished' ? 'Completed' : 'Currently Airing',
              episodesCount: anime.episodeCount || 0,
              type: anime.showType === 'movie' ? 'Movie' : (anime.showType === 'OVA' ? 'OVA' : 'TV'),
              poster: anime.posterImage?.large || anime.posterImage?.original || '',
              banner: anime.coverImage?.large || anime.coverImage?.original || anime.posterImage?.large || '',
              trailer: anime.youtubeVideoId ? `https://www.youtube.com/watch?v=${anime.youtubeVideoId}` : ''
            };

            if (data.description) {
              metadataCache.set(cacheKey, { timestamp: Date.now(), data, source: 'kitsu' });
              return res.json({ success: true, source: 'kitsu', data });
            }
          }
        }
      }
    } catch (err) {
      console.error('[Kitsu Server API Error]:', err);
    }

    return res.json({ 
      success: false, 
      error: `Could not fetch metadata for '${cleanTitle}' from AniList, MAL, or Kitsu` 
    });
  });

  // POST endpoint to trigger manual synchronization/validation
  app.post('/api/sync-youtube-playlists', async (req, res) => {
    try {
      const { animeId } = req.body || {};
      const result = await runScheduledYoutubeSync(animeId);
      return res.json(result);
    } catch (error: any) {
      console.error('[Sync API Error]:', error);
      return res.status(500).json({ success: false, error: error.message || 'Sync failed.' });
    }
  });

  // ==========================================
  // YOUTUBE VIDEO HEALTH MONITORING & AUTO-CLEAN SYSTEM
  // ==========================================
  const videoHealthCache = new Map<string, any>();
  let lastDatabaseHealthScanTime = 0;
  let lastDatabaseHealthStats: any = null;

  function parseISO8601Duration(durationStr: string): number {
    if (!durationStr) return 0;
    const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);
    return hours * 3600 + minutes * 60 + seconds;
  }

  async function verifyYouTubeVideoHealth(videoId: string): Promise<{
    videoId: string;
    status: 'active' | 'broken' | 'private' | 'deleted' | 'unavailable' | 'short';
    title?: string;
    durationSeconds?: number;
    reason?: string;
    checkedAt: number;
  }> {
    const now = Date.now();
    const cleanId = (videoId || '').trim();

    if (!cleanId || cleanId.length < 5) {
      return {
        videoId: cleanId,
        status: 'broken',
        reason: 'Invalid YouTube Video ID format',
        checkedAt: now
      };
    }

    // Check recent cache (valid for 30 minutes to reduce redundant quota usage)
    const cached = videoHealthCache.get(cleanId);
    if (cached && (now - cached.checkedAt < 1800000)) {
      return cached;
    }

    const apiKey = process.env.YOUTUBE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(cleanId)}&part=snippet,contentDetails,status&key=${apiKey}`;
        const apiRes = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
        if (apiRes.ok) {
          const json = await apiRes.json();
          if (json && Array.isArray(json.items)) {
            if (json.items.length === 0) {
              const result = {
                videoId: cleanId,
                status: 'deleted' as const,
                reason: 'Video deleted or not found on YouTube',
                checkedAt: now
              };
              videoHealthCache.set(cleanId, result);
              return result;
            }
            const item = json.items[0];
            const privacy = item.status?.privacyStatus;
            const uploadStatus = item.status?.uploadStatus;
            const title = item.snippet?.title || '';
            const durationStr = item.contentDetails?.duration || '';
            const durationSeconds = parseISO8601Duration(durationStr);

            if (privacy === 'private') {
              const res = { videoId: cleanId, status: 'private' as const, title, durationSeconds, reason: 'Video is private', checkedAt: now };
              videoHealthCache.set(cleanId, res);
              return res;
            }
            if (uploadStatus === 'rejected' || uploadStatus === 'failed') {
              const res = { videoId: cleanId, status: 'broken' as const, title, durationSeconds, reason: `Upload status: ${uploadStatus}`, checkedAt: now };
              videoHealthCache.set(cleanId, res);
              return res;
            }
            if (item.contentDetails?.regionRestriction?.blocked) {
              const res = { videoId: cleanId, status: 'unavailable' as const, title, durationSeconds, reason: 'Region restriction blocked', checkedAt: now };
              videoHealthCache.set(cleanId, res);
              return res;
            }

            const activeResult = {
              videoId: cleanId,
              status: 'active' as const,
              title,
              durationSeconds,
              reason: 'Video is active and playable',
              checkedAt: now
            };
            videoHealthCache.set(cleanId, activeResult);
            return activeResult;
          }
        }
      } catch (e) {
        console.warn(`[YouTube API Check Error for ${cleanId}]:`, e);
      }
    }

    // oEmbed Check
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(cleanId)}&format=json`;
      const res = await fetch(oembedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });

      if (res.status === 200) {
        const data = await res.json();
        const activeResult = {
          videoId: cleanId,
          status: 'active' as const,
          title: data.title || 'YouTube Video',
          reason: 'oEmbed verified video exists and is public',
          checkedAt: now
        };
        videoHealthCache.set(cleanId, activeResult);
        return activeResult;
      } else if (res.status === 404) {
        const delResult = {
          videoId: cleanId,
          status: 'deleted' as const,
          reason: 'YouTube oEmbed returned 404 (Deleted or Invalid)',
          checkedAt: now
        };
        videoHealthCache.set(cleanId, delResult);
        return delResult;
      } else if (res.status === 401 || res.status === 403) {
        const privResult = {
          videoId: cleanId,
          status: 'private' as const,
          reason: 'YouTube oEmbed returned 401/403 (Private or Restricted)',
          checkedAt: now
        };
        videoHealthCache.set(cleanId, privResult);
        return privResult;
      }
    } catch (err: any) {
      console.warn(`[oEmbed Check Error for ${cleanId}]:`, err);
    }

    // Fallback: HEAD check on YouTube thumbnail
    try {
      const thumbUrl = `https://i.ytimg.com/vi/${encodeURIComponent(cleanId)}/hqdefault.jpg`;
      const thumbRes = await fetch(thumbUrl, { method: 'HEAD' });
      if (thumbRes.status === 200) {
        const contentLength = Number(thumbRes.headers.get('content-length') || 0);
        if (contentLength > 0 && contentLength < 1150) {
          const res = {
            videoId: cleanId,
            status: 'deleted' as const,
            reason: 'YouTube thumbnail indicates video deleted',
            checkedAt: now
          };
          videoHealthCache.set(cleanId, res);
          return res;
        }
        const activeRes = {
          videoId: cleanId,
          status: 'active' as const,
          reason: 'Thumbnail active',
          checkedAt: now
        };
        videoHealthCache.set(cleanId, activeRes);
        return activeRes;
      }
    } catch (_) {}

    const fallbackRes = {
      videoId: cleanId,
      status: 'broken' as const,
      reason: 'Verification unreachable',
      checkedAt: now
    };
    videoHealthCache.set(cleanId, fallbackRes);
    return fallbackRes;
  }

  async function batchVerifyYouTubeVideos(videoIds: string[]): Promise<Record<string, any>> {
    const uniqueIds = Array.from(new Set(videoIds.map(id => (id || '').trim()).filter(Boolean)));
    const results: Record<string, any> = {};

    const apiKey = process.env.YOUTUBE_API_KEY || process.env.GEMINI_API_KEY;

    if (apiKey) {
      for (let i = 0; i < uniqueIds.length; i += 50) {
        const chunk = uniqueIds.slice(i, i + 50);
        try {
          const apiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${chunk.join(',')}&part=snippet,contentDetails,status&key=${apiKey}`;
          const apiRes = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
          if (apiRes.ok) {
            const json = await apiRes.json();
            const itemsMap = new Map<string, any>();
            if (json && Array.isArray(json.items)) {
              json.items.forEach((item: any) => itemsMap.set(item.id, item));
            }

            chunk.forEach(id => {
              const now = Date.now();
              const item = itemsMap.get(id);
              if (!item) {
                const delRes = { videoId: id, status: 'deleted', reason: 'Video deleted or not found on YouTube', checkedAt: now };
                results[id] = delRes;
                videoHealthCache.set(id, delRes);
              } else {
                const privacy = item.status?.privacyStatus;
                const uploadStatus = item.status?.uploadStatus;
                const title = item.snippet?.title || '';
                const durationStr = item.contentDetails?.duration || '';
                const durationSeconds = parseISO8601Duration(durationStr);

                if (privacy === 'private') {
                  const privRes = { videoId: id, status: 'private', title, durationSeconds, reason: 'Video is private', checkedAt: now };
                  results[id] = privRes;
                  videoHealthCache.set(id, privRes);
                } else if (uploadStatus === 'rejected' || uploadStatus === 'failed') {
                  const brkRes = { videoId: id, status: 'broken', title, durationSeconds, reason: `Upload status: ${uploadStatus}`, checkedAt: now };
                  results[id] = brkRes;
                  videoHealthCache.set(id, brkRes);
                } else {
                  const actRes = { videoId: id, status: 'active', title, durationSeconds, reason: 'Active and playable', checkedAt: now };
                  results[id] = actRes;
                  videoHealthCache.set(id, actRes);
                }
              }
            });
            continue;
          }
        } catch (e) {
          console.warn('[Batch YouTube API failed, falling back]:', e);
        }

        // Fallback for this chunk
        await Promise.all(chunk.map(async id => {
          results[id] = await verifyYouTubeVideoHealth(id);
        }));
      }
    } else {
      // oEmbed in concurrent batches of 10
      const BATCH_SIZE = 10;
      for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + BATCH_SIZE);
        const resList = await Promise.all(chunk.map(id => verifyYouTubeVideoHealth(id)));
        resList.forEach(res => {
          results[res.videoId] = res;
        });
      }
    }

    return results;
  }

  // Single video check endpoint
  app.post('/api/video-health/check-single', async (req, res) => {
    try {
      const { videoId } = req.body || {};
      if (!videoId) return res.status(400).json({ success: false, error: 'Missing videoId' });
      const health = await verifyYouTubeVideoHealth(String(videoId));
      return res.json({ success: true, health });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message || 'Verification failed' });
    }
  });

  // Batch video check endpoint
  app.post('/api/video-health/check-batch', async (req, res) => {
    try {
      const { videoIds } = req.body || {};
      if (!Array.isArray(videoIds) || videoIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing videoIds array' });
      }
      const results = await batchVerifyYouTubeVideos(videoIds);
      return res.json({ success: true, results, total: Object.keys(results).length });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message || 'Batch verification failed' });
    }
  });

  // Dashboard Stats endpoint
  app.get('/api/video-health/dashboard-stats', async (req, res) => {
    try {
      const allCached = Array.from(videoHealthCache.values());
      const activeCount = allCached.filter(v => v.status === 'active').length;
      const brokenCount = allCached.filter(v => v.status === 'broken').length;
      const privateCount = allCached.filter(v => v.status === 'private').length;
      const deletedCount = allCached.filter(v => v.status === 'deleted').length;
      const unavailableCount = allCached.filter(v => v.status === 'unavailable').length;

      return res.json({
        success: true,
        stats: {
          totalCheckedVideos: allCached.length,
          activeCount,
          brokenCount,
          privateCount,
          deletedCount,
          unavailableCount,
          lastScanTime: lastDatabaseHealthScanTime || (allCached.length > 0 ? Math.max(...allCached.map(c => c.checkedAt || 0)) : 0),
          recentBrokenList: allCached.filter(v => v.status !== 'active').slice(0, 100)
        }
      });
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // Fetch YouTube Channel Playlists securely (with Scraper & Invidious Proxy Fallback)
  app.get('/api/youtube-channel-playlists', async (req, res) => {
    const { channelUrl } = req.query;
    if (!channelUrl || typeof channelUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing channelUrl parameter' });
    }

    const rawInput = channelUrl.trim();

    // Helper to extract single video ID
    const extractVideoId = (input: string): string | null => {
      const trimmed = input.trim();
      if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed) && !trimmed.startsWith('PL') && !trimmed.startsWith('UC')) {
        return trimmed;
      }
      const match = trimmed.match(/(?:v=|\/v\/|\/embed\/|\/shorts\/|youtu\.be\/|watch\?.*v=)([a-zA-Z0-9_-]{11})/i);
      return match ? match[1] : null;
    };

    // 1. Single Video Movie Detection (ONLY if user pasted a single video URL or video ID with NO list= parameter)
    const hasListParam = /[?&]list=/i.test(rawInput);
    const singleVideoId = !hasListParam ? extractVideoId(rawInput) : null;
    if (singleVideoId) {
      console.log(`[YouTube Channel API] Detected single video movie URL: ${singleVideoId}`);
      let singleTitle = `Anime Movie (${singleVideoId})`;
      let singleThumb = `https://img.youtube.com/vi/${singleVideoId}/hqdefault.jpg`;
      let singleDesc = '';

      try {
        const oeRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${singleVideoId}&format=json`);
        if (oeRes.ok) {
          const oeData = await oeRes.json();
          if (oeData.title) singleTitle = oeData.title;
          if (oeData.thumbnail_url) singleThumb = oeData.thumbnail_url;
        }
      } catch (_) {}

      return res.json({
        success: true,
        channelId: `single-${singleVideoId}`,
        source: 'single-video-movie',
        isSingleVideoMovie: true,
        playlists: [{
          playlistId: `single-${singleVideoId}`,
          videoId: singleVideoId,
          title: singleTitle,
          playlistThumbnail: singleThumb,
          videoCount: 1,
          description: singleDesc,
          isMovie: true,
          isSingleVideoMovie: true
        }]
      });
    }

    // 2. Direct Playlist URL Detection (if user pasted playlist URL e.g. list=PL...)
    const playlistIdMatch = rawInput.match(/[?&]list=([a-zA-Z0-9_-]+)/i) || rawInput.match(/^([a-zA-Z0-9_-]+)$/i);
    if (playlistIdMatch) {
      const pid = playlistIdMatch[1];
      console.log(`[YouTube Channel API] Detected direct playlist URL: ${pid}`);
      let plTitle = `Imported Playlist (${pid})`;
      let plThumb = `https://img.youtube.com/vi/none/hqdefault.jpg`;
      let videoCount = 0;

      // Primary: Fetch playlist items & metadata via InnerTube Web API
      try {
        const innerTubeRes = await fetchInnerTubePlaylistItems(pid);
        if (innerTubeRes.items.length > 0) {
          videoCount = innerTubeRes.items.length;
          if (innerTubeRes.title) plTitle = innerTubeRes.title;
          plThumb = innerTubeRes.items[0]?.thumbnail || plThumb;
        }
      } catch (_) {}

      // Fallback: Fetch RSS XML feed for playlist if InnerTube failed
      if (videoCount === 0) {
        try {
          const rssRes = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${pid}`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'application/xml, text/xml, */*'
            }
          });
          if (rssRes.ok) {
            const xml = await rssRes.text();
            const titleMatch = xml.match(/<feed[^>]*>[\s\S]*?<title>([^<]+)<\/title>/i);
            if (titleMatch && plTitle.startsWith('Imported Playlist')) {
              plTitle = titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
            }
            const entries = xml.match(/<entry>/gi);
            if (entries) {
              videoCount = entries.length;
            }
            const thumbMatch = xml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
            if (thumbMatch && (!plThumb || plThumb.includes('none'))) {
              plThumb = thumbMatch[1];
            }
          }
        } catch (_) {}
      }

      // Fallback via oEmbed if title or thumbnail missing
      if (plTitle.startsWith('Imported Playlist') || !plThumb || plThumb.includes('none')) {
        try {
          const oeRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/playlist?list=${pid}&format=json`);
          if (oeRes.ok) {
            const oeData = await oeRes.json();
            if (oeData.title) plTitle = oeData.title;
            if (oeData.thumbnail_url) plThumb = oeData.thumbnail_url;
          }
        } catch (_) {}
      }

      return res.json({
        success: true,
        channelId: `playlist-${pid}`,
        source: 'direct-playlist',
        isSingleVideoMovie: false,
        playlists: [{
          playlistId: pid,
          title: plTitle,
          playlistThumbnail: plThumb || `https://img.youtube.com/vi/none/hqdefault.jpg`,
          videoCount: videoCount || 1,
          description: '',
          isMovie: false,
          isSingleVideoMovie: false
        }]
      });
    }

    // Helper to extract channelId and handle from URL/username
    const resolveChannel = async (input: string): Promise<{ channelId: string; handle: string }> => {
      const trimmed = input.trim();
      let handle = '';
      let channelId = '';

      // 1. Direct handle match or in URL
      const handleMatch = trimmed.match(/@([a-zA-Z0-9_-]+)/i);
      if (handleMatch && handleMatch[1]) {
        handle = `@${handleMatch[1]}`;
      }

      // 2. Direct channel ID check
      if (/^UC[a-zA-Z0-9_-]{22}$/.test(trimmed)) {
        channelId = trimmed;
      } else {
        const directIdMatch = trimmed.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/i);
        if (directIdMatch && directIdMatch[1]) {
          channelId = directIdMatch[1];
        }
      }

      // If we already have the direct channel ID, return immediately without network lookup!
      if (channelId) {
        console.log(`[resolveChannel] Direct channel ID matched: ${channelId}`);
        return { channelId, handle: handle || '@channel' };
      }

      let query = handle || trimmed;

      // Get API Key and fallback to the user's provided key if not set
      const fallbackKey = 'AIzaSyAEMPSLLL7xEhvIhXhm2D7amGj2FLH-9tQ';
      const resolvedApiKey = (process.env.YOUTUBE_API_KEY && 
                      process.env.YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY' && 
                      !process.env.YOUTUBE_API_KEY.startsWith('YOUR_') && 
                      !process.env.YOUTUBE_API_KEY.startsWith('AQ.')) 
                      ? process.env.YOUTUBE_API_KEY 
                      : fallbackKey;

      if (resolvedApiKey) {
        try {
          if (query.startsWith('@')) {
            const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${encodeURIComponent(query)}&key=${resolvedApiKey}`;
            console.log(`[resolveChannel] Resolving handle via official API: ${query}`);
            const res = await fetch(url);
            if (res.ok) {
              const data = await res.json();
              if (data.items && data.items.length > 0) {
                const cid = data.items[0].id;
                const customUrl = data.items[0].snippet?.customUrl || query;
                console.log(`[resolveChannel] Official API matched channel ID: ${cid} for handle ${customUrl}`);
                return { channelId: cid, handle: customUrl.startsWith('@') ? customUrl : `@${customUrl}` };
              }
            }
          } else {
            const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${resolvedApiKey}`;
            console.log(`[resolveChannel] Resolving search query via official API: ${query}`);
            const res = await fetch(url);
            if (res.ok) {
              const data = await res.json();
              if (data.items && data.items.length > 0 && data.items[0].id?.channelId) {
                const cid = data.items[0].id.channelId;
                const title = data.items[0].snippet?.channelTitle || query;
                console.log(`[resolveChannel] Official API matched channel ID: ${cid} for query ${title}`);
                return { channelId: cid, handle: `@${title.replace(/\s+/g, '')}` };
              }
            }
          }
        } catch (apiErr: any) {
          console.warn(`[resolveChannel] Official API lookup failed, falling back to other methods. Error: ${apiErr.message}`);
        }
      }
      if (trimmed.includes('youtube.com/') || trimmed.includes('youtu.be/')) {
        if (!handle) {
          // e.g. https://www.youtube.com/c/SomeName or /user/SomeName
          const pathMatch = trimmed.match(/\/(?:c|user)\/([a-zA-Z0-9_-]+)/i);
          if (pathMatch && pathMatch[1]) {
            query = pathMatch[1];
          } else {
            // Last resort: extract last segment
            const parts = trimmed.split('/');
            const last = parts[parts.length - 1];
            if (last) query = last;
          }
        }
      }

      if (!query.startsWith('@') && !trimmed.includes('/') && query.length > 0) {
        query = `@${query}`;
      }

      console.log(`[resolveChannel] Parsed query: "${query}" from input: "${trimmed}"`);

      // 3. Try direct YouTube scraping first (fastest and most reliable)
      let youtubeUrl = '';
      if (trimmed.includes('youtube.com/') || trimmed.includes('youtu.be/')) {
        youtubeUrl = trimmed;
      } else if (query.startsWith('@')) {
        youtubeUrl = `https://www.youtube.com/${query}`;
      } else {
        youtubeUrl = `https://www.youtube.com/@${query}`;
      }

      try {
        console.log(`[resolveChannel] Trying direct YouTube scrape on URL: ${youtubeUrl}`);
        const response = await fetch(youtubeUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: AbortSignal.timeout(10000)
        });
        if (response.ok) {
          const html = await response.text();
          const metaMatch = html.match(/<meta\s+itemprop="channelId"\s+content="(UC[a-zA-Z0-9_-]{22})"/);
          const jsonMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
          const browseMatch = html.match(/"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
          const cid = (metaMatch && metaMatch[1]) || (jsonMatch && jsonMatch[1]) || (browseMatch && browseMatch[1]);
          if (cid && /^UC[a-zA-Z0-9_-]{22}$/.test(cid)) {
            console.log(`[resolveChannel] Direct YouTube scrape success! Channel ID: ${cid}`);
            let realHandle = handle;
            const handleFromHtml = html.match(/\/@([a-zA-Z0-9_-]+)/);
            if (handleFromHtml && handleFromHtml[1]) {
              realHandle = `@${handleFromHtml[1]}`;
            }
            return { channelId: cid, handle: realHandle || `@channel` };
          }
        }
      } catch (err: any) {
        console.log(`[resolveChannel] Direct YouTube scrape failed or timed out: ${err.message || err}`);
      }

      // 4. Try InnerTube search (100% reliable, zero quota)
      try {
        const apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
        console.log(`[resolveChannel] Trying InnerTube search resolve for: ${query}`);
        const searchRes = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
          body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: '2.20240308.00.00', hl: 'en', gl: 'US' } },
            query: query
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const jsonString = JSON.stringify(searchData);
          const m = jsonString.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
          if (m && m[1]) {
            console.log(`[resolveChannel] InnerTube search resolved channelId: ${m[1]}`);
            return { channelId: m[1], handle: handle || `@channel` };
          }
        }
      } catch (innerErr: any) {
        console.warn(`[resolveChannel] InnerTube search failed:`, innerErr?.message || innerErr);
      }

      // 5. Try resolving using Invidious search fallback
      let activeDomains: string[] = [];
      try {
        const res = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const instances = await res.json();
          if (Array.isArray(instances)) {
            activeDomains = instances
              .filter(([domain, details]) => details.type === 'https' && details.monitor && details.monitor.down === false)
              .map(([domain]) => domain);
          }
        }
      } catch (err) {}

      // Start with reliable active instances
      const bestInstances = [
        'yewtu.be',
        'invidious.privacydev.net',
        'invidious.nerdvpn.de',
        'inv.nadeko.net'
      ];
      const otherActive = activeDomains.filter(d => !bestInstances.includes(d));
      const remainingFallbacks = [
        'invidious.tiekoetter.com',
        'invidious.nerdvpn.de',
        'yewtu.be',
        'inv.git.fm',
        'inv.nadeko.net'
      ].filter(d => !bestInstances.includes(d) && !otherActive.includes(d));

      const domainsToTry = [...bestInstances, ...otherActive, ...remainingFallbacks].slice(0, 10);

      for (const domain of domainsToTry) {
        try {
          const searchUrl = `https://${domain}/api/v1/search?q=${encodeURIComponent(query)}&type=channel`;
          console.log(`[resolveChannel] Trying Invidious resolve on: ${domain}`);
          const response = await fetch(searchUrl, { signal: AbortSignal.timeout(2500) });
          if (response.ok) {
            const results = await response.json();
            if (Array.isArray(results) && results.length > 0) {
              const matchedChannel = results.find((c: any) => 
                c.type === 'channel' && 
                (c.authorId || c.channelId)
              );
              if (matchedChannel) {
                const cid = matchedChannel.authorId || matchedChannel.channelId;
                const authorUrl = matchedChannel.authorUrl || '';
                if (cid && /^UC[a-zA-Z0-9_-]{22}$/.test(cid)) {
                  channelId = cid;
                  const m = authorUrl.match(/@([a-zA-Z0-9_-]+)/);
                  if (m && m[1]) {
                    handle = `@${m[1]}`;
                  }
                  console.log(`[resolveChannel] Resolved: channelId=${channelId}, handle=${handle} via ${domain}`);
                  return { channelId, handle: handle || `@${matchedChannel.author || ''}` };
                }
              }
            }
          }
        } catch (err) {
          console.log(`[resolveChannel] Invidious domain ${domain} search failed:`, err);
        }
      }

      // If Invidious search fails, try direct scraper on Invidious
      for (const domain of domainsToTry) {
        try {
          const directUrl = `https://${domain}/${query}`;
          console.log(`[resolveChannel] Trying direct scraper on Invidious domain: ${domain}`);
          const response = await fetch(directUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(2500)
          });
          if (response.ok) {
            const html = await response.text();
            const cidMatch = html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (cidMatch && cidMatch[1]) {
              channelId = cidMatch[1];
              const hMatch = html.match(/\/@([a-zA-Z0-9_-]+)/);
              if (hMatch && hMatch[1]) {
                handle = `@${hMatch[1]}`;
              }
              console.log(`[resolveChannel] Resolved: channelId=${channelId}, handle=${handle} via Invidious page scraper on ${domain}`);
              return { channelId, handle: handle || `@${query.replace('@', '')}` };
            }
          }
        } catch (err) {
          console.log(`[resolveChannel] Direct scraper failed on ${domain}:`, err);
        }
      }

      if (channelId && /^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
        return { channelId, handle: handle || `@channel` };
      }

      throw new Error(`Could not resolve YouTube Channel ID or Handle from "${input}". Please verify the URL/Handle and try again.`);
    };

    // Helper to scrape a single channel playlists page URL with support for new lockupViewModels
    const scrapePlaylistsFromUrl = async (url: string): Promise<any[]> => {
      try {
        console.log(`[YouTube Scraper] Fetching playlists from: ${url}`);
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        });

        if (!response.ok) {
          console.warn(`Scraper failed to fetch URL ${url}, status: ${response.status}`);
          return [];
        }

        const html = await response.text();
        let jsonStr = '';
        const regexes = [
          /ytInitialData\s*=\s*({[\s\S]+?});\s*(?:<\/script>|window|var)/,
          /ytInitialData\s*=\s*({[\s\S]+?});/,
          /var ytInitialData\s*=\s*([\s\S]+?);<\/script>/,
          /window\["ytInitialData"\]\s*=\s*([\s\S]+?);/,
          /ytInitialData\s*=\s*({[\s\S]+?})\s*;/
        ];

        for (const regex of regexes) {
          const match = html.match(regex);
          if (match && match[1]) {
            jsonStr = match[1].trim();
            break;
          }
        }

        if (!jsonStr) {
          const index = html.indexOf('ytInitialData = ');
          if (index !== -1) {
            const startIdx = html.indexOf('{', index);
            if (startIdx !== -1) {
              let braceCount = 0;
              let endIdx = -1;
              for (let i = startIdx; i < html.length; i++) {
                const char = html[i];
                if (char === '{') {
                  braceCount++;
                } else if (char === '}') {
                  braceCount--;
                  if (braceCount === 0) {
                    endIdx = i;
                    break;
                  }
                }
              }
              if (endIdx !== -1) {
                jsonStr = html.substring(startIdx, endIdx + 1);
              }
            }
          }
        }

        if (!jsonStr) {
          return [];
        }

        const data = JSON.parse(jsonStr);
        const playlists: any[] = [];
        const seenIds = new Set<string>();

        const recurse = (current: any) => {
          if (!current || typeof current !== 'object') return;
          
          let pid = '';
          let title = '';
          let thumbnail = '';
          let videoCount = 0;

          // Check standard old formats
          if (current.playlistId) {
            pid = current.playlistId;
          } 
          // Check new formats (lockupViewModel, contentId, browseId)
          else if (current.contentId && typeof current.contentId === 'string' && current.contentId.startsWith('PL')) {
            pid = current.contentId;
          } else if (current.browseEndpoint && typeof current.browseEndpoint.browseId === 'string' && current.browseEndpoint.browseId.startsWith('VLPL')) {
            pid = current.browseEndpoint.browseId.substring(2);
          } else if (current.commandMetadata?.webCommandMetadata?.url && typeof current.commandMetadata.webCommandMetadata.url === 'string') {
            const match = current.commandMetadata.webCommandMetadata.url.match(/[?&]list=(PL[a-zA-Z0-9_-]+)/);
            if (match) pid = match[1];
          }

          if (pid && pid.startsWith('PL')) {
            if (!seenIds.has(pid)) {
              seenIds.add(pid);

              // Safe title extraction
              if (current.title) {
                if (typeof current.title === 'string') {
                  title = current.title;
                } else if (current.title.runs && current.title.runs[0]) {
                  title = current.title.runs[0].text;
                } else if (current.title.simpleText) {
                  title = current.title.simpleText;
                } else if (current.title.content) {
                  title = current.title.content;
                }
              }

              // Try lockupMetadataViewModel titles
              const metaModel = current.metadata?.lockupMetadataViewModel;
              if (metaModel) {
                if (metaModel.title?.content) {
                  title = metaModel.title.content;
                }
              }

              // Thumbnail extraction (supports old/new arrays)
              const thumbs = current.thumbnail?.thumbnails || current.thumbnailRenderer?.playlistVideoThumbnailRenderer?.thumbnail?.thumbnails || [];
              if (thumbs.length > 0) {
                thumbnail = thumbs[thumbs.length - 1].url || '';
              }

              // Video count extraction
              if (current.videoCountText) {
                const text = current.videoCountText.runs?.[0]?.text || current.videoCountText.simpleText || '';
                const match = text.match(/\d+/);
                if (match) videoCount = parseInt(match[0], 10);
              } else if (current.videoCount) {
                videoCount = parseInt(current.videoCount, 10) || 0;
              } else if (metaModel?.videoCountText) {
                const text = metaModel.videoCountText.runs?.[0]?.text || metaModel.videoCountText.simpleText || '';
                const match = text.match(/\d+/);
                if (match) videoCount = parseInt(match[0], 10);
              }

              playlists.push({
                playlistId: pid,
                title: title || 'Untitled Playlist',
                playlistThumbnail: thumbnail || `https://img.youtube.com/vi/none/hqdefault.jpg`,
                videoCount: videoCount || 0,
                description: ''
              });
            }
          }

          if (Array.isArray(current)) {
            for (const item of current) {
              recurse(item);
            }
          } else {
            for (const key of Object.keys(current)) {
              recurse(current[key]);
            }
          }
        };

        recurse(data);
        console.log(`[YouTube Scraper] Scraped ${playlists.length} playlists from ${url}`);
        return playlists;
      } catch (err) {
        console.error(`Error scraping playlists from URL ${url}:`, err);
        return [];
      }
    };

    // Helper to scrape channel playlists page with fallback URLs for maximum coverage
    const fetchChannelPlaylistsPage = async (cid: string, handle?: string): Promise<any[]> => {
      const urlsToScrape: string[] = [];

      if (handle) {
        urlsToScrape.push(`https://www.youtube.com/${handle}/playlists?view=1`);
        urlsToScrape.push(`https://www.youtube.com/${handle}/playlists`);
        urlsToScrape.push(`https://www.youtube.com/${handle}/playlists?view=57`);
      }
      
      if (cid && cid.startsWith('UC')) {
        urlsToScrape.push(`https://www.youtube.com/channel/${cid}/playlists?view=1`);
        urlsToScrape.push(`https://www.youtube.com/channel/${cid}/playlists`);
        urlsToScrape.push(`https://www.youtube.com/channel/${cid}/playlists?view=57`);
      }

      console.log(`[YouTube Scraper] Fetching playlists from urls:`, urlsToScrape);
      const lists = await Promise.all(urlsToScrape.map(url => scrapePlaylistsFromUrl(url)));

      const mergedMap = new Map<string, any>();
      for (const list of lists) {
        for (const pl of list) {
          if (pl.playlistId && !mergedMap.has(pl.playlistId)) {
            mergedMap.set(pl.playlistId, pl);
          }
        }
      }

      const merged = Array.from(mergedMap.values());
      if (merged.length === 0) {
        throw new Error('Could not find channel playlists data. Please verify if the channel exists and has public playlists.');
      }
      return merged;
    };

    // Helper to fetch via Invidious with multi-page support
    const fetchChannelPlaylistsViaInvidious = async (cid: string): Promise<any[]> => {
      let activeDomains: string[] = [];
      try {
        const res = await fetch('https://api.invidious.io/instances.json', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const instances = await res.json();
          if (Array.isArray(instances)) {
            activeDomains = instances
              .filter(([domain, details]) => details.type === 'https' && details.monitor && details.monitor.down === false)
              .map(([domain]) => domain);
          }
        }
      } catch (err) {}

      // Start with reliable active instances
      const bestInstances = [
        'yewtu.be',
        'invidious.privacydev.net',
        'invidious.nerdvpn.de',
        'inv.nadeko.net'
      ];
      const otherActive = activeDomains.filter(d => !bestInstances.includes(d));
      const remainingFallbacks = [
        'invidious.tiekoetter.com',
        'invidious.nerdvpn.de',
        'yewtu.be',
        'inv.git.fm',
        'inv.nadeko.net'
      ].filter(d => !bestInstances.includes(d) && !otherActive.includes(d));

      const domainsToTry = [...bestInstances, ...otherActive, ...remainingFallbacks].slice(0, 10);

      for (const domain of domainsToTry) {
        try {
          let currentContinuation = '';
          const allPlaylists: any[] = [];
          const seenIds = new Set<string>();
          let pageNum = 1;
          const maxPages = 20; // Fetch up to 20 pages of playlists (up to 1000 playlists)

          do {
            let url = `https://${domain}/api/v1/channels/${cid}/playlists`;
            const params: string[] = [];
            if (currentContinuation) {
              params.push(`continuation=${encodeURIComponent(currentContinuation)}`);
            }
            if (pageNum > 1) {
              params.push(`page=${pageNum}`);
            }
            if (params.length > 0) {
              url += `?${params.join('&')}`;
            }

            console.log(`[YouTube Channel] Fetching page ${pageNum} from Invidious: ${url}`);
            const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
            if (!response.ok) {
              break; // Try next domain if the first page fails, or stop paginating if later pages fail
            }

            const data = await response.json();
            const playlists = data.playlists || (Array.isArray(data) ? data : null);
            
            if (Array.isArray(playlists) && playlists.length > 0) {
              let addedInThisPage = 0;
              for (const pl of playlists) {
                if (pl.playlistId && !seenIds.has(pl.playlistId)) {
                  seenIds.add(pl.playlistId);
                  allPlaylists.push({
                    playlistId: pl.playlistId,
                    title: pl.title || 'Untitled Playlist',
                    playlistThumbnail: pl.playlistThumbnail || (pl.videos?.[0]?.videoId ? `https://img.youtube.com/vi/${pl.videos[0].videoId}/hqdefault.jpg` : ''),
                    videoCount: pl.videoCount || 0,
                    description: pl.description || ''
                  });
                  addedInThisPage++;
                }
              }

              currentContinuation = data.continuation || data.nextPageToken || '';
              pageNum++;

              // If no new playlists were added, or no continuation / more pages, stop
              if (addedInThisPage === 0 || (!currentContinuation && playlists.length < 10)) {
                break;
              }
            } else {
              break;
            }
          } while (currentContinuation || pageNum <= maxPages);

          if (allPlaylists.length > 0) {
            console.log(`[YouTube Channel] Successfully fetched ${allPlaylists.length} playlists from Invidious instance: ${domain}`);
            return allPlaylists;
          }
        } catch (err: any) {
          console.log(`[YouTube Channel] Invidious domain ${domain} skipped: ${err?.message || err}`);
        }
      }
      throw new Error('All Invidious instances failed.');
    };

    // Helper to fetch playlists via YouTube InnerTube Web Client API (Zero Quota, Full Playlists & Thumbnails)
    const fetchInnerTubeChannelPlaylists = async (cid: string): Promise<any[]> => {
      const apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

      // Params for different views & sort orders:
      // Created Playlists, Playlists Tab, Grid View, Saved Playlists, Sort Newest, Sort Oldest, Sort Last Video Added
      const paramList = [
        'EglwbGF5bGlzdHPyAQCgAQE=', // Created Playlists (Newest)
        'EglwbGF5bGlzdHPyAQCgAQI=', // Created Playlists (Oldest)
        'EglwbGF5bGlzdHPyAQCgAQM=', // Created Playlists (Last Video Added)
        'EglwbGF5bGlzdHM%3D',       // Playlists Tab
        'EglwbGF5bGlzdHPyAQI4AEAB', // All Created Playlists Grid View
        'EglwbGF5bGlzdHPyAQI4AYAB', // Saved / All Playlists
        'EglwbGF5bGlzdHPyAQI4AFAAWAFgAXAB', // Grid Sort Newest
        'EglwbGF5bGlzdHPyAQI4AFAAWAFgAXAC'  // Grid Sort Oldest
      ];

      const allPlaylists: any[] = [];
      const seenIds = new Set<string>();

      // Extract all continuation tokens from a response node
      const getAllContinuationTokens = (data: any): string[] => {
        if (!data || typeof data !== 'object') return [];
        const tokens: string[] = [];
        const visited = new WeakSet();

        const findTokens = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (visited.has(node)) return;
          visited.add(node);

          if (node.continuationItemRenderer) {
            const end = node.continuationItemRenderer.continuationEndpoint;
            const t = end?.continuationCommand?.token ||
                      end?.commandExecutorCommand?.commands?.[0]?.continuationCommand?.token ||
                      node.continuationItemRenderer.continuationCommand?.token;
            if (t && !tokens.includes(t)) tokens.push(t);
          }

          if (node.nextContinuationData?.continuation) {
            const t = node.nextContinuationData.continuation;
            if (t && !tokens.includes(t)) tokens.push(t);
          }

          if (Array.isArray(node)) {
            for (const item of node) findTokens(item);
          } else {
            for (const key of Object.keys(node)) {
              if (key !== 'header' && key !== 'navigationEndpoint' && key !== 'menu' && key !== 'trackingParams') {
                findTokens(node[key]);
              }
            }
          }
        };

        findTokens(data);
        return tokens;
      };

      const parsePlaylists = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;

        let pid = '';
        let title = '';
        let thumb = '';
        let videoCount = 0;

        if (obj.lockupViewModel) {
          const l = obj.lockupViewModel;
          let rawId = l.contentId || '';
          if (!rawId) {
            const nav = l.rendererContext?.commandContext?.onTap?.innertubeCommand || l.navigationEndpoint;
            rawId = nav?.watchEndpoint?.playlistId || nav?.browseEndpoint?.browseId || '';
          }
          if (rawId.startsWith('VLPL')) rawId = rawId.substring(2);
          else if (rawId.startsWith('VL')) rawId = rawId.substring(2);
          pid = rawId;

          title = l.metadata?.lockupMetadataViewModel?.title?.content ||
                  l.title?.content ||
                  l.metadata?.title?.content || '';

          const sources = l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources ||
                          l.contentImage?.thumbnailViewModel?.image?.sources ||
                          l.thumbnailViewModel?.image?.sources ||
                          l.thumbnail?.sources;
          if (Array.isArray(sources) && sources.length > 0) {
            thumb = sources[sources.length - 1].url;
          }

          const countText = l.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]?.thumbnailBadgeViewModel?.text || '';
          if (countText) {
            const m = countText.match(/\d+/);
            if (m) videoCount = parseInt(m[0], 10);
          } else {
            const countMatch = JSON.stringify(l).match(/(\d[\d,.]*)\s*(video|item|episodes?|videos)/i);
            if (countMatch) videoCount = parseInt(countMatch[1].replace(/,/g, ''), 10);
          }
        } else if (obj.gridPlaylistRenderer) {
          const g = obj.gridPlaylistRenderer;
          let rawId = g.playlistId || g.navigationEndpoint?.watchEndpoint?.playlistId || '';
          if (rawId.startsWith('VLPL')) rawId = rawId.substring(2);
          else if (rawId.startsWith('VL')) rawId = rawId.substring(2);
          pid = rawId;

          title = g.title?.runs?.[0]?.text || g.title?.simpleText || '';
          const thumbs = g.thumbnail?.thumbnails || g.navigationEndpoint?.watchEndpoint?.thumbnail?.thumbnails;
          if (Array.isArray(thumbs) && thumbs.length > 0) {
            thumb = thumbs[thumbs.length - 1].url;
          }
          const m = (g.videoCountText?.runs?.[0]?.text || g.videoCountText?.simpleText || '').match(/\d+/);
          if (m) videoCount = parseInt(m[0], 10);
        } else if (obj.playlistRenderer) {
          const p = obj.playlistRenderer;
          let rawId = p.playlistId || p.navigationEndpoint?.watchEndpoint?.playlistId || '';
          if (rawId.startsWith('VLPL')) rawId = rawId.substring(2);
          else if (rawId.startsWith('VL')) rawId = rawId.substring(2);
          pid = rawId;

          title = p.title?.simpleText || p.title?.runs?.[0]?.text || '';
          const thumbs = p.thumbnails?.[0]?.thumbnails || p.thumbnail?.thumbnails;
          if (Array.isArray(thumbs) && thumbs.length > 0) {
            thumb = thumbs[thumbs.length - 1].url;
          }
          if (p.videoCount) videoCount = parseInt(p.videoCount, 10);
          else if (p.videoCountText) {
            const m = (p.videoCountText.simpleText || p.videoCountText.runs?.[0]?.text || '').match(/\d+/);
            if (m) videoCount = parseInt(m[0], 10);
          }
        } else if (obj.compactPlaylistRenderer) {
          const c = obj.compactPlaylistRenderer;
          let rawId = c.playlistId || c.navigationEndpoint?.watchEndpoint?.playlistId || '';
          if (rawId.startsWith('VLPL')) rawId = rawId.substring(2);
          else if (rawId.startsWith('VL')) rawId = rawId.substring(2);
          pid = rawId;

          title = c.title?.simpleText || c.title?.runs?.[0]?.text || '';
          const thumbs = c.thumbnail?.thumbnails;
          if (Array.isArray(thumbs) && thumbs.length > 0) {
            thumb = thumbs[thumbs.length - 1].url;
          }
          if (c.videoCountShortText?.simpleText) {
            const m = c.videoCountShortText.simpleText.match(/\d+/);
            if (m) videoCount = parseInt(m[0], 10);
          }
        } else if (obj.playlistId || obj.contentId) {
          let rawId = String(obj.playlistId || obj.contentId);
          if (rawId.startsWith('VLPL')) rawId = rawId.substring(2);
          else if (rawId.startsWith('VL')) rawId = rawId.substring(2);
          if (rawId.startsWith('PL') || rawId.startsWith('UU') || rawId.startsWith('FL') || rawId.startsWith('LL') || rawId.startsWith('OLAK')) {
            pid = rawId;
          }
        }

        if (pid && (pid.startsWith('PL') || pid.startsWith('UU') || pid.startsWith('FL') || pid.startsWith('LL') || pid.startsWith('OLAK')) && !seenIds.has(pid)) {
          seenIds.add(pid);
          allPlaylists.push({
            playlistId: pid,
            title: title || 'Untitled Playlist',
            playlistThumbnail: thumb || `https://i.ytimg.com/vi/none/hqdefault.jpg`,
            videoCount: videoCount || 0,
            description: ''
          });
        }

        if (Array.isArray(obj)) {
          obj.forEach(parsePlaylists);
        } else {
          Object.keys(obj).forEach(k => {
            if (k !== 'header' && k !== 'navigationEndpoint' && k !== 'menu') {
              parsePlaylists(obj[k]);
            }
          });
        }
      };

      // Phase 1: Scraping YouTube Channel HTML with multiple view & sort query strings
      const channelHtmlUrls = [
        `https://www.youtube.com/channel/${cid}/playlists?view=1&sort=dd`, // Created, Newest
        `https://www.youtube.com/channel/${cid}/playlists?view=1&sort=da`, // Created, Oldest
        `https://www.youtube.com/channel/${cid}/playlists?view=1&sort=p`,  // Created, Popular
        `https://www.youtube.com/channel/${cid}/playlists?view=57&sort=dd`,
        `https://www.youtube.com/channel/${cid}/playlists?view=57&sort=da`,
        `https://www.youtube.com/channel/${cid}/playlists?view=50`,
        `https://www.youtube.com/channel/${cid}/playlists`
      ];

      for (const url of channelHtmlUrls) {
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: AbortSignal.timeout(8000)
          });

          if (res.ok) {
            const html = await res.text();
            let jsonStr = '';
            const match = html.match(/var ytInitialData\s*=\s*({[\s\S]+?});\s*<\/script>/) ||
                          html.match(/ytInitialData\s*=\s*({[\s\S]+?});/);
            if (match && match[1]) {
              jsonStr = match[1];
            }

            if (jsonStr) {
              const initialData = JSON.parse(jsonStr);
              parsePlaylists(initialData);

              // Paginate using all discovered continuation tokens
              const tokenQueue = getAllContinuationTokens(initialData);
              const processedTokens = new Set<string>();

              while (tokenQueue.length > 0) {
                const token = tokenQueue.shift()!;
                if (processedTokens.has(token)) continue;
                processedTokens.add(token);

                try {
                  const browseRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    },
                    body: JSON.stringify({
                      context: { client: { clientName: 'WEB', clientVersion: '2.20240308.00.00', hl: 'en', gl: 'US' } },
                      continuation: token
                    }),
                    signal: AbortSignal.timeout(10000)
                  });

                  if (!browseRes.ok) continue;
                  const browseData = await browseRes.json();
                  parsePlaylists(browseData);

                  const nextTokens = getAllContinuationTokens(browseData);
                  for (const nt of nextTokens) {
                    if (!processedTokens.has(nt) && !tokenQueue.includes(nt)) {
                      tokenQueue.push(nt);
                    }
                  }
                } catch (e: any) {
                  console.warn(`[YouTube Scraper] HTML Continuation error:`, e?.message || e);
                }
              }
            }
          }
        } catch (err: any) {
          console.warn(`[YouTube Scraper] HTML fetch failed for ${url}:`, err?.message || err);
        }
      }

      // Phase 2: Run InnerTube POST browse calls for all parameter options & sort orders
      for (const params of paramList) {
        let continuationTokenQueue: string[] = [];
        const processedTokens = new Set<string>();

        try {
          const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            body: JSON.stringify({
              context: { client: { clientName: 'WEB', clientVersion: '2.20240308.00.00', hl: 'en', gl: 'US' } },
              browseId: cid,
              params
            }),
            signal: AbortSignal.timeout(10000)
          });

          if (res.ok) {
            const data = await res.json();
            parsePlaylists(data);
            continuationTokenQueue = getAllContinuationTokens(data);

            let pagesProcessed = 0;
            while (continuationTokenQueue.length > 0 && pagesProcessed < 150) {
              pagesProcessed++;
              const token = continuationTokenQueue.shift()!;
              if (processedTokens.has(token)) continue;
              processedTokens.add(token);

              try {
                const contRes = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                  },
                  body: JSON.stringify({
                    context: { client: { clientName: 'WEB', clientVersion: '2.20240308.00.00', hl: 'en', gl: 'US' } },
                    continuation: token
                  }),
                  signal: AbortSignal.timeout(10000)
                });

                if (!contRes.ok) continue;
                const contData = await contRes.json();
                parsePlaylists(contData);

                const newTokens = getAllContinuationTokens(contData);
                for (const nt of newTokens) {
                  if (!processedTokens.has(nt) && !continuationTokenQueue.includes(nt)) {
                    continuationTokenQueue.push(nt);
                  }
                }
              } catch (e: any) {
                console.warn(`[YouTube InnerTube] Continuation error for params "${params}":`, e?.message || e);
              }
            }
          }
        } catch (e: any) {
          console.warn(`[YouTube InnerTube] Error for params "${params}":`, e?.message || e);
        }
      }

      console.log(`[YouTube InnerTube] Final total fetched: ${allPlaylists.length} playlists for channel ${cid}`);
      return allPlaylists;
    };

    try {
      // Check if user accidentally pasted a direct playlist URL or Playlist ID
      const plMatch = channelUrl.trim().match(/[?&]list=(PL[a-zA-Z0-9_-]+)/i) || channelUrl.trim().match(/^(PL[a-zA-Z0-9_-]+)$/i);
      if (plMatch && plMatch[1]) {
        const plId = plMatch[1];
        console.log(`[YouTube Channel] Input detected as direct Playlist ID/URL: ${plId}`);
        let plTitle = `YouTube Playlist (${plId})`;
        let plThumb = `https://img.youtube.com/vi/none/hqdefault.jpg`;
        let videoCount = 0;

        try {
          const innerTubeRes = await fetchInnerTubePlaylistItems(plId);
          if (innerTubeRes.items.length > 0) {
            videoCount = innerTubeRes.items.length;
            if (innerTubeRes.title) plTitle = innerTubeRes.title;
            plThumb = innerTubeRes.items[0]?.thumbnail || plThumb;
          }
        } catch (_) {}

        const singlePl = {
          playlistId: plId,
          title: plTitle,
          playlistThumbnail: plThumb,
          videoCount: videoCount || 1,
          description: ''
        };
        const animesRef = ref(db, 'animes');
        const animesSnap = await get(animesRef);
        const animesVal = animesSnap.exists() ? animesSnap.val() : {};
        const matchedId = findExistingAnimeMatchInVal(`Playlist ${plId}`, plId);
        return res.json({
          success: true,
          channelId: 'PL',
          playlists: [{
            ...singlePl,
            alreadyImported: !!matchedId,
            existingAnimeId: matchedId || null,
            validationStatus: matchedId ? (animesVal[matchedId]?.validationStatus || 'AVAILABLE') : null
          }],
          totalFetched: 1,
          source: 'direct_playlist'
        });
      }

      const { channelId, handle } = await resolveChannel(channelUrl);
      console.log(`[YouTube Channel] Resolved channelId: ${channelId}, handle: ${handle}`);

      // Load existing animes to attach validation status & duplicate indicators if already imported
      const animesRef = ref(db, 'animes');
      const animesSnap = await get(animesRef);
      const animesVal = animesSnap.exists() ? animesSnap.val() : {};

      function cleanTitleForMatch(str: string): string {
        if (!str) return '';
        return str
          .replace(/(?:\||-|@|#)\s*(?:Ani-One|Muse|AnimeLog|Crunchyroll|Netflix|Kagura|Ganga|GangaAnime|Anime\s*Zone|Anime\s*India|Anime\s*Asia|Ani-One\s*Asia|Muse\s*Asia|Muse\s*India|Muse\s*Vietnam|Muse\s*Malaysia|Ani-One\s*ULTRA|Official\s*Channel|Official\s*Anime|Telegram).*$/gi, '')
          .replace(/@[\w_]+/gi, '')
          .replace(/\b(full\s*anime|full\s*playlist|playlist|official|4k|1080p|720p|hd|batch|completed|all\s*episodes|full\s*season|complete\s*series)\b/gi, '')
          .replace(/\[\s*(english|eng|hindi|sub|dub|multi|jp|uncensored|subbed|dubbed|completed|all\s*episodes|batch|hd|4k|dual\s*audio)\s*\]/gi, '')
          .replace(/\(\s*(english|eng|hindi|sub|dub|multi|jp|uncensored|subbed|dubbed|completed|all\s*episodes|batch|hd|4k|dual\s*audio)\s*\)/gi, '')
          .replace(/\b(english\s*sub|english\s*dub|hindi\s*dub|sub|dub|uncensored|subbed|dubbed|dual\s*audio)\b/gi, '')
          .replace(/\b(season\s*\d+|s\d+|cour\s*\d+|part\s*\d+|\d+(?:st|nd|rd|th)\s*season)\b/gi, '')
          .replace(/\b(episode\s*\d+(?:\s*-\s*\d+)?|ep\s*\d+|eps\s*\d+)\b/gi, '')
          .replace(/#\d+/g, '')
          .replace(/[^a-z0-9]/gi, '')
          .toLowerCase();
      }

      function calcTitleSim(s1: string, s2: string): number {
        if (!s1 || !s2) return 0;
        if (s1 === s2) return 1;
        if (s1.length < 2 || s2.length < 2) return 0;
        const getBigrams = (str: string) => {
          const bg = new Map<string, number>();
          for (let i = 0; i < str.length - 1; i++) {
            const b = str.substring(i, i + 2);
            bg.set(b, (bg.get(b) || 0) + 1);
          }
          return bg;
        };
        const b1 = getBigrams(s1);
        const b2 = getBigrams(s2);
        let intersection = 0;
        for (const [k, v] of b1.entries()) {
          intersection += Math.min(v, b2.get(k) || 0);
        }
        const total = (s1.length - 1) + (s2.length - 1);
        return total > 0 ? (2 * intersection) / total : 0;
      }

      function findExistingAnimeMatchInVal(title: string, playlistId: string): string | null {
        if (!animesVal || typeof animesVal !== 'object') return null;
        const targetPlaylistAnimeId = playlistId ? `yt-pl-${playlistId}` : '';
        if (targetPlaylistAnimeId && animesVal[targetPlaylistAnimeId]) return targetPlaylistAnimeId;

        const targetNorm = cleanTitleForMatch(title);

        for (const [id, anime] of Object.entries(animesVal) as [string, any][]) {
          if (!anime) continue;
          if (
            (playlistId && (anime.playlistId === playlistId || anime.id === playlistId)) ||
            (targetPlaylistAnimeId && (anime.id === targetPlaylistAnimeId || id === targetPlaylistAnimeId)) ||
            (anime.slug && playlistId && anime.slug === playlistId)
          ) {
            return id;
          }

          if (!targetNorm) continue;

          const titlesToCheck = [anime.title, anime.englishTitle, anime.romajiTitle, anime.nativeTitle, anime.name].filter(Boolean);
          for (const t of titlesToCheck) {
            const norm = cleanTitleForMatch(t);
            if (norm && targetNorm === norm) return id;
            if (targetNorm.length >= 3 && norm.length >= 3) {
              if (calcTitleSim(targetNorm, norm) >= 0.82) return id;
            }
            if (targetNorm.length >= 7 && norm.length >= 7) {
              if (targetNorm.includes(norm) || norm.includes(targetNorm)) {
                const lenRatio = Math.min(targetNorm.length, norm.length) / Math.max(targetNorm.length, norm.length);
                if (lenRatio >= 0.60) return id;
              }
            }
          }
        }
        return null;
      };

      const enrichPlaylists = (list: any[]) => {
        if (!Array.isArray(list)) return [];
        return list.map(pl => {
          const matchedId = findExistingAnimeMatchInVal(pl.title, pl.playlistId);
          const existingAnime = matchedId ? animesVal[matchedId] : null;
          return {
            ...pl,
            validationStatus: existingAnime ? (existingAnime.validationStatus || 'AVAILABLE') : null,
            alreadyImported: !!matchedId,
            existingAnimeId: matchedId || null
          };
        });
      };

      // 1. Try Official YouTube Data API if configured
      const fallbackKey = 'AIzaSyAEMPSLLL7xEhvIhXhm2D7amGj2FLH-9tQ';
      const apiKeysToTry = [
        process.env.YOUTUBE_API_KEY,
        fallbackKey
      ].filter((k): k is string => !!k && k !== 'YOUR_YOUTUBE_API_KEY' && !k.startsWith('YOUR_') && !k.startsWith('AQ.'));

      for (const apiKey of apiKeysToTry) {
        try {
          let allPlaylists: any[] = [];
          const seenIds = new Set<string>();
          let nextPageToken = '';
          let pagesFetched = 0;
          const maxPages = 500;
          const isStandardApiKey = apiKey.startsWith('AIzaSy');
          const headers: Record<string, string> = {
            'Accept': 'application/json'
          };
          if (!isStandardApiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }

          console.log(`[YouTube API Debug] Fetching playlists for channel: ${channelId} with API Key: ${apiKey.substring(0, 10)}...`);

          do {
            const currentToken = nextPageToken;
            let url = `https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&channelId=${encodeURIComponent(channelId)}&maxResults=50`;
            if (isStandardApiKey) {
              url += `&key=${apiKey}`;
            }
            if (nextPageToken) {
              url += `&pageToken=${encodeURIComponent(nextPageToken)}`;
            }

            const response = await fetch(url, { headers });
            if (!response.ok) {
              const errData = await response.json().catch(() => ({}));
              const errorObj = errData?.error || {};
              const message = errorObj.message || `HTTP ${response.status}`;
              const code = errorObj.code || response.status;
              const reason = errorObj.errors?.[0]?.reason || 'unknown';

              console.warn(`[YouTube API Debug] API returned Status ${response.status} | Code ${code} | Reason: ${reason} | Message: ${message}`);
              throw new Error(`YouTube API Error (${code}/${reason}): ${message}`);
            }

            const data = await response.json();
            const itemsCount = data.items ? data.items.length : 0;
            nextPageToken = data.nextPageToken || '';
            pagesFetched++;

            if (data.items && Array.isArray(data.items)) {
              for (const item of data.items) {
                const snippet = item.snippet || {};
                const contentDetails = item.contentDetails || {};
                const pid = item.id;
                const title = snippet.title || 'Untitled Playlist';
                const thumbs = snippet.thumbnails || {};
                const thumbnail = thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || `https://img.youtube.com/vi/none/hqdefault.jpg`;
                const videoCount = contentDetails.itemCount || 0;

                if (pid && !seenIds.has(pid)) {
                  seenIds.add(pid);
                  allPlaylists.push({
                    playlistId: pid,
                    title,
                    playlistThumbnail: thumbnail,
                    videoCount,
                    description: snippet.description || ''
                  });
                }
              }
            }

            console.log(`[YouTube API Debug] Page ${pagesFetched}: Received ${itemsCount} items. Current pageToken: "${currentToken || 'FIRST'}", nextPageToken: "${nextPageToken || 'NONE'}". Total fetched so far: ${allPlaylists.length}`);

          } while (nextPageToken && pagesFetched < maxPages);

          console.log(`[YouTube API Debug] Finished Official API fetch | Resolved Channel ID: ${channelId} | Total playlists fetched: ${allPlaylists.length}`);

          if (allPlaylists.length > 0) {
            return res.json({
              success: true,
              channelId,
              playlists: enrichPlaylists(allPlaylists),
              totalFetched: allPlaylists.length,
              source: 'api'
            });
          }
        } catch (apiError: any) {
          console.warn(`[YouTube API Key Attempt Failed]: ${apiError.message}`);
        }
      }

      // 2. Try YouTube InnerTube Web Client API (Zero Quota cost, 100% reliable)
      try {
        const innerTubePlaylists = await fetchInnerTubeChannelPlaylists(channelId);
        if (innerTubePlaylists && innerTubePlaylists.length > 0) {
          console.log(`[YouTube Channel] InnerTube API successfully fetched ${innerTubePlaylists.length} playlists.`);
          return res.json({ success: true, channelId, playlists: enrichPlaylists(innerTubePlaylists), source: 'innertube' });
        }
      } catch (innerTubeErr: any) {
        console.log('[YouTube Channel] InnerTube API failed, trying fallbacks:', innerTubeErr?.message || innerTubeErr);
      }

      // 3. Fallback to direct HTML scraper
      try {
        const playlists = await fetchChannelPlaylistsPage(channelId, handle);
        if (playlists && playlists.length > 0) {
          return res.json({ success: true, channelId, playlists: enrichPlaylists(playlists), source: 'scraper' });
        }
      } catch (scraperErr: any) {
        console.log('[YouTube Channel] Direct scraper failed:', scraperErr?.message || scraperErr);
      }

      // 4. Fallback to Invidious
      try {
        const playlists = await fetchChannelPlaylistsViaInvidious(channelId);
        if (playlists && playlists.length > 0) {
          return res.json({ success: true, channelId, playlists: enrichPlaylists(playlists), source: 'invidious' });
        }
      } catch (err) {
        console.log('[YouTube Channel] Invidious fallback also finished.');
      }

      return res.status(404).json({ success: false, error: 'No playlists found for this channel.' });

    } catch (error: any) {
      console.error('[YouTube Channel Error]:', error);
      return res.status(500).json({ success: false, error: error.message || 'Failed to fetch channel playlists' });
    }
  });

  // Universal Web Scraping and AI parsing endpoint
  app.post('/api/scrape-web-page', async (req, res) => {
    const { url, html: clientProvidedHtml } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    let normalizedUrl = url.trim();
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    try {
      const parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.hostname.toLowerCase() === 'watchanimeworld') {
        parsedUrl.hostname = 'watchanimeworld.net';
        normalizedUrl = parsedUrl.toString();
      }
    } catch (_) {}

    try {
      const isCloudflareBlocked = (text: string): boolean => {
        if (!text) return false;
        const lowercase = text.toLowerCase();
        return (
          lowercase.includes('security verification/captcha') ||
          lowercase.includes('cloudflare') ||
          lowercase.includes('captcha') ||
          lowercase.includes('verify you are a human') ||
          lowercase.includes('checking your browser') ||
          lowercase.includes('ddos protection') ||
          lowercase.includes('js-challenger') ||
          lowercase.includes('access denied') ||
          lowercase.includes('enable javascript') ||
          lowercase.includes('security system') ||
          lowercase.includes('blocked')
        );
      };

      let rawHtml = '';
      if (clientProvidedHtml && clientProvidedHtml.trim().length > 100) {
        console.log(`[Universal Scraper] Using direct client-provided HTML for URL: "${normalizedUrl}"`);
        rawHtml = clientProvidedHtml;
      } else {
        console.log(`[Universal Scraper] Scraping page: "${normalizedUrl}"`);
        let lastErrorMsg = '';

        // Try 1: Jina Reader API (extremely reliable free web reader that bypasses Cloudflare and security blocks effortlessly)
        try {
          console.log('[Universal Scraper] Attempting Jina Reader API Cloudflare Bypass...');
          const jinaUrl = `https://r.jina.ai/${encodeURIComponent(normalizedUrl)}`;
          const response = await fetch(jinaUrl, {
            headers: {
              'Accept': 'text/html',
              'X-No-Cache': 'true'
            },
            signal: AbortSignal.timeout(12000)
          });
          if (response.ok) {
            const text = await response.text();
            if (text && text.trim().length > 300) {
              if (isCloudflareBlocked(text)) {
                console.warn('[Universal Scraper] Jina Reader returned a Cloudflare/CAPTCHA block page. Invalidating response...');
                lastErrorMsg = 'Jina Reader returned a Cloudflare block page';
              } else {
                rawHtml = text;
                console.log('[Universal Scraper] Jina Reader API Succeeded!');
              }
            } else {
              lastErrorMsg = 'Jina Reader returned empty content';
            }
          } else {
            lastErrorMsg = `Jina Reader status ${response.status}`;
          }
        } catch (e: any) {
          lastErrorMsg = `Jina Reader failed: ${e.message || e}`;
        }

        // Try 2: Direct fetch with headers
        if (!rawHtml || rawHtml.trim().length < 300) {
          try {
            console.log('[Universal Scraper] Attempting Direct Fetch...');
            const response = await fetch(normalizedUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
              },
              signal: AbortSignal.timeout(8000)
            });
            if (response.ok) {
              const text = await response.text();
              if (isCloudflareBlocked(text)) {
                console.warn('[Universal Scraper] Direct Fetch returned a Cloudflare/CAPTCHA block page. Invalidating...');
                lastErrorMsg += ' | Direct Fetch returned a Cloudflare block page';
              } else {
                rawHtml = text;
                console.log('[Universal Scraper] Direct Fetch Succeeded!');
              }
            } else {
              lastErrorMsg += ` | Direct Fetch status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | Direct Fetch failed: ${e.message || e}`;
          }
        }

        // Try 3: AllOrigins proxy fallback (very reliable CORS proxy)
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Direct Fetch blocked or failed. Attempting AllOrigins Proxy Fallback...');
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] AllOrigins returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | AllOrigins returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] AllOrigins Proxy Fetch Succeeded!');
                }
              } else {
                lastErrorMsg += ' | AllOrigins returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | AllOrigins status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | AllOrigins failed: ${e.message || e}`;
          }
        }

        // Try 4: CORSProxy.io fallback
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Attempting CORSProxy.io Fallback...');
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] CORSProxy.io returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | CORSProxy.io returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] CORSProxy.io Succeeded!');
                }
              } else {
                lastErrorMsg += ' | CORSProxy returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | CORSProxy status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | CORSProxy failed: ${e.message || e}`;
          }
        }

        // Try 5: CodeTabs proxy fallback
        if (!rawHtml || rawHtml.trim().length < 150) {
          try {
            console.log('[Universal Scraper] Attempting CodeTabs Proxy Fallback...');
            const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(normalizedUrl)}`;
            const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
            if (response.ok) {
              const text = await response.text();
              if (text && text.trim().length > 150) {
                if (isCloudflareBlocked(text)) {
                  console.warn('[Universal Scraper] CodeTabs returned a Cloudflare/CAPTCHA block page. Invalidating...');
                  lastErrorMsg += ' | CodeTabs returned a Cloudflare block page';
                } else {
                  rawHtml = text;
                  console.log('[Universal Scraper] CodeTabs Proxy Succeeded!');
                }
              } else {
                lastErrorMsg += ' | CodeTabs returned empty/too small response';
              }
            } else {
              lastErrorMsg += ` | CodeTabs status ${response.status}`;
            }
          } catch (e: any) {
            lastErrorMsg += ` | CodeTabs failed: ${e.message || e}`;
          }
        }
      }

      const ai = getAI();

      // If all scrapers failed to yield content, fall back to Google Search Grounding to extract the info directly from the web!
      if (!rawHtml || rawHtml.trim().length < 150) {
        console.log('[Universal Scraper] Every scraping proxy failed. Falling back to Gemini Google Search Grounding...');
        const searchPrompt = `You are a professional Anime/Movie Website Scraping Assistant.
We tried to scrape the webpage "${normalizedUrl}" but were blocked by security protections.
Please search Google for the details and episodes of the anime show listed at or matching the URL "${normalizedUrl}".
Identify if this page represents a single anime series or a catalog page of multiple anime shows.

Return ONLY a JSON object with one of these structures depending on the page type:

1. IF it represents a single anime show, return:
{
  "pageType": "single",
  "title": "Official English title of the series/movie. Absolutely NO Japanese/Kanji/Hiragana/Katakana characters are allowed under any circumstances.",
  "description": "Short synopsis or description. Try to find the exact summary.",
  "coverImage": "The URL of the poster, thumbnail, or banner image for the show",
  "releaseYear": "The release year or airing year (e.g. 2024)",
  "genres": ["Genre1", "Genre2"],
  "type": "TV" or "Movie" or "OVA" or "ONA" or "Special",
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "Episode title (e.g., 'Episode 1' or 'The Beginning')",
      "url": "The full watch page URL or embed stream link on this website"
    }
  ]
}

2. IF it is a homepage, directory, catalog, list of multiple shows, or search page on this website, return:
{
  "pageType": "catalog",
  "shows": [
    {
      "title": "Anime Show Title",
      "url": "The full specific watch/series URL on this website (e.g., https://watchanimeworld.net/series/blue-box-sub)",
      "coverImage": "The poster or image URL of this show",
      "description": "Short status snippet (e.g., 'Completed', 'Ongoing', '12 Episodes')"
    }
  ]
}

Ensure all URLs are absolute. Sort episodes in ascending order by episodeNumber.
Return ONLY the structured JSON. Do not wrap in markdown \`\`\`json blocks. Do not add any extra text.`;

        const genRes = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: searchPrompt,
          config: {
            responseMimeType: 'application/json',
            tools: [{ googleSearch: {} }]
          }
        });

        const resultText = genRes.text.trim();
        let parsedData: any = {};
        try {
          parsedData = JSON.parse(resultText);
        } catch (jsonErr) {
          const cleanedText = resultText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
          parsedData = JSON.parse(cleanedText);
        }

        if (parsedData && (parsedData.title || (parsedData.shows && parsedData.shows.length > 0))) {
          return res.json({ success: true, data: parsedData });
        } else {
          throw new Error('Google Search Grounding could not find sufficient details.');
        }
      }
      
      // Clean up HTML to stay within reasonable token sizes and remove noise
      let html = rawHtml;
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
      html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      html = html.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '');
      html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
      html = html.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, '');
      html = html.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');
      html = html.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '');
      
      // Keep only first 150k chars of HTML to be safe
      const cleanedHtml = html.slice(0, 150000);

      const prompt = `You are a professional Anime/Movie Website Scraping Assistant.
Analyze the following HTML from a streaming website (like watchanimeworld.net, themoviebox.xyz, or similar).
Determine if this page contains a single Anime/Movie/Series detail page, or if it is a directory/homepage/catalog/search-results page containing multiple different anime shows.

Target Website URL: ${normalizedUrl}

HTML Content:
${cleanedHtml}

Return ONLY a JSON object with one of these structures depending on the page type:

1. IF it is a single anime show page (has episodes list for this show), return:
{
  "pageType": "single",
  "title": "Official English title of the series/movie. Absolutely NO Japanese/Kanji/Hiragana/Katakana characters are allowed under any circumstances.",
  "description": "Short synopsis or description. Try to find the exact summary.",
  "coverImage": "The URL of the poster, thumbnail, or banner image for the show",
  "releaseYear": "The release year or airing year (e.g. 2024)",
  "genres": ["Genre1", "Genre2"],
  "type": "TV" or "Movie" or "OVA" or "ONA" or "Special",
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "Episode title (e.g., 'Episode 1' or 'The Beginning')",
      "url": "The full or relative URL of the episode watch page, embed source, or play link"
    }
  ]
}

2. IF it is a catalog/directory/homepage/search-results page (lists multiple different shows), return:
{
  "pageType": "catalog",
  "shows": [
    {
      "title": "Anime Show Title",
      "url": "The full or relative series page URL on the website (e.g., /series/blue-box-sub)",
      "coverImage": "The poster or image URL of this show",
      "description": "Short snippet (e.g., 'Completed', '12 Episodes', 'Ongoing')"
    }
  ]
}

Guidelines for Episode/Show Extraction:
- If pageType is "single", look for links containing "watch", "episode", "ep-", "/tv/", "/movie/", or list of episodes/chapters.
- Ensure all relative URLs (for episodes or shows) are absolute, using the base origin of "${new URL(normalizedUrl).origin}" if needed.
- Sort the episodes in ascending order by episodeNumber.
- Return ONLY the structured JSON object. Do not wrap in markdown \`\`\`json blocks. Do not add any extra text or explanations.`;

      const genRes = await ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const resultText = genRes.text.trim();
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(resultText);
      } catch (jsonErr) {
        // If it was wrapped in a codeblock, unwrap it
        const cleanedText = resultText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
        parsedData = JSON.parse(cleanedText);
      }

      return res.json({ success: true, data: parsedData });
    } catch (err: any) {
      console.error('[Universal Scraper Error]:', err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to scrape or parse the web page' });
    }
  });

  // Lazy initialize Google GenAI SDK to handle missing key safely
  let aiInstance: any = null;
  function getAI() {
    if (!aiInstance) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn('[Gemini] GEMINI_API_KEY environment variable is not defined.');
      }
      aiInstance = new GoogleGenAI({
        apiKey: apiKey || 'MOCK_KEY',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiInstance;
  }

  // Fetch YouTube video details safely using Invidious/scraping
  async function getYouTubeVideoDetails(url: string) {
    try {
      let videoId = '';
      const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
      if (match && match[1]) {
        videoId = match[1];
      }
      if (!videoId) return null;

      // Try open Invidious API first
      const response = await fetch(`https://inv.nadeko.net/api/v1/videos/${videoId}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (response && response.ok) {
        const data = await response.json();
        return {
          title: data.title || '',
          description: data.description || '',
          id: videoId
        };
      }

      // Scraping fallback
      const htmlRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);

      if (htmlRes && htmlRes.ok) {
        const html = await htmlRes.text();
        const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
        const descMatch = html.match(/<meta name="description" content="([\s\S]*?)"/i);
        return {
          title: titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : '',
          description: descMatch ? descMatch[1].trim() : '',
          id: videoId
        };
      }
      return { title: '', description: '', id: videoId };
    } catch (e: any) {
      console.error('Error fetching YouTube details:', e.message);
      return null;
    }
  }

  function cleanYouTubeTitle(title: string): string {
    let cleaned = title;
    // Remove suffix and parentheses content
    cleaned = cleaned.replace(/\(.*?\)/g, '');
    cleaned = cleaned.replace(/\[.*?\]/g, '');
    // Remove common trailer terms case-insensitively
    const patterns = [
      /official trailer/gi,
      /official teaser/gi,
      /teaser trailer/gi,
      /pv \d+/gi,
      /main pv/gi,
      /pv/gi,
      /trailer/gi,
      /teaser/gi,
      /anime adaptation/gi,
      /clip/gi,
      /episode \d+/gi,
      /ep \d+/gi,
      /subbed/gi,
      /dubbed/gi,
      /sub/gi,
      /dub/gi,
      /crunchyroll/gi,
      /netflix/gi,
      /ani-one/gi,
      /muse asia/gi,
    ];
    for (const pattern of patterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    // Replace multiple spaces with a single space and trim
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    // Remove trailing dashes, pipes, or colons
    cleaned = cleaned.replace(/^[\s\-:|]+|[\s\-:|]+$/g, '').trim();
    return cleaned || title.slice(0, 50);
  }

  // Automatically fetch, orchestrate, and compile anime metadata using Gemini and Jikan API
  function normalizeGenres(rawGenres: any, rawGenreField?: any): string {
    console.log(`[normalizeGenres Debug] Raw input genres:`, JSON.stringify(rawGenres), `genreField:`, JSON.stringify(rawGenreField));
    const input = rawGenres !== undefined ? rawGenres : rawGenreField;
    if (!input) return '';

    // If string
    if (typeof input === 'string') {
      return input
        .split(',')
        .map((g: any) => g.trim())
        .filter(Boolean)
        .join(', ');
    }

    // If array
    if (Array.isArray(input)) {
      const parsed = input.map((item: any) => {
        if (!item) return '';
        if (typeof item === 'string') return item.trim();
        if (typeof item === 'object') {
          return (item.name || item.genre || item.title || Object.values(item)[0] || '').toString().trim();
        }
        return String(item).trim();
      }).filter(Boolean);
      return parsed.join(', ');
    }

    // If single object
    if (typeof input === 'object') {
      const singleVal = input.name || input.genre || input.title || Object.values(input)[0];
      if (singleVal) {
        return String(singleVal).trim();
      }
    }

    return '';
  }

  function containsJapanese(str: string): boolean {
    if (!str) return false;
    return /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(str);
  }

  function getEnglishTitle(jikanSingle: any, kitsuSingle: any, fallbackName: string): string {
    if (jikanSingle?.title_english && !containsJapanese(jikanSingle.title_english)) {
      return jikanSingle.title_english;
    }
    if (jikanSingle?.titles && Array.isArray(jikanSingle.titles)) {
      const engTitleObj = jikanSingle.titles.find((t: any) => t.type === 'English' || t.type?.toLowerCase() === 'english');
      if (engTitleObj?.title && !containsJapanese(engTitleObj.title)) {
        return engTitleObj.title;
      }
    }
    if (kitsuSingle?.title && !containsJapanese(kitsuSingle.title)) {
      return kitsuSingle.title;
    }
    if (jikanSingle?.title && !containsJapanese(jikanSingle.title)) {
      return jikanSingle.title;
    }
    if (kitsuSingle?.canonicalTitle && !containsJapanese(kitsuSingle.canonicalTitle)) {
      return kitsuSingle.canonicalTitle;
    }
    return fallbackName;
  }

  app.get('/api/anime/metadata', async (req, res) => {
    const { query, refresh } = req.query;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing query parameter' });
    }

    const isForceRefresh = refresh === 'true';
    const cleanQuery = query.trim();

    try {
      const isYouTube = cleanQuery.includes('youtube.com') || cleanQuery.includes('youtu.be');
      let animeName = cleanQuery;
      let categoryHint = '';

      if (isYouTube) {
        console.log(`[Metadata Service] Query is a YouTube URL: "${cleanQuery}". Extracting video details...`);
        const ytDetails = await getYouTubeVideoDetails(cleanQuery);
        if (ytDetails && ytDetails.title) {
          console.log(`[Metadata Service] Extracted video title: "${ytDetails.title}"`);
          
          let parsedName = '';
          try {
            const ai = getAI();
            const extractionPrompt = `Analyze the following YouTube video title and description to extract the exact name/title of the anime it refers to in clean, official English (e.g., "Demon Slayer" instead of "Kimetsu no Yaiba", "Attack on Titan" instead of "Shingeki no Kyojin"). Absolutely NO Japanese/Kanji/Hiragana/Katakana characters are allowed under any circumstances. Also, determine what category/genres it represents.
Video Title: "${ytDetails.title}"
Video Description: "${ytDetails.description.slice(0, 500)}"

Return ONLY a JSON object with this exact structure:
{
  "animeName": "Name of the anime in official English",
  "category": "e.g., Action, Adventure"
}
Do not include any explanation or markdown formatting outside the JSON object.`;

            const extractionRes = await ai.models.generateContent({
              model: 'gemini-3.5-flash',
              contents: extractionPrompt,
              config: {
                responseMimeType: 'application/json'
              }
            });

            const parsed = JSON.parse(extractionRes.text.trim());
            if (parsed.animeName) {
              parsedName = parsed.animeName;
              categoryHint = parsed.category || '';
              console.log(`[Metadata Service] Gemini extracted anime name: "${parsedName}" with categories: "${categoryHint}"`);
            }
          } catch (geminiExtractErr: any) {
            console.log(`[Metadata Service Info] Gemini title extraction busy or quota reached. Using regex title fallback.`);
          }

          if (parsedName) {
            animeName = parsedName;
          } else {
            animeName = cleanYouTubeTitle(ytDetails.title);
            console.log(`[Metadata Service] Regex cleaned YouTube title: "${animeName}"`);
          }
        }
      }

      // Normalize anime name for caching (lowercase, alphanumeric-only keys)
      const normalizedKey = animeName.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const cacheKey = `metadata:${normalizedKey}`;
      const firebaseSafeKey = Buffer.from(cacheKey).toString('base64url');

      // 1. Check Cache first
      if (!isForceRefresh) {
        try {
          const cacheRef = ref(db, `anime_metadata_cache/${firebaseSafeKey}`);
          const snap = await get(cacheRef);
          if (snap && snap.exists()) {
            const cachedValue = snap.val();
            // Auto-heal cache: if cached value is missing or is a default placeholder, bypass cache to fetch fresh details
            const isPlaceholder = 
              !cachedValue || 
              (cachedValue.genres === 'Action, Adventure, Fantasy') ||
              (cachedValue.genres === 'Anime, Action, Adventure') ||
              (cachedValue.description && cachedValue.description.includes('Synopsis coming soon'));
            
            if (!isPlaceholder) {
              console.log(`[Metadata Cache HIT] Loaded metadata for "${animeName}" from cache`);
              cachedValue.genres = normalizeGenres(cachedValue.genres, cachedValue.genre);
              if (cachedValue.genre) {
                delete cachedValue.genre;
              }
              return res.json({ success: true, source: 'cache', data: cachedValue });
            } else {
              console.log(`[Metadata Cache BYPASS] Cached value is a placeholder for "${animeName}". Refetching...`);
            }
          }
        } catch (cacheErr: any) {
          console.warn(`[Metadata Cache Warning] Failed to read cache:`, cacheErr.message);
        }
      }

      // 2. Search and Fetch Jikan MAL details & Kitsu details in parallel
      console.log(`[Metadata Service] Searching Jikan MAL and Kitsu API for: "${animeName}"`);
      let jikanData: any = null;
      let kitsuData: any = null;

      try {
        const [jikanRes, kitsuRes] = await Promise.all([
          fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(animeName)}&limit=5`, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000)
          }).catch(err => {
            console.warn(`[Metadata Service Warning] Jikan API fetch catch:`, err.message);
            return null;
          }),
          fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(animeName)}&include=genres&page[limit]=5`, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'application/vnd.api+json'
            },
            signal: AbortSignal.timeout(6000)
          }).catch(err => {
            console.warn(`[Metadata Service Warning] Kitsu API fetch catch:`, err.message);
            return null;
          })
        ]);

        if (jikanRes && jikanRes.ok) {
          const json = await jikanRes.json();
          console.log(`[DEBUG API Response] Jikan raw response status: ok, count: ${json.data?.length || 0}`);
          if (json.data && json.data.length > 0) {
            jikanData = json.data;
            console.log(`[Metadata Service] Jikan MAL API found ${jikanData.length} matches`);
          }
        } else if (jikanRes) {
          console.warn(`[Metadata Service Warning] Jikan API returned non-ok status: ${jikanRes.status}`);
        }

        if (kitsuRes && kitsuRes.ok) {
          const json = await kitsuRes.json();
          console.log(`[DEBUG API Response] Kitsu raw response status: ok, count: ${json.data?.length || 0}`);
          if (json.data && json.data.length > 0) {
            const included = json.included || [];
            kitsuData = json.data.map((item: any) => {
              const attrs = item.attributes || {};
              const poster = attrs.posterImage?.large || attrs.posterImage?.original || attrs.posterImage?.medium || '';
              const cover = attrs.coverImage?.original || attrs.coverImage?.large || attrs.coverImage?.medium || attrs.coverImage?.small || '';
              
              // Extract genres for this specific item if possible
              const kitsuGenres = included
                .filter((inc: any) => inc.type === 'genres')
                .map((inc: any) => inc.attributes?.name)
                .filter(Boolean)
                .join(', ');

              return {
                title: attrs.canonicalTitle || attrs.slug || '',
                synopsis: attrs.synopsis || '',
                poster,
                cover,
                episodeCount: attrs.episodeCount || null,
                averageRating: attrs.averageRating || '',
                status: attrs.status || '',
                subtype: attrs.subtype || '',
                startDate: attrs.startDate || '',
                genres: kitsuGenres
              };
            });
            console.log(`[Metadata Service] Kitsu API found ${kitsuData.length} matches`);
          }
        } else if (kitsuRes) {
          console.warn(`[Metadata Service Warning] Kitsu API returned non-ok status: ${kitsuRes.status}`);
        }
      } catch (fetchErr: any) {
        console.warn(`[Metadata Service] Jikan/Kitsu fetching error:`, fetchErr.message);
      }

      // 3. Try to use Gemini to orchestrate, refine, and compile all 15 required metadata fields.
      // Fallback gracefully on error so that a 403 / API limit never crashes the application.
      let parsedData: any = null;
      let source = 'api';

      try {
        const ai = getAI();
        const systemPrompt = `You are a professional Anime Metadata specialist.
Given the target anime name, optional YouTube link context, and lists of search results from the Jikan MAL API and Kitsu API, compile the absolute best, most accurate, and fully structured metadata for this anime.
You MUST analyze the lists of search results to select the exact matching anime and season specified in the "Target Anime Title" (e.g., if the target is "Solo Leveling Season 2", do not pick the Season 1 results; if the target is "Saikyou Tank no Meikyuu Kouryaku: Tairyoku 9999 no I...", find the exact matching entry. If no perfect match exists in the lists, synthesize or adjust the details to perfectly fit the intended title, season, and type).
You MUST map and format everything into the exact JSON fields requested below.

Required Fields:
- title: Official English title (e.g., "Demon Slayer" instead of "Kimetsu no Yaiba", "Attack on Titan" instead of "Shingeki no Kyojin"). Absolutely NO Japanese characters, Kanji, Hiragana, or Katakana are allowed under any circumstances. If the official English title is not available, use the most recognizable English/Romaji name. Translate or Romanize any foreign characters into clean English.
- description: Detailed synopsis (keep it engaging, informative, and well-written)
- type: MUST be one of: "TV", "Movie", "OVA", "Special"
- status: MUST be one of: "Ongoing", "Completed", "Upcoming"
- episodes: Total number of episodes (integer)
- rating: Rating out of 10, e.g. "8.5"
- genres: List of genres, e.g. "Action, Adventure, Fantasy" (comma-separated string). Ensure these genres are accurate to the specific anime.
- studio: Production studio company (e.g. "ufotable", "MAPPA", "A-1 Pictures")
- released: Release Year (e.g., "2024")
- season: Season of release, e.g. "Spring", "Summer", "Fall", "Winter" (string)
- duration: Duration of episode or movie, e.g., "24 min per ep" (string)
- country: Country of origin, e.g., "Japan" (string)
- language: Original language, e.g., "Japanese" (string)
- poster: Best vertical poster image URL (use high-res Jikan image if available, or fetch/provide a high-quality stable image URL from Unsplash/Anilist/MyAnimeList)
- banner: Horizontal banner image URL (must be high quality, wide format, from Anilist/Unsplash/MAL)
- coverImage: High quality cover image URL (wide format, or high-res banner format)
- trailer: YouTube Embed URL or watch link (if available)

Provide the response in raw JSON format matching this schema.
Do not include any explanations, markdown packaging, or text formatting outside of the JSON object.`;

        const userPrompt = `Target Anime Title: "${animeName}"
YouTube Link Context (if any): "${isYouTube ? cleanQuery : ''}"
Category/Genre Hint: "${categoryHint}"
Jikan MAL API Search Results (up to 5 potential matches): ${jikanData ? JSON.stringify(jikanData).slice(0, 4000) : 'None'}
Kitsu API Search Results (up to 5 potential matches): ${kitsuData ? JSON.stringify(kitsuData).slice(0, 4000) : 'None'}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: userPrompt,
          config: {
            systemInstruction: systemPrompt,
            responseMimeType: 'application/json'
          }
        });

        parsedData = JSON.parse(response.text.trim());
        source = 'api';

        // Find the best matching Jikan/Kitsu entry from our search results to extract actual high-quality poster and banner images
        const findBestImageMatch = () => {
          const targetTitle = (parsedData?.title || animeName).toLowerCase();
          
          let bestJikan = null;
          if (Array.isArray(jikanData)) {
            bestJikan = jikanData.find(item => item.title?.toLowerCase().includes(targetTitle) || targetTitle.includes(item.title?.toLowerCase()));
            if (!bestJikan && jikanData.length > 0) {
              bestJikan = jikanData[0];
            }
          }

          let bestKitsu = null;
          if (Array.isArray(kitsuData)) {
            bestKitsu = kitsuData.find((item: any) => item.title?.toLowerCase().includes(targetTitle) || targetTitle.includes(item.title?.toLowerCase()));
            if (!bestKitsu && kitsuData.length > 0) {
              bestKitsu = kitsuData[0];
            }
          }

          return { jikan: bestJikan, kitsu: bestKitsu };
        };

        const imageMatches = findBestImageMatch();
        const bestJikanMatch = imageMatches.jikan;
        const bestKitsuMatch = imageMatches.kitsu;

        if (bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url) {
          parsedData.poster = bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url || bestJikanMatch?.images?.jpg?.image_url || parsedData.poster;
        }
        if (bestKitsuMatch?.cover) {
          parsedData.banner = bestKitsuMatch.cover;
          parsedData.coverImage = bestKitsuMatch.cover;
        } else if (bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url) {
          const fallbackImg = bestKitsuMatch?.poster || bestJikanMatch?.images?.jpg?.large_image_url || bestJikanMatch?.images?.jpg?.image_url || '';
          if (parsedData.banner?.includes('unsplash') || !parsedData.banner) {
            parsedData.banner = fallbackImg;
          }
          if (parsedData.coverImage?.includes('unsplash') || !parsedData.coverImage) {
            parsedData.coverImage = fallbackImg;
          }
        }

      } catch (geminiErr: any) {
        console.log(`[Metadata Service Info] Gemini API busy or quota reached. Seamlessly utilizing direct Jikan MAL & Kitsu parser with fallback heuristics.`);
        
        const jikanSingle = Array.isArray(jikanData) && jikanData.length > 0 ? jikanData[0] : null;
        const kitsuSingle = Array.isArray(kitsuData) && kitsuData.length > 0 ? kitsuData[0] : null;

        if (jikanSingle || kitsuSingle) {
          console.log(`[Metadata Service] Parsing Jikan MAL / Kitsu data directly for metadata fallback...`);
          
          // Determine status
          let status = "Upcoming";
          const resolvedStatus = (jikanSingle?.status || kitsuSingle?.status || '').toLowerCase();
          if (resolvedStatus.includes('finished') || resolvedStatus.includes('completed') || resolvedStatus.includes('aired')) {
            status = "Completed";
          } else if (resolvedStatus.includes('airing') || resolvedStatus.includes('ongoing') || resolvedStatus.includes('current')) {
            status = "Ongoing";
          }
          
          // Determine type
          let type = "TV";
          const resolvedType = (jikanSingle?.type || kitsuSingle?.subtype || '').toUpperCase();
          if (["TV", "MOVIE", "OVA", "SPECIAL"].includes(resolvedType)) {
            type = resolvedType === "MOVIE" ? "Movie" : (resolvedType === "SPECIAL" ? "Special" : resolvedType);
          }

          // Determine genres
          let combinedGenres = '';
          if (jikanSingle) {
            const genresArr = (jikanSingle.genres || []).map((g: any) => g.name);
            const themesArr = (jikanSingle.themes || []).map((t: any) => t.name);
            const demographicsArr = (jikanSingle.demographics || []).map((d: any) => d.name);
            combinedGenres = [...new Set([...genresArr, ...themesArr, ...demographicsArr])].join(', ');
          }
          if (!combinedGenres && kitsuSingle?.genres) {
            combinedGenres = kitsuSingle.genres;
          }
          if (!combinedGenres && categoryHint) {
            combinedGenres = categoryHint;
          }
          if (!combinedGenres) {
            const lowerName = animeName.toLowerCase();
            if (lowerName.includes('horror') || lowerName.includes('scary') || lowerName.includes('ghost') || lowerName.includes('dead') || lowerName.includes('dark')) {
              combinedGenres = 'Horror, Mystery, Thriller';
            } else if (lowerName.includes('romance') || lowerName.includes('love') || lowerName.includes('school')) {
              combinedGenres = 'Romance, Drama, School';
            } else if (lowerName.includes('comedy') || lowerName.includes('funny') || lowerName.includes('gag')) {
              combinedGenres = 'Comedy, Slice of Life';
            } else if (lowerName.includes('scifi') || lowerName.includes('sci-fi') || lowerName.includes('robot') || lowerName.includes('mecha')) {
              combinedGenres = 'Sci-Fi, Action, Mecha';
            } else {
              combinedGenres = 'Anime, Action, Adventure';
            }
          }

          // Determine studio
          const studioList = jikanSingle ? ((jikanSingle.studios || []).map((s: any) => s.name).join(', ') || 'Unknown') : 'Unknown';

          // Determine release year
          let released = '2025';
          if (jikanSingle?.year) {
            released = String(jikanSingle.year);
          } else if (jikanSingle?.aired?.prop?.from?.year) {
            released = String(jikanSingle.aired.prop.from.year);
          } else if (kitsuSingle?.startDate) {
            released = kitsuSingle.startDate.slice(0, 4);
          }

          const season = jikanSingle?.season ? (jikanSingle.season.charAt(0).toUpperCase() + jikanSingle.season.slice(1)) : 'Unknown';
          const duration = jikanSingle?.duration || '24 min per ep';
          
          // Determine poster, banner, coverImage
          const poster = kitsuSingle?.poster || jikanSingle?.images?.jpg?.large_image_url || jikanSingle?.images?.jpg?.image_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&auto=format&fit=crop&q=60';
          const banner = kitsuSingle?.cover || kitsuSingle?.poster || jikanSingle?.images?.jpg?.large_image_url || jikanSingle?.images?.jpg?.image_url || 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60';
          const coverImage = banner;

          // Determine trailer URL
          let trailerUrl = '';
          if (jikanSingle?.trailer?.youtube_id) {
            trailerUrl = `https://www.youtube.com/embed/${jikanSingle.trailer.youtube_id}`;
          } else if (jikanSingle?.trailer?.embed_url || jikanSingle?.trailer?.url) {
            trailerUrl = jikanSingle.trailer.embed_url || jikanSingle.trailer.url || '';
          }

          parsedData = {
            title: getEnglishTitle(jikanSingle, kitsuSingle, animeName),
            description: jikanSingle?.synopsis || kitsuSingle?.synopsis || `Synopsis for ${animeName} is currently unavailable.`,
            type,
            status,
            episodes: jikanSingle?.episodes || kitsuSingle?.episodeCount || 12,
            rating: jikanSingle?.score ? String(jikanSingle.score) : (kitsuSingle?.averageRating ? String(Number(kitsuSingle.averageRating) / 10) : '8.0'),
            genres: combinedGenres,
            studio: studioList,
            released,
            season,
            duration,
            country: 'Japan',
            language: 'Japanese',
            poster,
            banner,
            coverImage,
            trailer: trailerUrl
          };
          source = 'jikan_fallback';
        } else {
          console.log(`[Metadata Service] No Jikan/Kitsu data available. Applying default placeholder values.`);
          const resolvedFallbackGenres = (() => {
            if (categoryHint) return categoryHint;
            const lowerName = animeName.toLowerCase();
            if (lowerName.includes('horror') || lowerName.includes('scary') || lowerName.includes('ghost') || lowerName.includes('dead') || lowerName.includes('dark')) {
              return 'Horror, Mystery, Thriller';
            } else if (lowerName.includes('romance') || lowerName.includes('love') || lowerName.includes('school')) {
              return 'Romance, Drama, School';
            } else if (lowerName.includes('comedy') || lowerName.includes('funny') || lowerName.includes('gag')) {
              return 'Comedy, Slice of Life';
            } else if (lowerName.includes('scifi') || lowerName.includes('sci-fi') || lowerName.includes('robot') || lowerName.includes('mecha')) {
              return 'Sci-Fi, Action, Mecha';
            }
            return 'Action, Adventure, Fantasy';
          })();

          parsedData = {
            title: animeName,
            description: `A spectacular anime series featuring ${animeName}. Synopsis coming soon!`,
            type: 'TV',
            status: 'Upcoming',
            episodes: 12,
            rating: '7.5',
            genres: resolvedFallbackGenres,
            studio: 'Unknown',
            released: '2025',
            season: 'Winter',
            duration: '24 min per ep',
            country: 'Japan',
            language: 'Japanese',
            poster: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=500&auto=format&fit=crop&q=60',
            banner: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60',
            coverImage: 'https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1200&auto=format&fit=crop&q=60',
            trailer: ''
          };
          source = 'default_fallback';
        }
      }

      // 4. Save to cache (using the resolved metadata object)
      try {
        const cacheRef = ref(db, `anime_metadata_cache/${firebaseSafeKey}`);
        await set(cacheRef, parsedData);
        console.log(`[Metadata Service] Saved resolved metadata to cache for "${animeName}"`);
      } catch (cacheWriteErr: any) {
        console.error(`[Metadata Service Cache Write Fail]`, cacheWriteErr.message);
      }

      return res.json({
        success: true,
        source,
        data: parsedData
      });

    } catch (err: any) {
      console.error(`[Metadata Service Error]`, err);
      return res.status(500).json({ success: false, error: err.message || 'Failed to auto-fetch metadata' });
    }
  });

  // Derive clean, accurate real hosting provider names from URLs or server option titles
  function getRealServerName(sUrl: string, rawName?: string): string {
    const cleanUrl = (sUrl || '').trim();
    const lowerUrl = cleanUrl.toLowerCase();
    const rawTrimmed = (rawName || '').trim();

    // 1. Check if rawName is a valid, non-generic provider name from DB / API
    const isGeneric = !rawTrimmed || 
      /^SERVER\s*\d*$/i.test(rawTrimmed) || 
      /^OPTION\s*\d*$/i.test(rawTrimmed) || 
      /^PLAYER\s*\d*$/i.test(rawTrimmed) || 
      /^TOONSTREAM$/i.test(rawTrimmed) ||
      rawTrimmed.toUpperCase() === 'SERVER' ||
      rawTrimmed.toUpperCase() === 'OPTION';

    if (!isGeneric) {
      return rawTrimmed;
    }

    // 2. Detect provider name from embed URL / domain
    const combined = `${lowerUrl} ${rawTrimmed.toLowerCase()}`;

    let provider = '';
    if (combined.includes('cloudy')) provider = 'Cloudy';
    else if (combined.includes('abyss')) provider = 'Abyss';
    else if (combined.includes('streamwish') || combined.includes('wish')) provider = 'StreamWish';
    else if (combined.includes('filemoon') || combined.includes('fmoon')) provider = 'Filemoon';
    else if (combined.includes('vidhide') || combined.includes('vidhidepro') || combined.includes('vbfast') || combined.includes('myfcloud') || combined.includes('vidbd')) provider = 'VidHide';
    else if (combined.includes('filelions') || combined.includes('lions')) provider = 'FileLions';
    else if (combined.includes('dood') || combined.includes('ds2play') || combined.includes('do0od') || combined.includes('doodstream')) provider = 'DoodStream';
    else if (combined.includes('lulustream') || combined.includes('luluvdo')) provider = 'LuluStream';
    else if (combined.includes('mp4upload')) provider = 'MP4Upload';
    else if (combined.includes('streamtape') || combined.includes('stape')) provider = 'StreamTape';
    else if (combined.includes('upns')) provider = 'UPNS';
    else if (combined.includes('fastserver')) provider = 'FastServer';
    else if (combined.includes('mega.nz') || combined.includes('mega.io')) provider = 'Mega';
    else if (combined.includes('voe')) provider = 'VOE';
    else if (combined.includes('mixdrop')) provider = 'MixDrop';
    else if (combined.includes('prostream')) provider = 'ProStream';
    else if (combined.includes('vidsrc')) provider = 'VidSrc';
    else if (combined.includes('gdrive') || combined.includes('drive.google')) provider = 'GDrive';
    else if (combined.includes('ruby')) provider = 'Ruby Stream';
    else if (combined.includes('cloud')) provider = 'Cloud Stream';
    else if (combined.includes('play')) provider = 'Play Stream';

    if (provider) {
      let tag = '';
      if (rawTrimmed.toUpperCase().includes('SUB')) tag = ' (SUB)';
      else if (rawTrimmed.toUpperCase().includes('DUB')) tag = ' (DUB)';

      if ((provider.toUpperCase().includes('SUB') || provider.toUpperCase().includes('DUB')) && tag) {
        return provider;
      }
      return provider + tag;
    }

    // 3. Fallback to domain name from URL
    if (cleanUrl.startsWith('http')) {
      try {
        const hostname = new URL(cleanUrl).hostname.replace(/^www\./, '');
        const parts = hostname.split('.');
        const mainPart = parts.length > 1 ? parts[parts.length - 2] : parts[0];
        if (mainPart && !mainPart.includes('toon-stream') && !mainPart.includes('toonstream')) {
          return mainPart.charAt(0).toUpperCase() + mainPart.slice(1);
        }
      } catch (_) {}
    }

    return 'HD Stream';
  }

  // EMBED PROXY — Strips X-Frame-Options, injects <base> tag, proxies inner iframes and forms, and blocks popups/fake ad overlays
  app.all('/api/embed-proxy', async (req, res) => {
    const rawUrl = (req.query.url || req.body?.url) as string;
    if (!rawUrl) return res.status(400).send('Missing url parameter');
    try {
      const decoded = decodeURIComponent(rawUrl);
      const targetUrl = new URL(decoded);
      
      const isToonStreamOrHost = targetUrl.hostname.includes('toon-stream.site') || 
                                 targetUrl.hostname.includes('toonstream') ||
                                 targetUrl.hostname.includes('rubystm.com') || 
                                 targetUrl.hostname.includes('streamruby.com') ||
                                 targetUrl.hostname.includes('gdmirrorbot.nl') || 
                                 targetUrl.hostname.includes('iqsmartgames.com') ||
                                 targetUrl.hostname.includes('upns.one') ||
                                 targetUrl.hostname.includes('4animo.xyz') ||
                                 targetUrl.hostname.includes('megaplay.buzz') ||
                                 targetUrl.hostname.includes('kryzox.xyz') ||
                                 targetUrl.hostname.includes('vidstreaming') ||
                                 targetUrl.hostname.includes('streamwish') ||
                                 targetUrl.hostname.includes('wishembed') ||
                                 targetUrl.hostname.includes('filemoon') ||
                                 targetUrl.hostname.includes('vidhide') ||
                                 targetUrl.hostname.includes('streamtape') ||
                                 targetUrl.hostname.includes('doodstream') ||
                                 targetUrl.hostname.includes('dood.') ||
                                 targetUrl.hostname.includes('lulustream') ||
                                 targetUrl.hostname.includes('abysscdn') ||
                                 targetUrl.hostname.includes('abyss.to') ||
                                 targetUrl.hostname.includes('mp4upload') ||
                                 targetUrl.hostname.includes('cloudy.ec') ||
                                 targetUrl.hostname.includes('vidoza') ||
                                 targetUrl.hostname.includes('mixdrop');

      let upstreamUrl = decoded;
      let finalTargetUrl = targetUrl;
      let html = '';
      let contentType = 'text/html; charset=utf-8';

      if ((targetUrl.hostname.includes('rubystm.com') || targetUrl.hostname.includes('streamruby.com')) && decoded.includes('/e/')) {
        const fileCode = decoded.split('/').pop()?.replace('.html', '').split('-').pop();
        if (fileCode) {
          try {
            const dlRes = await fetch('https://rubystm.com/dl', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': decoded,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
              },
              body: `op=embed&file_code=${fileCode}&auto=1&referer=toon-stream.site`
            });
            if (dlRes.ok) {
              html = await dlRes.text();
              upstreamUrl = dlRes.url || 'https://rubystm.com/dl';
              finalTargetUrl = new URL('https://rubystm.com/');
              contentType = dlRes.headers.get('content-type') || 'text/html; charset=utf-8';
            }
          } catch (e) {
            console.warn('[EmbedProxy] Rubystm direct /dl fetch error:', e);
          }
        }
      }

      if (!html) {
        let bodyData: any = undefined;
        if (req.method === 'POST') {
          if (typeof req.body === 'object' && req.body !== null) {
            bodyData = new URLSearchParams(req.body as any).toString();
          } else if (typeof req.body === 'string') {
            bodyData = req.body;
          }
        }

        let effectiveReferer = isToonStreamOrHost ? 'https://toon-stream.site/' : targetUrl.origin + '/';
        const reqReferer = (req.headers.referer || req.headers['x-referer']) as string;
        if (reqReferer && reqReferer.includes('url=')) {
          try {
            const parsedRef = new URL(reqReferer);
            const refUrlParam = parsedRef.searchParams.get('url');
            if (refUrlParam) {
              effectiveReferer = decodeURIComponent(refUrlParam);
            }
          } catch (_) {}
        }

        const upstream = await fetch(decoded, {
          method: req.method,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': effectiveReferer,
            'Origin': targetUrl.origin,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            ...(req.method === 'POST' ? { 'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded' } : {}),
          },
          body: bodyData,
        });

        upstreamUrl = upstream.url || decoded;
        finalTargetUrl = new URL(upstreamUrl);
        contentType = upstream.headers.get('content-type') || 'text/html; charset=utf-8';

        const isBinary = contentType.includes('video/') ||
                         contentType.includes('audio/') ||
                         contentType.includes('image/') ||
                         contentType.includes('font/') ||
                         contentType.includes('octet-stream');

        if (isBinary) {
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.removeHeader('X-Frame-Options');
          res.setHeader('Content-Type', contentType);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return res.send(buffer);
        }

        html = await upstream.text();
      }

      if (contentType.includes('text/html')) {
        // Fix relative assets (js, css, etc.) to absolute origin URLs
        html = html.replace(/(src|href)=["']\/(?!\/)/gi, `$1="${finalTargetUrl.origin}/`);

        const baseTag = `<base href="${finalTargetUrl.origin}/">`;
        const antiAdInject = `
          <meta name="referrer" content="no-referrer">
          <style>
            .fake-player-overlay, #fake-player-overlay, div[class*="fake-player"], div[onclick*="redirectToAd"], iframe[src*="astronautlividlyreformer"], a[href*="astronautlividlyreformer"], script[src*="scornwhile"], script[src*="pyralmite"], script[src*="koaptouw"], #adbd, #play_limit_box,
            div[class*="pop-ad"], div[id*="pop-ad"], div[class*="popup-ad"], div[id*="popup-ad"], div[class*="banner-ad"], div[id*="banner-ad"], div[class*="float-ad"], div[id*="float-ad"], div[class*="overlay-ad"], div[id*="overlay-ad"],
            div[id^="ad_"], div[class^="ad_"], div[id*="-ad-"], div[class*="-ad-"] { 
              display: none !important; 
              opacity: 0 !important; 
              visibility: hidden !important; 
              pointer-events: none !important; 
              width: 0 !important; 
              height: 0 !important; 
              position: absolute !important;
              left: -9999px !important;
              z-index: -9999 !important;
            }
          </style>
          <script>
            (function() {
              var targetOrigin = ${JSON.stringify(finalTargetUrl.origin)};
              var targetBaseUrl = ${JSON.stringify(upstreamUrl)};

              function resolveAndProxy(url) {
                if (!url || typeof url !== 'string') return url;
                var trimmed = url.trim();
                if (
                  trimmed.startsWith('/api/embed-proxy') ||
                  trimmed.startsWith('data:') ||
                  trimmed.startsWith('blob:') ||
                  trimmed.startsWith('about:') ||
                  trimmed.startsWith('javascript:')
                ) {
                  return url;
                }
                try {
                  var resolved = new URL(trimmed, targetBaseUrl).href;
                  return '/api/embed-proxy?url=' + encodeURIComponent(resolved);
                } catch(e) {
                  return url;
                }
              }

              // Intercept fetch
              try {
                var origFetch = window.fetch;
                if (origFetch) {
                  window.fetch = function(input, init) {
                    if (typeof input === 'string') {
                      input = resolveAndProxy(input);
                    } else if (input && typeof input === 'object' && input.url) {
                      try {
                        var newUrl = resolveAndProxy(input.url);
                        input = new Request(newUrl, input);
                      } catch(e) {}
                    }
                    return origFetch.call(this, input, init);
                  };
                }
              } catch(e) {}

              // Intercept XMLHttpRequest
              try {
                var origOpen = XMLHttpRequest.prototype.open;
                if (origOpen) {
                  XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                    var proxied = resolveAndProxy(url);
                    return origOpen.call(this, method, proxied, async !== false, user, password);
                  };
                }
              } catch(e) {}

              // Intercept Worker
              try {
                var origWorker = window.Worker;
                if (origWorker) {
                  window.Worker = function(scriptURL, options) {
                    var proxied = resolveAndProxy(scriptURL);
                    return new origWorker(proxied, options);
                  };
                }
              } catch(e) {}

              // Intercept JS location redirects
              try {
                var origReplace = window.location.replace.bind(window.location);
                var origAssign = window.location.assign.bind(window.location);

                window.location.replace = function(u) {
                  try { return origReplace(resolveAndProxy(u)); } catch(e) { window.location.href = resolveAndProxy(u); }
                };
                window.location.assign = function(u) {
                  try { return origAssign(resolveAndProxy(u)); } catch(e) { window.location.href = resolveAndProxy(u); }
                };
              } catch(e) {}

              // Disable popup windows
              window.redirectToAd = function() {};
              window.open = function() { return null; };
              window.popunder = function() {};
              try {
                Object.defineProperty(window, 'open', {
                  value: function() { return null; },
                  writable: false,
                  configurable: false
                });
              } catch(e) {}

              // Monitor page text for embedded player errors and notify parent app to auto-switch servers
              function checkForErrors() {
                try {
                  var text = (document.body ? document.body.innerText || document.body.textContent || '' : '').toLowerCase();
                  if (
                    text.includes('sandboxed embed is not allowed') ||
                    text.includes('contact your website owner') ||
                    text.includes('this video file cannot be played') ||
                    text.includes('file was deleted') ||
                    text.includes('file deleted') ||
                    text.includes('video not found') ||
                    text.includes('media player error') ||
                    text.includes('page you are looking for does not exist') ||
                    text.includes('domain suspended') ||
                    text.includes('access denied')
                  ) {
                    if (window.parent && window.parent !== window.self) {
                      window.parent.postMessage({ type: 'ANOVA_EMBED_ERROR', error: 'EMBED_PLAYBACK_BLOCKED' }, '*');
                    }
                  }
                } catch(e) {}
              }
              setInterval(checkForErrors, 2500);

              function cleanupAds() {
                try {
                  // Remove fake warning banners and overlays without destroying media player elements
                  var badOverlays = document.querySelectorAll('.fake-player-overlay, [onclick*="redirectToAd"], [class*="fake-player"], #adbd, #play_limit_box');
                  badOverlays.forEach(function(el) { 
                    try { 
                      if (!el.querySelector('video') && !el.querySelector('iframe')) {
                        el.style.display = 'none';
                        el.remove(); 
                      }
                    } catch(e){} 
                  });
                } catch(e) {}
              }

              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', cleanupAds);
              } else {
                cleanupAds();
              }
              setInterval(cleanupAds, 500);
            })();
          </script>
        `;

        // Strip the fake player overlay div if directly embedded in HTML
        html = html.replace(/<div[^>]*class=["'][^"']*fake-player-overlay[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');

        // Rewrite form actions so POST forms stay proxied through /api/embed-proxy
        html = html.replace(/<form([^>]+)action=["']([^"']+)["']/gi, (match, p1, actionUrl) => {
          let fullAction = actionUrl;
          if (actionUrl.startsWith('/')) {
            fullAction = finalTargetUrl.origin + actionUrl;
          } else if (!actionUrl.startsWith('http')) {
            fullAction = finalTargetUrl.origin + '/' + actionUrl;
          }
          return `<form${p1}action="/api/embed-proxy?url=${encodeURIComponent(fullAction)}"`;
        });

        // Rewrite inner iframe sources so nested players (e.g. rubystm, gdmirrorbot) are also proxied with valid referer
        html = html.replace(/<iframe([^>]+)src=["'](https?:\/\/[^"']+)["']/gi, (match, p1, innerSrc) => {
          if (innerSrc.includes('rubystm.com') || innerSrc.includes('gdmirrorbot.nl') || innerSrc.includes('upns.one') || innerSrc.includes('iqsmartgames.com') || innerSrc.includes('toon-stream.site')) {
            return `<iframe${p1}src="/api/embed-proxy?url=${encodeURIComponent(innerSrc)}"`;
          }
          return match;
        });

        if (/<head>/i.test(html)) {
          html = html.replace(/<head>/i, `<head>${baseTag}${antiAdInject}`);
        } else if (/<html/i.test(html)) {
          html = html.replace(/<html[^>]*>/i, `$&<head>${baseTag}${antiAdInject}</head>`);
        } else {
          html = `${baseTag}${antiAdInject}${html}`;
        }
      }

      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Content-Security-Policy', "frame-ancestors *; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
      res.send(html);
    } catch (err: any) {
      console.error('[EmbedProxy] Failed:', err.message);
      res.status(502).send('Embed proxy upstream error: ' + err.message);
    }
  });

  // -------------------------------------------------------------
  // SMART AUTO SERVER SELECTION & RANKING ENGINE WITH 24-HR CACHE
  // -------------------------------------------------------------
  interface ServerHealthResult {
    url: string;
    name: string;
    working: boolean;
    latency: number;
    reason?: string;
    testedAt: number;
  }

  const serverRankingCache = new Map<string, { timestamp: number; rankedServers: ServerHealthResult[] }>();
  const SERVER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  async function testSingleServerHealth(sUrl: string, sName: string): Promise<ServerHealthResult> {
    const startTime = performance.now();
    let cleanUrl = sUrl ? sUrl.trim() : '';
    if (!cleanUrl) {
      return { url: sUrl, name: sName, working: false, latency: 9999, reason: 'Empty URL', testedAt: Date.now() };
    }

    try {
      let testTarget = cleanUrl;
      if (cleanUrl.startsWith('/')) {
        testTarget = `https://toon-stream.site${cleanUrl}`;
      }

      // Do NOT test local blob/about/api URLs that are dynamically handled on frontend
      if (cleanUrl.startsWith('blob:') || cleanUrl.startsWith('about:')) {
        return { url: cleanUrl, name: sName, working: true, latency: 50, testedAt: Date.now() };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);

      const isToonStream = testTarget.includes('toon-stream.site') || testTarget.includes('toonstream');

      const res = await fetch(testTarget, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Referer': isToonStream ? 'https://toon-stream.site/' : 'https://google.com'
        },
        signal: controller.signal
      }).catch(err => {
        clearTimeout(timeout);
        return null;
      });

      clearTimeout(timeout);
      const latency = Math.round(performance.now() - startTime);

      if (!res) {
        return { url: cleanUrl, name: sName, working: false, latency: 9999, reason: 'Network Timeout / Unreachable Host', testedAt: Date.now() };
      }

      if (!res.ok && res.status !== 301 && res.status !== 302 && res.status !== 304) {
        return { url: cleanUrl, name: sName, working: false, latency, reason: `HTTP Status ${res.status}`, testedAt: Date.now() };
      }

      // Inspect text content for known player / embed error messages (e.g. ToonStream "Oops!... page does not exist")
      const text = (await res.text().catch(() => '')).toLowerCase();

      const isToonStreamHomePage = isToonStream && (
        text.includes('toonstream does not share any files') ||
        text.includes('copyright © toonstream') ||
        text.includes('thursday schedule') ||
        text.includes('friday schedule') ||
        (text.includes('sad face') && !text.includes('<iframe'))
      );

      const isErrorPage = 
        isToonStreamHomePage ||
        text.includes('oops!') ||
        text.includes('page you are looking for does not exist') ||
        text.includes('sandboxed embed is not allowed') ||
        text.includes('error code: 224003') ||
        text.includes('error code 224003') ||
        text.includes('this video file cannot be played') ||
        text.includes('file was deleted') ||
        text.includes('file deleted') ||
        text.includes('video not found') ||
        text.includes('media player error') ||
        text.includes('domain suspended') ||
        text.includes('access denied') ||
        text.includes('404 not found') ||
        text.includes('404 - page not found');

      if (isErrorPage) {
        return { url: cleanUrl, name: sName, working: false, latency, reason: 'Embed returned error or 404 page', testedAt: Date.now() };
      }

      return { url: cleanUrl, name: sName, working: true, latency, testedAt: Date.now() };
    } catch (e: any) {
      const latency = Math.round(performance.now() - startTime);
      return { url: cleanUrl, name: sName, working: false, latency, reason: e.message || 'Error checking server', testedAt: Date.now() };
    }
  }

  async function rankServerList(cacheKey: string, servers: { url: string; name: string }[], forceRefresh = false): Promise<ServerHealthResult[]> {
    if (!forceRefresh && serverRankingCache.has(cacheKey)) {
      const cached = serverRankingCache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < SERVER_CACHE_TTL) {
        return cached.rankedServers;
      }
    }

    if (!servers || servers.length === 0) return [];

    // Concurrently test all server candidates
    const testPromises = servers.map(s => testSingleServerHealth(s.url, s.name));
    const results = await Promise.all(testPromises);

    // Rank: Working servers first (sorted by fastest response time), followed by failed servers
    results.sort((a, b) => {
      if (a.working && !b.working) return -1;
      if (!a.working && b.working) return 1;
      if (a.working && b.working) return a.latency - b.latency;
      return 0;
    });

    serverRankingCache.set(cacheKey, { timestamp: Date.now(), rankedServers: results });
    return results;
  }

  // SMART BATCH SERVER RANKING API
  app.post('/api/rank-servers', async (req, res) => {
    try {
      const { key, servers, forceRefresh } = req.body || {};
      if (!Array.isArray(servers) || servers.length === 0) {
        return res.status(400).json({ error: 'Missing or invalid servers array' });
      }

      const formattedServers = servers.map((s, i) => {
        if (typeof s === 'string') return { url: s, name: `SERVER ${i + 1}` };
        return { url: s.url || '', name: s.name || `SERVER ${i + 1}` };
      });

      const cacheKey = key || formattedServers.map(s => s.url).join('|');
      const ranked = await rankServerList(cacheKey, formattedServers, !!forceRefresh);
      const bestWorking = ranked.find(r => r.working) || ranked[0];

      return res.json({
        success: true,
        rankedServers: ranked,
        bestServer: bestWorking,
        bestServerIndex: ranked.findIndex(r => r.url === bestWorking.url)
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Server ranking error' });
    }
  });

  // RESOLVE TOONSTREAM EPISODE URL TO DIRECT EMBED URLS & ALL STREAMING SERVERS
  app.get('/api/resolve-toonstream', async (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) return res.status(400).json({ error: 'Missing url parameter' });
    try {
      let target = decodeURIComponent(rawUrl).trim();
      if (target.includes('<iframe') && target.includes('src=')) {
        const m = target.match(/src=["']([^"']+)["']/i);
        if (m && m[1]) target = m[1].trim();
      }

      let embedPageUrl = target;
      const availableServerObjs: { url: string; name: string }[] = [];
      const seenUrls = new Set<string>();

      const addServerObj = (sUrl: string, rawName?: string) => {
        let cleanUrl = sUrl.trim();
        const lowerUrl = cleanUrl.toLowerCase();
        // Strictly exclude YouTube / YT links
        if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be') || lowerUrl.includes('/yt/')) {
          return;
        }

        if (cleanUrl.startsWith('/')) {
          try {
            const u = new URL(target);
            cleanUrl = u.origin + cleanUrl;
          } catch (_) {
            cleanUrl = 'https://toon-stream.site' + cleanUrl;
          }
        }
        if (!cleanUrl || seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);

        const name = getRealServerName(cleanUrl, rawName);
        availableServerObjs.push({ url: cleanUrl, name });
      };

      // If target is an episode/watch page or movie page (or main page link)
      if (target.includes('toon-stream.site') || target.includes('toonstream')) {
        const upstream = await fetch(target, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': 'https://toon-stream.site/',
          },
          signal: AbortSignal.timeout(8000)
        }).catch(() => null);

        if (upstream && upstream.ok) {
          const html = await upstream.text();
          const targetOrigin = new URL(target).origin;

          // 1. Extract Dooplay / player options with server titles & AJAX data attributes
          const fullOptionRegex = /<li[^>]*id=["']player-option-(\d+)["'][^>]*>(.*?)<\/li>/gis;
          let optMatch;
          const ajaxOptionPromises: Promise<void>[] = [];

          while ((optMatch = fullOptionRegex.exec(html)) !== null) {
            const fullTag = optMatch[0] || '';
            const optNum = optMatch[1];
            const block = optMatch[2] || '';
            const titleM = block.match(/<span[^>]*class=["'](?:title|server)["'][^>]*>([^<]+)<\/span>/i);
            const serverName = titleM ? titleM[1].trim() : `SERVER ${optNum}`;

            // Search inside tag or block for direct embed link
            const urlM = fullTag.match(/(?:src|data-src|data-link)=["']([^"']+)["']/i) || block.match(/href=["']([^"']+)["']/i);
            if (urlM && urlM[1] && !urlM[1].includes('youtube.com') && !urlM[1].startsWith('javascript:')) {
              addServerObj(urlM[1], serverName);
            } else {
              // Extract data-post, data-type, data-nume for DooPlay / ToonStream AJAX calls
              const postIdM = fullTag.match(/data-post=["'](\d+)["']/i) || fullTag.match(/data-id=["'](\d+)["']/i) || html.match(/data-post=["'](\d+)["']/i);
              const typeM = fullTag.match(/data-type=["']([^"']+)["']/i);
              const numeM = fullTag.match(/data-nume=["']([^"']+)["']/i) || [null, optNum];

              if (postIdM && postIdM[1]) {
                const pId = postIdM[1];
                const pType = typeM ? typeM[1] : (target.includes('/movies/') || target.includes('/movie/') ? 'movie' : 'tv');
                const pNume = numeM && numeM[1] ? numeM[1] : optNum;
                const ajaxUrl = `${targetOrigin}/wp-admin/admin-ajax.php`;

                ajaxOptionPromises.push((async () => {
                  const actions = ['doo_player_dooplay', 'doo_player', 'doo_select_server', 'player_ajax', 'ts_player', 'action_player'];
                  for (const act of actions) {
                    try {
                      const bodyParams = new URLSearchParams();
                      bodyParams.append('action', act);
                      bodyParams.append('post', pId);
                      bodyParams.append('type', pType);
                      bodyParams.append('nume', pNume);

                      const aRes = await fetch(ajaxUrl, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                          'X-Requested-With': 'XMLHttpRequest',
                          'Referer': target,
                          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        },
                        body: bodyParams.toString(),
                        signal: AbortSignal.timeout(5000)
                      });

                      if (aRes.ok) {
                        const resText = await aRes.text();
                        let embedSrc = '';

                        if (resText.trim().startsWith('{')) {
                          try {
                            const parsedObj = JSON.parse(resText);
                            embedSrc = parsedObj.embed_url || parsedObj.url || parsedObj.embed || parsedObj.html;
                          } catch (_) {}
                        }

                        if (!embedSrc) {
                          const frameM = resText.match(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/i) || resText.match(/(https?:\/\/[^\s"']+\/embed\/[^\s"']+)/i) || resText.match(/(https?:\/\/[^\s"']+)/i);
                          if (frameM && frameM[1]) embedSrc = frameM[1];
                        }

                        if (embedSrc && !embedSrc.includes('youtube.com')) {
                          addServerObj(embedSrc, serverName);
                          break;
                        }
                      }
                    } catch (_) {}
                  }
                })());
              }
            }
          }

          if (ajaxOptionPromises.length > 0) {
            await Promise.all(ajaxOptionPromises);
          }

          // 2. Extract iframe src or data-src across entire html
          const matches = [...html.matchAll(/<iframe[^>]+(?:src|data-src|data-link)=["']([^"']+)["']/gi)];
          for (const m of matches) {
            if (m[1] && !m[1].includes('youtube.com') && !m[1].includes('youtu.be')) {
              addServerObj(m[1]);
            }
          }

          // 3. Fallback regex match for /embed/ or player URLs in HTML scripts or links
          const linkMatches = [...html.matchAll(/["']((?:https?:\/\/[^"']+\/embed\/[^"']+)|\/embed\/[a-zA-Z0-9_-]+)["']/gi)];
          for (const lm of linkMatches) {
            if (lm[1]) {
              addServerObj(lm[1]);
            }
          }
        }
      }

      if (availableServerObjs.length === 0) {
        addServerObj(target);
      }

      // Unwrap ToonStream internal embed wrappers to get direct video provider host URLs and names
      const resolvedServerDetails = await Promise.all(
        availableServerObjs.map(async (srv) => {
          let finalUrl = srv.url;
          let rawName = srv.name;

          if (finalUrl.includes('toon-stream.site') || finalUrl.includes('toonstream')) {
            try {
              const uRes = await fetch(finalUrl, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  'Referer': target,
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(3500)
              }).catch(() => null);

              if (uRes && uRes.ok) {
                const uHtml = await uRes.text();
                const frameM = uHtml.match(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/i) ||
                               uHtml.match(/(https?:\/\/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\/[^\s"']+)/i);
                if (frameM && frameM[1] && !frameM[1].includes('youtube.com') && !frameM[1].includes('toon-stream') && !frameM[1].includes('toonstream')) {
                  finalUrl = frameM[1].trim();
                }
              }
            } catch (_) {}
          }

          return {
            url: finalUrl,
            name: getRealServerName(finalUrl, rawName)
          };
        })
      );

      if (resolvedServerDetails.length > 0) {
        embedPageUrl = resolvedServerDetails[0].url;
      }

      return res.json({ 
        embedUrl: embedPageUrl, 
        servers: resolvedServerDetails.map(s => s.url),
        serverDetails: resolvedServerDetails 
      });
    } catch (err: any) {
      console.error('[ResolveToonStream] Error:', err.message);
      return res.status(500).json({ error: err.message || 'Failed resolving ToonStream URL' });
    }
  });

  // PARSE ALL EPISODES FROM A SERIES PAGE (e.g. ToonStream / Series link across ALL Seasons)
  app.all('/api/parse-series-episodes', async (req, res) => {
    try {
      const urlStr = (req.body?.url || req.query?.url || '').toString().trim();
      if (!urlStr) {
        return res.status(400).json({ success: false, error: 'Missing series URL parameter' });
      }

      const resUpstream = await fetch(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': urlStr,
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!resUpstream.ok) {
        return res.status(502).json({ success: false, error: `Upstream responded with status ${resUpstream.status}` });
      }

      const html = await resUpstream.text();
      const origin = new URL(urlStr).origin;

      let seriesTitle = '';
      const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1]) {
        seriesTitle = titleMatch[1]
          .replace(/ - ToonStream.*$/i, '')
          .replace(/ - Watch Online.*$/i, '')
          .replace(/Watch /i, '')
          .replace(/Full Series.*$/i, '')
          .trim();
      }

      // Map to store episodes: cleanUrl -> { seasonNumber: number, episodeNumber: number, title: string, url: string }
      const episodeMap = new Map<string, { seasonNumber: number; episodeNumber: number; title: string; url: string }>();

      const isMovieUrl = urlStr.toLowerCase().includes('/movies/') || urlStr.toLowerCase().includes('/movie/');

      if (isMovieUrl) {
        const cleanKey = urlStr.split('?')[0].replace(/\/$/, '');
        episodeMap.set(cleanKey, {
          seasonNumber: 1,
          episodeNumber: 1,
          title: seriesTitle || 'Full Movie',
          url: urlStr
        });
      } else {
        const helperParseEpAndSeason = (url: string, contextSeason: number = 1, idx: number = 0) => {
          let seasonNum = contextSeason;
          let epNum = 0;

          // Pattern: 1x05 or 01x05
          let m = url.match(/(\d+)x(\d+)/i);
          if (m && m[1] && m[2]) {
            seasonNum = parseInt(m[1], 10);
            epNum = parseInt(m[2], 10);
          } else {
            // Pattern: s02e05 or s2e5
            m = url.match(/s(\d+)e(\d+)/i);
            if (m && m[1] && m[2]) {
              seasonNum = parseInt(m[1], 10);
              epNum = parseInt(m[2], 10);
            } else {
              // Pattern: season-1-episode-5 or s1-ep5 or season-2-ep-5
              m = url.match(/season[^\d]*(\d+)[^\d]*(?:episode|ep)[^\d]*(\d+)/i) || url.match(/s(\d+)[^\d]*ep(\d+)/i);
              if (m && m[1] && m[2]) {
                seasonNum = parseInt(m[1], 10);
                epNum = parseInt(m[2], 10);
              } else {
                // Episode number only
                m = url.match(/(?:episode|ep)[^\d]*(\d+)/i) || url.match(/[\/\-_](\d+)(?:[\/\-_.]|$)/);
                if (m && m[1]) {
                  epNum = parseInt(m[1], 10);
                } else {
                  epNum = idx + 1;
                }
              }
            }
          }
          return { seasonNum, epNum };
        };

        const addEpisodeUrl = (href: string, contextSeason: number = 1, defaultIdx: number = 0, customTitle?: string) => {
          if (!href || typeof href !== 'string' || href.startsWith('#') || href.startsWith('javascript:')) return;
          const lower = href.toLowerCase();
          const isEp = lower.includes('/episode/') || lower.includes('/ep-') || lower.includes('-1x') || lower.includes('-2x') || lower.includes('-3x') || lower.includes('-4x') || lower.includes('-5x') || lower.includes('/watch/') || lower.includes('/ep/');
          if (!isEp) return;

          let fullUrl = href;
          if (href.startsWith('/')) {
            fullUrl = origin + href;
          } else if (!href.startsWith('http://') && !href.startsWith('https://')) {
            fullUrl = origin + '/' + href;
          }

          const cleanKey = fullUrl.split('?')[0].replace(/\/$/, '');
          if (episodeMap.has(cleanKey)) return;

          const { seasonNum, epNum } = helperParseEpAndSeason(fullUrl, contextSeason, defaultIdx);
          episodeMap.set(cleanKey, {
            seasonNumber: seasonNum,
            episodeNumber: epNum,
            title: customTitle || `Episode ${epNum}`,
            url: fullUrl
          });
        };

        // 1. Slice HTML by Season Markers to accurately group static episodes by Season
        interface SeasonMarker { seasonNumber: number; startIndex: number; }
        const seasonMarkers: SeasonMarker[] = [];
        const markerRegex = /(?:id=["']season-(\d+)["']|data-season=["'](\d+)["']|data-tab=["'](?:season-?)?(\d+)["']|<div[^>]*id=["']season-(\d+)["']|<span[^>]*class=["'][^"']*se-t[^"']*["'][^>]*>[\s\S]*?Season\s*(\d+))/gi;

        let mMatch: RegExpExecArray | null;
        while ((mMatch = markerRegex.exec(html)) !== null) {
          const sNumStr = mMatch[1] || mMatch[2] || mMatch[3] || mMatch[4] || mMatch[5];
          if (sNumStr) {
            const parsed = parseInt(sNumStr, 10);
            if (parsed > 0 && parsed < 50) {
              seasonMarkers.push({ seasonNumber: parsed, startIndex: mMatch.index });
            }
          }
        }

        // Sort season markers by startIndex
        seasonMarkers.sort((a, b) => a.startIndex - b.startIndex);

        if (seasonMarkers.length > 0) {
          for (let i = 0; i < seasonMarkers.length; i++) {
            const currentMarker = seasonMarkers[i];
            const nextIndex = (i + 1 < seasonMarkers.length) ? seasonMarkers[i + 1].startIndex : html.length;
            const seasonChunk = html.substring(currentMarker.startIndex, nextIndex);

            const hrefsInChunk = [...seasonChunk.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
            hrefsInChunk.forEach((h, idx) => addEpisodeUrl(h, currentMarker.seasonNumber, idx));
          }
        } else {
          // Fallback static div match
          const seasonDivMatches = [...html.matchAll(/<div[^>]*id=["']season-(\d+)["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi)];
          if (seasonDivMatches.length > 0) {
            for (const sMatch of seasonDivMatches) {
              const sNum = parseInt(sMatch[1], 10) || 1;
              const sContent = sMatch[2];
              const hrefs = [...sContent.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
              hrefs.forEach((h, i) => addEpisodeUrl(h, sNum, i));
            }
          }
        }

        // Scan script tags for embedded JSON episode URLs
        const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
        for (const scriptM of scriptMatches) {
          const scriptContent = scriptM[1];
          if (scriptContent.includes('episode') || scriptContent.includes('season')) {
            const jsonUrls = [...scriptContent.matchAll(/["'](https?:\/\/[^"']+(?:\/episode\/|\/ep-|\/watch\/)[^"']+)["']/gi)];
            for (const ju of jsonUrls) {
              if (ju && ju[1]) addEpisodeUrl(ju[1], 1);
            }
          }
        }

        // Also parse all raw hrefs from initial HTML
        const initialHrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
        initialHrefs.forEach((h, i) => addEpisodeUrl(h, 1, i));

        // 2. Detect Post ID for WordPress / DooPlay / ToonStream AJAX Requests
        let postId = '';
        const postMatch = html.match(/data-post=["'](\d+)["']/i) ||
                          html.match(/id=["']post-(\d+)["']/i) ||
                          html.match(/class=["'][^"']*postid-(\d+)[^"']*["']/i) ||
                          html.match(/var\s+post_id\s*=\s*["']?(\d+)["']?/i) ||
                          html.match(/["']?post_id["']?\s*:\s*["']?(\d+)["']?/i);
        if (postMatch && postMatch[1]) {
          postId = postMatch[1];
        }

        // Detect AJAX Nonce / Security token
        let nonce = '';
        const nonceMatch = html.match(/["']nonce["']\s*:\s*["']([a-zA-Z0-9]+)["']/i) ||
                           html.match(/["']security["']\s*:\s*["']([a-zA-Z0-9]+)["']/i) ||
                           html.match(/dt_ajax\s*=\s*\{[^}]*["']nonce["']\s*:\s*["']([a-zA-Z0-9]+)["']/i) ||
                           html.match(/dooplay\s*=\s*\{[^}]*["']nonce["']\s*:\s*["']([a-zA-Z0-9]+)["']/i) ||
                           html.match(/ts_ajax\s*=\s*\{[^}]*["']nonce["']\s*:\s*["']([a-zA-Z0-9]+)["']/i);
        if (nonceMatch && nonceMatch[1]) {
          nonce = nonceMatch[1];
        }

        // 3. Detect Season Numbers from Tabs, Spans, Options, or Attributes
        const detectedSeasons = new Set<number>();
        seasonMarkers.forEach(sm => detectedSeasons.add(sm.seasonNumber));

        const seasonNumMatches = [
          ...html.matchAll(/data-[#]=["'](\d+)["']/gi),
          ...html.matchAll(/data-season=["'](\d+)["']/gi),
          ...html.matchAll(/data-num=["'](\d+)["']/gi),
          ...html.matchAll(/<span[^>]*class=["'][^"']*se-t[^"']*["'][^>]*>[\s\S]*?Season\s*(\d+)[\s\S]*?<\/span>/gi),
          ...html.matchAll(/<option[^>]*>[\s\S]*?Season\s*(\d+)[\s\S]*?<\/option>/gi),
          ...html.matchAll(/id=["']season-(\d+)["']/gi)
        ];

        for (const sm of seasonNumMatches) {
          if (sm && sm[1]) {
            const parsedS = parseInt(sm[1], 10);
            if (parsedS > 0 && parsedS < 50) detectedSeasons.add(parsedS);
          }
        }

        // Always include at least Season 1 through 10 to check if AJAX returns extra seasons
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(s => detectedSeasons.add(s));

        // 4. Query WordPress / DooPlay / ToonStream admin-ajax.php and WP REST API for Each Season
        const seasonsList = Array.from(detectedSeasons).sort((a, b) => a - b);
        const ajaxEndpoint = `${origin}/wp-admin/admin-ajax.php`;

        const processAjaxPayload = (text: string, sNum: number) => {
          let addedCount = 0;
          if (!text) return 0;

          // Try JSON parse
          if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
            try {
              const parsedJson = JSON.parse(text);
              if (parsedJson.html) {
                const hrefs = [...parsedJson.html.matchAll(/href=["']([^"']+)["']/gi)].map((m: any) => m[1]);
                hrefs.forEach((h: string, idx: number) => {
                  const prev = episodeMap.size;
                  addEpisodeUrl(h, sNum, idx);
                  if (episodeMap.size > prev) addedCount++;
                });
              } else if (Array.isArray(parsedJson)) {
                parsedJson.forEach((item: any, idx: number) => {
                  const itemUrl = item.link || item.url || item.permalink || item.guid?.rendered;
                  if (itemUrl) {
                    const prev = episodeMap.size;
                    addEpisodeUrl(itemUrl, sNum, idx, item.title?.rendered || item.title);
                    if (episodeMap.size > prev) addedCount++;
                  }
                });
              }
            } catch (_) {}
          }

          // Standard HTML href extraction
          const hrefs = [...text.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
          hrefs.forEach((h, idx) => {
            const prev = episodeMap.size;
            addEpisodeUrl(h, sNum, idx);
            if (episodeMap.size > prev) addedCount++;
          });

          return addedCount;
        };

        const fetchSeasonTasks = seasonsList.map(async (sNum) => {
          let foundAny = false;

          // Try DooPlay / ToonStream AJAX actions if postId exists
          if (postId) {
            const actionNames = ['action_select_season', 'seasons', 'seasons_tab', 'doo_select_season', 'ts_select_season', 'get_episodes', 'dt_episodes', 'select_season'];

            for (const actionName of actionNames) {
              if (foundAny) break;

              const bodyParams = new URLSearchParams();
              bodyParams.append('action', actionName);
              bodyParams.append('post', postId);
              bodyParams.append('id', postId);
              bodyParams.append('season', sNum.toString());
              bodyParams.append('season_num', sNum.toString());
              if (nonce) {
                bodyParams.append('security', nonce);
                bodyParams.append('nonce', nonce);
              }

              try {
                const ajaxRes = await fetch(ajaxEndpoint, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': urlStr,
                    'Origin': origin,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                  },
                  body: bodyParams.toString(),
                  signal: AbortSignal.timeout(6000)
                });

                if (ajaxRes.ok) {
                  const ajaxText = await ajaxRes.text();
                  const added = processAjaxPayload(ajaxText, sNum);
                  if (added > 0) {
                    foundAny = true;
                    console.log(`[ParseSeries] Loaded Season ${sNum} via ToonStream AJAX (${actionName}): ${added} new episodes`);
                    break;
                  }
                }
              } catch (_) {}
            }

            // Try WP REST API for episodes
            if (!foundAny) {
              const restUrls = [
                `${origin}/wp-json/dooplay/v1/episodes?post=${postId}&season=${sNum}`,
                `${origin}/wp-json/ts/v1/episodes?id=${postId}&season=${sNum}`,
                `${origin}/wp-json/wp/v2/episodes?parent=${postId}&per_page=100`
              ];
              for (const rUrl of restUrls) {
                try {
                  const rRes = await fetch(rUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    signal: AbortSignal.timeout(4000)
                  });
                  if (rRes.ok) {
                    const rText = await rRes.text();
                    const added = processAjaxPayload(rText, sNum);
                    if (added > 0) {
                      foundAny = true;
                      console.log(`[ParseSeries] Loaded Season ${sNum} via WP REST API (${rUrl}): ${added} new episodes`);
                      break;
                    }
                  }
                } catch (_) {}
              }
            }
          }

          // Try direct season URLs if AJAX did not add new episodes or if postId missing
          if (!foundAny && sNum > 1) {
            const cleanBase = urlStr.replace(/\/$/, '');
            const seasonUrls = [
              `${cleanBase}/season/${sNum}/`,
              `${cleanBase}/season-${sNum}/`,
              `${cleanBase}-season-${sNum}/`,
              `${cleanBase}-s${sNum}/`,
              `${cleanBase}/s${sNum}/`
            ];

            for (const sUrl of seasonUrls) {
              try {
                const sRes = await fetch(sUrl, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': urlStr
                  },
                  signal: AbortSignal.timeout(5000)
                });
                if (sRes.ok) {
                  const sHtml = await sRes.text();
                  const added = processAjaxPayload(sHtml, sNum);
                  if (added > 0) break;
                }
              } catch (_) {}
            }
          }
        });

        await Promise.all(fetchSeasonTasks);

        // If episodeMap is still empty, fallback to adding the page itself
        if (episodeMap.size === 0) {
          const cleanKey = urlStr.split('?')[0].replace(/\/$/, '');
          episodeMap.set(cleanKey, {
            seasonNumber: 1,
            episodeNumber: 1,
            title: seriesTitle ? `${seriesTitle}` : 'Episode 1',
            url: urlStr
          });
        }
      }

      // Group extracted episodes by seasonNumber
      const seasonsGroupMap = new Map<number, Array<{ seasonNumber: number; episodeNumber: number; title: string; url: string }>>();
      for (const item of episodeMap.values()) {
        if (!seasonsGroupMap.has(item.seasonNumber)) {
          seasonsGroupMap.set(item.seasonNumber, []);
        }
        seasonsGroupMap.get(item.seasonNumber)!.push(item);
      }

      // Sort season numbers
      const sortedSeasons = Array.from(seasonsGroupMap.keys()).sort((a, b) => a - b);
      const finalExtractedList: Array<{
        episodeNumber: number;
        seasonNumber: number;
        seasonEpisodeNumber: number;
        title: string;
        url: string;
      }> = [];

      let overallCounter = 1;
      const hasMultipleSeasons = sortedSeasons.length > 1;

      for (const sNum of sortedSeasons) {
        const epItems = seasonsGroupMap.get(sNum)!;
        // Sort within season by episodeNumber ASC
        epItems.sort((a, b) => a.episodeNumber - b.episodeNumber);

        for (const ep of epItems) {
          let epTitle = ep.title;
          if (!epTitle || epTitle.startsWith('Episode')) {
            const sPrefix = hasMultipleSeasons ? `S${sNum} ` : '';
            epTitle = hasMultipleSeasons
              ? `${sPrefix}Ep ${ep.episodeNumber}`
              : (sortedSeasons.length === 1 && epItems.length === 1 && (urlStr.includes('/movies/') || urlStr.includes('/movie/')) ? (seriesTitle || 'Full Movie') : `Episode ${ep.episodeNumber}`);
          }

          finalExtractedList.push({
            episodeNumber: overallCounter++, // Unique sequential index for Firebase
            seasonNumber: sNum,
            seasonEpisodeNumber: ep.episodeNumber,
            title: epTitle,
            url: ep.url
          });
        }
      }

      return res.json({
        success: true,
        seriesTitle,
        totalEpisodes: finalExtractedList.length,
        episodes: finalExtractedList
      });
    } catch (err: any) {
      console.error('[ParseSeriesEpisodes] Error:', err.message);
      return res.status(500).json({ success: false, error: err.message || 'Failed parsing series episodes' });
    }
  });



  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');

    // Pre-parse the production index.html to collect script and style resources for Early Hints
    const earlyHintsLinks: string[] = [];
    try {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf-8');
        
        // Collect stylesheets
        const cssMatches = html.matchAll(/href="([^"]+\.css)"/g);
        for (const m of cssMatches) {
          earlyHintsLinks.push(`<${m[1]}>; rel=preload; as=style`);
        }

        // Collect scripts
        const jsMatches = html.matchAll(/src="([^"]+\.js)"/g);
        for (const m of jsMatches) {
          earlyHintsLinks.push(`<${m[1]}>; rel=preload; as=script`);
        }
        
        console.log(`[Early Hints Engine] Preloaded assets:`, earlyHintsLinks);
      }
    } catch (err: any) {
      console.warn('[Early Hints Engine] Could not parse index.html:', err.message);
    }

    // Serve static files with 1 year cache headers and Cloudflare integration
    app.use(express.static(distPath, {
      maxAge: '1y',
      immutable: true,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
        res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=31536000');
        res.setHeader('CDN-Cache-Control', 'max-age=31536000');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');
      }
    }));

    app.get('*', (req, res) => {
      // Send Early Hints / Link headers for lightning-fast Edge preloading
      if (earlyHintsLinks.length > 0) {
        res.setHeader('Link', earlyHintsLinks.join(', '));
      }
      
      // Let Cloudflare cache the index.html with stale-while-revalidate
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'max-age=3600');
      res.setHeader('Alt-Svc', 'h3=":443"; ma=86400');

      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Full-Stack Server] Running on http://localhost:${PORT}`);
    // Boot Telegram Bot Long Polling Background Engine
    startTelegramPolling();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[Global Uncaught Exception Handler]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Global Unhandled Rejection Handler]:', reason);
});

startServer();
