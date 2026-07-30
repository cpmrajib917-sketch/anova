import { db } from '../cache';
import { ref, get, set, push } from 'firebase/database';
import { handleBotCommand } from './botCommands';

export interface TelegramConfig {
  botToken: string;
  channelId: string;
  enabled: boolean;
}

export interface TelegramLogEntry {
  id: string;
  timestamp: string;
  type: 'anime' | 'episode' | 'movie' | 'announcement' | 'news' | 'test';
  title: string;
  messageId?: string | number;
  success: boolean;
  error?: string;
  details?: any;
}

export interface PublishPayload {
  type: 'anime' | 'episode' | 'movie' | 'announcement' | 'news';
  title: string;
  animeId?: string;
  episodeNumber?: number | string;
  subOrDub?: 'Sub' | 'Dub' | 'Sub/Dub' | string;
  rating?: string | number;
  genres?: string[] | string;
  releaseDate?: string;
  description?: string;
  poster?: string;
  banner?: string;
  watchUrl?: string;
}

// Default token provided in configuration
const DEFAULT_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8605704574:AAFQD5cDq4SU4o8HuGqlzs_PVzzv6qqci1M';
const DEFAULT_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '@anovaanime';

// In-memory cache for fast access
let currentConfig: TelegramConfig = {
  botToken: DEFAULT_BOT_TOKEN,
  channelId: DEFAULT_CHANNEL_ID,
  enabled: true
};

let isConfigLoaded = false;
const inMemoryLogs: TelegramLogEntry[] = [];

// Long Polling State
let isPollingActive = false;
let pollingOffset = 0;

/**
 * Delete any active Telegram webhook (required before long polling)
 */
export async function deleteTelegramWebhook(token?: string): Promise<{ success: boolean; description?: string }> {
  try {
    const config = await getTelegramConfig();
    const botToken = (token || config.botToken || '').trim();
    if (!botToken) return { success: false, description: 'No bot token' };

    const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook?drop_pending_updates=false`);
    const data = await res.json();
    return { success: !!data.ok, description: data.description || 'Webhook cleared' };
  } catch (err: any) {
    return { success: false, description: err.message };
  }
}

/**
 * Set a custom Telegram webhook URL if needed
 */
export async function setTelegramWebhook(webhookUrl: string, token?: string): Promise<{ success: boolean; description?: string }> {
  try {
    const config = await getTelegramConfig();
    const botToken = (token || config.botToken || '').trim();
    if (!botToken) return { success: false, description: 'No bot token' };

    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await res.json();
    return { success: !!data.ok, description: data.description };
  } catch (err: any) {
    return { success: false, description: err.message };
  }
}

/**
 * Edit existing Telegram message in-place on callback query (Next/Prev button click).
 * Strictly prevents sending new messages on button clicks.
 */
export async function editTelegramMessageInPlace(
  token: string,
  chatId: number | string,
  messageId: number | string,
  botReply: { text: string; photo?: string; parse_mode: string; reply_markup?: any }
): Promise<{ ok: boolean; message_id?: number | string; description?: string }> {
  const photoUrl = botReply.photo;
  const hasPhotoUrl = Boolean(photoUrl && (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')));

  // 1. Try editMessageMedia if image is available
  if (hasPhotoUrl) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/editMessageMedia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          media: {
            type: 'photo',
            media: photoUrl,
            caption: botReply.text,
            parse_mode: botReply.parse_mode
          },
          reply_markup: botReply.reply_markup
        })
      });
      const data = await res.json();
      if (data.ok) {
        return { ok: true, message_id: data.result?.message_id || messageId };
      }
      if (data.description && data.description.toLowerCase().includes('message is not modified')) {
        return { ok: true, message_id: messageId };
      }
    } catch (e: any) {
      // Ignore error and fall through
    }
  }

  // 2. Try editMessageCaption (for photo messages where only caption/buttons change or if media edit failed)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption: botReply.text,
        parse_mode: botReply.parse_mode,
        reply_markup: botReply.reply_markup
      })
    });
    const data = await res.json();
    if (data.ok) {
      return { ok: true, message_id: data.result?.message_id || messageId };
    }
    if (data.description && data.description.toLowerCase().includes('message is not modified')) {
      return { ok: true, message_id: messageId };
    }
  } catch (e: any) {
    // Ignore error and fall through
  }

  // 3. Try editMessageText (for text-only messages)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: botReply.text,
        parse_mode: botReply.parse_mode,
        reply_markup: botReply.reply_markup
      })
    });
    const data = await res.json();
    if (data.ok) {
      return { ok: true, message_id: data.result?.message_id || messageId };
    }
    if (data.description && data.description.toLowerCase().includes('message is not modified')) {
      return { ok: true, message_id: messageId };
    }
    return { ok: false, description: data.description };
  } catch (e: any) {
    return { ok: false, description: e.message };
  }
}

/**
 * Start Background Telegram Long Polling Engine
 */
export function startTelegramPolling() {
  if (isPollingActive) {
    return;
  }

  isPollingActive = true;
  console.log('[Telegram Engine] Starting Telegram Bot Long Polling background worker...');

  (async () => {
    // 1. Delete conflicting webhooks on start to allow getUpdates
    const initialConfig = await getTelegramConfig();
    if (initialConfig.botToken) {
      await deleteTelegramWebhook(initialConfig.botToken);
    }

    while (isPollingActive) {
      try {
        const activeConfig = await getTelegramConfig();
        if (!activeConfig.enabled || !activeConfig.botToken) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const token = activeConfig.botToken.trim();
        const appUrl = process.env.APP_URL || 'https://ai.studio';

        // Fetch updates with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const pollRes = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?offset=${pollingOffset}&timeout=15`,
          { signal: controller.signal }
        ).catch(() => null);

        clearTimeout(timeoutId);

        if (!pollRes) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const data = await pollRes.json();

        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            pollingOffset = Math.max(pollingOffset, update.update_id + 1);

            const message = update.message || update.edited_message || update.channel_post;
            const callbackQuery = update.callback_query;

            let commandText = '';
            let chatId: any = null;

            if (callbackQuery) {
              commandText = callbackQuery.data || '';
              chatId = callbackQuery.message?.chat?.id || callbackQuery.from?.id;

              // Acknowledge query immediately to remove loading state
              fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackQuery.id })
              }).catch(() => {});
            } else if (message && message.text) {
              commandText = message.text;
              chatId = message.chat?.id;
            }

            if (commandText && chatId) {
              console.log(`[Telegram Polling Received] Chat ${chatId}: "${commandText}"`);

              const messageId = callbackQuery?.message?.message_id;
              const botReply: any = await handleBotCommand(commandText, appUrl, chatId, messageId);

              // If triggered via callback query (e.g. Next / Prev button click), edit existing message in-place
              if (callbackQuery && messageId) {
                const editRes = await editTelegramMessageInPlace(token, chatId, messageId, botReply);
                console.log(`[Telegram Polling Edited] Message ${messageId} in Chat ${chatId}: ok=${editRes.ok}`);
                logTelegramEvent({
                  type: 'announcement',
                  title: `Callback Edit: ${commandText}`,
                  messageId: messageId,
                  success: editRes.ok,
                  details: { chatId, commandText, messageId }
                });
              } else {
                // New user text message: send a new message
                let sendRes: any = null;
                if (botReply.photo && (botReply.photo.startsWith('http://') || botReply.photo.startsWith('https://'))) {
                  sendRes = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: chatId,
                      photo: botReply.photo,
                      caption: botReply.text,
                      parse_mode: botReply.parse_mode,
                      reply_markup: botReply.reply_markup
                    })
                  }).catch(() => null);
                }

                if (!sendRes || !sendRes.ok) {
                  sendRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: chatId,
                      text: botReply.text,
                      parse_mode: botReply.parse_mode,
                      reply_markup: botReply.reply_markup
                    })
                  }).catch(() => null);
                }

                if (sendRes && sendRes.ok) {
                  const sendJson = await sendRes.json().catch(() => ({ ok: true }));
                  console.log(`[Telegram Polling Replied] Response sent for "${commandText}" to Chat ${chatId}`);
                  logTelegramEvent({
                    type: 'announcement',
                    title: `Command: ${commandText}`,
                    messageId: sendJson.result?.message_id,
                    success: true,
                    details: { chatId, commandText }
                  });
                } else {
                  console.warn(`[Telegram Polling Send Error] Failed to reply for "${commandText}"`);
                }
              }
            }
          }
        } else if (data.error_code === 409 || (data.description && data.description.includes('webhook'))) {
          console.warn('[Telegram Polling] Webhook conflict detected. Deleting webhook and retrying long polling...');
          await deleteTelegramWebhook(token);
          await new Promise(r => setTimeout(r, 2000));
        } else if (data.error_code === 401) {
          console.warn('[Telegram Polling] Invalid Telegram Bot Token! Waiting for updated configuration...');
          await new Promise(r => setTimeout(r, 10000));
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('[Telegram Polling Loop Warning]:', err.message);
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
}

/**
 * Restart Telegram Polling Worker on config update
 */
export function restartTelegramPolling() {
  isPollingActive = false;
  setTimeout(() => {
    startTelegramPolling();
  }, 1000);
}

/**
 * Load Telegram config from Firebase Realtime DB with fallback to process.env
 */
export async function getTelegramConfig(): Promise<TelegramConfig> {
  if (isConfigLoaded) {
    return currentConfig;
  }

  try {
    const configRef = ref(db, 'telegram_settings');
    const snap = await get(configRef);
    if (snap && snap.exists()) {
      const val = snap.val();
      currentConfig = {
        botToken: val.botToken || process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN,
        channelId: val.channelId || process.env.TELEGRAM_CHANNEL_ID || DEFAULT_CHANNEL_ID,
        enabled: val.enabled !== undefined ? val.enabled : true
      };
    } else {
      currentConfig = {
        botToken: process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN,
        channelId: process.env.TELEGRAM_CHANNEL_ID || DEFAULT_CHANNEL_ID,
        enabled: true
      };
    }
  } catch (err: any) {
    console.warn('[Telegram Service] Failed to load config from Firebase. Using env/default values:', err.message);
  }

  isConfigLoaded = true;
  return currentConfig;
}

/**
 * Update Telegram configuration in Firebase Realtime DB and memory
 */
export async function updateTelegramConfig(newConfig: Partial<TelegramConfig>): Promise<TelegramConfig> {
  const existing = await getTelegramConfig();
  const updated: TelegramConfig = {
    botToken: newConfig.botToken !== undefined ? newConfig.botToken.trim() : existing.botToken,
    channelId: newConfig.channelId !== undefined ? newConfig.channelId.trim() : existing.channelId,
    enabled: newConfig.enabled !== undefined ? newConfig.enabled : existing.enabled
  };

  currentConfig = updated;
  isConfigLoaded = true;

  try {
    const configRef = ref(db, 'telegram_settings');
    await set(configRef, updated);
  } catch (err: any) {
    console.error('[Telegram Service] Failed to save config to Firebase:', err.message);
  }

  // Restart polling worker with new credentials
  restartTelegramPolling();

  return updated;
}

/**
 * Test Bot Connection using Telegram getMe API
 */
export async function testBotConnection(tokenOverride?: string): Promise<{ success: boolean; botInfo?: any; error?: string }> {
  const config = await getTelegramConfig();
  const token = (tokenOverride || config.botToken || '').trim();

  if (!token) {
    return { success: false, error: 'Telegram Bot Token is missing.' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    const data = await res.json();
    if (data.ok) {
      return { success: true, botInfo: data.result };
    } else {
      return { success: false, error: data.description || 'Failed to authenticate Telegram Bot token.' };
    }
  } catch (err: any) {
    return { success: false, error: `Network error connecting to Telegram API: ${err.message}` };
  }
}

/**
 * Deep sanitize an object to strip undefined properties for Firebase Realtime Database compatibility
 */
function sanitizeForFirebase<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return null as any;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForFirebase(item)).filter(item => item !== undefined) as any;
  }
  if (typeof obj === 'object' && !(obj instanceof Date)) {
    const cleaned: any = {};
    for (const key of Object.keys(obj)) {
      const val = (obj as any)[key];
      if (val !== undefined) {
        cleaned[key] = sanitizeForFirebase(val);
      }
    }
    return cleaned;
  }
  return obj;
}

/**
 * Log an operation event
 */
export async function logTelegramEvent(entry: Omit<TelegramLogEntry, 'id' | 'timestamp'>) {
  const rawLog: TelegramLogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry
  };

  const log = sanitizeForFirebase(rawLog);

  // Keep in memory (max 100 entries)
  inMemoryLogs.unshift(log);
  if (inMemoryLogs.length > 100) {
    inMemoryLogs.length = 100;
  }

  // Persist in Firebase Realtime DB asynchronously
  try {
    const logsRef = ref(db, `telegram_logs/${log.id}`);
    await set(logsRef, log);
  } catch (err: any) {
    console.warn('[Telegram Service] Could not write log to Firebase:', err.message);
  }
}

/**
 * Fetch logs
 */
export async function getTelegramLogs(limit = 50): Promise<TelegramLogEntry[]> {
  try {
    const logsRef = ref(db, 'telegram_logs');
    const snap = await get(logsRef);
    if (snap && snap.exists()) {
      const val = snap.val();
      const list: TelegramLogEntry[] = Object.values(val);
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return list.slice(0, limit);
    }
  } catch (e) {
    // Fallback to in-memory logs
  }
  return inMemoryLogs.slice(0, limit);
}

// In-memory deduplication cache for anime publications to prevent double posts
const recentlyPublishedMap = new Map<string, number>();

/**
 * Thoroughly sanitizes raw YouTube/API titles in server environment
 */
export function sanitizeTitleInServer(rawTitle: string): string {
  if (!rawTitle) return '';
  let cleaned = String(rawTitle).trim();

  // 1. Remove YouTube hashtags (#ULTRAEarlyBird, #shorts, #anime, #hindidub, etc.)
  cleaned = cleaned.replace(/#[\w\u4e00-\u9fa5\u3040-\u30ff\u3000-\u303f_-]+/g, ' ');

  // 2. Remove bracketed channel watermarks and CJK tag blocks
  cleaned = cleaned.replace(/【[^】]*】/g, ' ');
  cleaned = cleaned.replace(/⟪[^⟫]*⟫/g, ' ');
  cleaned = cleaned.replace(/〈[^〉]*〉/g, ' ');
  cleaned = cleaned.replace(/「[^」]*」/g, ' ');
  cleaned = cleaned.replace(/『[^』]*』/g, ' ');

  cleaned = cleaned.replace(/《([^》]*)》/g, (_, content) => {
    if (/[a-zA-Z]/.test(content)) {
      const engOnly = content.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, '').trim();
      return engOnly ? ` ${engOnly} ` : ' ';
    }
    return ' ';
  });

  // 3. Strip channel watermarks, handles, and branding tags after pipes |, dashes -, or @
  cleaned = cleaned.replace(/(?:\||-|@)\s*(?:Ani-One|Muse|AnimeLog|Crunchyroll|Netflix|Kagura|Ganga|GangaAnime|Anime\s*Zone|Anime\s*India|Anime\s*Asia|Ani-One\s*Asia|Muse\s*Asia|Muse\s*India|Muse\s*Vietnam|Muse\s*Malaysia|Ani-One\s*ULTRA|Official\s*Channel|Official\s*Anime|Telegram).*$/gi, '');
  cleaned = cleaned.replace(/@[\w_]+/gi, '');

  // 4. Strip bracketed noise like [ENG SUB], [HINDI DUB], [1080p], (Full Episode), [Batch], etc.
  cleaned = cleaned.replace(/\[\s*(?:HINDI|ENG|ENGLISH|SUB|DUB|SUBBED|DUBBED|HINDI\s*DUB|ENG\s*DUB|DUAL\s*AUDIO|MULTI|JP|UNCENSORED|BATCH|COMPLETED|ALL\s*EPISODES|FULL\s*ANIME|FULL\s*PLAYLIST|PLAYLIST|HD|1080P|720P|4K|OFFICIAL)\s*\]/gi, ' ');
  cleaned = cleaned.replace(/\(\s*(?:HINDI|ENG|ENGLISH|SUB|DUB|SUBBED|DUBBED|HINDI\s*DUB|ENG\s*DUB|DUAL\s*AUDIO|MULTI|JP|UNCENSORED|BATCH|COMPLETED|ALL\s*EPISODES|FULL\s*ANIME|FULL\s*PLAYLIST|PLAYLIST|HD|1080P|720P|4K|OFFICIAL)\s*\)/gi, ' ');

  // 5. Strip residual CJK characters if English text is present
  if (/[a-zA-Z]/.test(cleaned)) {
    cleaned = cleaned.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g, ' ');
  }

  // 6. Strip common video noise words
  cleaned = cleaned.replace(/\b(full\s*anime|full\s*playlist|playlist|official|4k|1080p|720p|hd|batch|completed|all\s*episodes|full\s*season|complete\s*series|english\s*sub|english\s*dub|hindi\s*dub|uncensored|dual\s*audio)\b/gi, ' ');

  // 7. Strip episode tags
  cleaned = cleaned.replace(/\b(episode\s*\d+(?:\s*-\s*\d+)?|ep\s*\d+(?:\s*-\s*\d+)?|eps\s*\d+)\b/gi, ' ');

  cleaned = cleaned.replace(/[-_:\/|]+/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || rawTitle;
}

/**
 * Auto-enrich payload with poster, banner, description, and watchUrl from Database, AniList, & MAL API
 */
async function enrichPayloadFromAnimeData(payload: PublishPayload, appUrl: string): Promise<PublishPayload> {
  const enriched: PublishPayload = { ...payload };
  const rawTitle = (payload.title || '').trim();
  const cleanTitle = sanitizeTitleInServer(rawTitle);

  if (cleanTitle) {
    enriched.title = cleanTitle;
  }

  // 1. First search local Firebase database
  if (payload.animeId || cleanTitle) {
    try {
      const animesRef = ref(db, 'animes');
      const snap = await get(animesRef);
      if (snap && snap.exists()) {
        const list = Object.values(snap.val()) as any[];
        let match: any = null;

        // A) Priority 1: Match strictly by payload.animeId or slug if provided
        if (payload.animeId) {
          match = list.find((a: any) => a && (a.id === payload.animeId || a.slug === payload.animeId));
        }

        // B) Priority 2: Match by exact title if animeId was not found or not provided
        if (!match && cleanTitle) {
          const target = cleanTitle.toLowerCase();
          const isGeneric = /^(episode|ep|eps|season|part|\d+$|new episode|untitled)/i.test(target);
          if (!isGeneric) {
            match = list.find((a: any) => {
              if (!a) return false;
              const t = sanitizeTitleInServer(a.title || a.name || '').toLowerCase();
              if (!t) return false;
              if (t === target) return true;
              if (t.length >= 6 && target.length >= 6 && (t.includes(target) || target.includes(t))) return true;
              return false;
            });
          }
        }

        if (match) {
          if (!enriched.animeId && match.id) enriched.animeId = match.id;
          if (match.title && !match.title.includes('#')) {
            if (!enriched.title || /^(episode|ep|eps|season|part|\d+$|new episode)/i.test(enriched.title)) {
              enriched.title = match.title;
            }
          }
          if (!enriched.poster || enriched.poster.includes('img.youtube.com')) {
            if (match.poster || match.image || match.coverImage) {
              enriched.poster = match.poster || match.image || match.coverImage;
            }
          }
          if (!enriched.banner || enriched.banner.includes('img.youtube.com')) {
            if (match.banner || match.backdrop || match.coverImage) {
              enriched.banner = match.banner || match.backdrop || match.coverImage;
            }
          }
          if (!enriched.description && (match.description || match.synopsis)) {
            enriched.description = match.description || match.synopsis;
          }
          if (!enriched.genres && match.genres) {
            enriched.genres = Array.isArray(match.genres) ? match.genres : [match.genres];
          }
          if (!enriched.rating && (match.rating || match.score)) {
            enriched.rating = match.rating || match.score;
          }
        }
      }
    } catch (err: any) {
      console.warn('[Telegram Service] Local DB enrichment warning:', err.message);
    }
  }

  // 2. Query AniList GraphQL & Jikan MAL API for official high-res poster, banner, title & synopsis
  if ((!enriched.poster || enriched.poster.includes('img.youtube.com') || !enriched.banner || !enriched.description) && cleanTitle) {
    // 2A. AniList GraphQL API (1st Preference)
    try {
      const query = `
        query ($search: String) {
          Media (search: $search, type: ANIME, sort: SEARCH_MATCH) {
            title { english romaji }
            coverImage { extraLarge large }
            bannerImage
            description(asHtml: false)
            averageScore
            genres
          }
        }
      `;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, variables: { search: cleanTitle } }),
        signal: AbortSignal.timeout(4000)
      });

      if (res.ok) {
        const json = await res.json();
        const media = json.data?.Media;
        if (media) {
          if (media.title?.english || media.title?.romaji) {
            enriched.title = media.title.english || media.title.romaji;
          }
          if (media.coverImage?.extraLarge || media.coverImage?.large) {
            enriched.poster = media.coverImage.extraLarge || media.coverImage.large;
          }
          if (media.bannerImage || media.coverImage?.extraLarge) {
            enriched.banner = media.bannerImage || media.coverImage?.extraLarge;
          }
          if (!enriched.description && media.description) {
            let desc = media.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
            enriched.description = desc;
          }
          if (!enriched.rating && media.averageScore) {
            enriched.rating = `${(media.averageScore / 10).toFixed(1)}/10`;
          }
          if (!enriched.genres && media.genres?.length > 0) {
            enriched.genres = media.genres;
          }
        }
      }
    } catch (e: any) {
      console.warn('[Telegram Service] AniList API lookup error:', e.message);
    }

    // 2B. Jikan MAL API Fallback
    if (!enriched.poster || enriched.poster.includes('img.youtube.com')) {
      try {
        const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanTitle)}&limit=1`, {
          headers: { 'User-Agent': 'AnovaAnimeBot/1.0' },
          signal: AbortSignal.timeout(4000)
        });
        if (res.ok) {
          const json = await res.json();
          if (json && Array.isArray(json.data) && json.data.length > 0) {
            const item = json.data[0];
            if (item.title_english || item.title) {
              enriched.title = item.title_english || item.title;
            }
            enriched.poster = item.images?.jpg?.large_image_url || item.images?.webp?.large_image_url || item.images?.jpg?.image_url;
            enriched.banner = item.trailer?.images?.maximum_image_url || item.images?.jpg?.large_image_url;
            if (!enriched.description && item.synopsis) {
              enriched.description = item.synopsis;
            }
            if (!enriched.rating && item.score) {
              enriched.rating = `${item.score}/10`;
            }
            if (!enriched.genres && Array.isArray(item.genres) && item.genres.length > 0) {
              enriched.genres = item.genres.map((g: any) => g.name);
            }
          }
        }
      } catch (e: any) {
        console.warn('[Telegram Service] Jikan API poster lookup error:', e.message);
      }
    }
  }

  // Final check: sanitize the title
  enriched.title = sanitizeTitleInServer(enriched.title || rawTitle);

  // 3. Construct Watch URL
  if (!enriched.watchUrl) {
    if (enriched.animeId && enriched.episodeNumber) {
      enriched.watchUrl = `${appUrl}/watch/${enriched.animeId}/${enriched.episodeNumber}`;
    } else if (enriched.animeId) {
      enriched.watchUrl = `${appUrl}/anime/${enriched.animeId}`;
    } else if (rawTitle) {
      enriched.watchUrl = `${appUrl}/search?q=${encodeURIComponent(enriched.title || rawTitle)}`;
    } else {
      enriched.watchUrl = `${appUrl}/home`;
    }
  }

  return enriched;
}

/**
 * Helper to construct the HTML Telegram Caption
 */
export function buildTelegramCaption(payload: PublishPayload, appUrl: string): { typeHeader: string; caption: string } {
  let typeHeader = '🆕 NEW EPISODE';
  if (payload.type === 'anime') typeHeader = '🌟 NEW ANIME ADDED';
  else if (payload.type === 'movie') typeHeader = '🎬 NEW MOVIE RELEASED';
  else if (payload.type === 'announcement') typeHeader = '📢 ANNOUNCEMENT';
  else if (payload.type === 'news') typeHeader = '📰 ANIME NEWS';

  const genresFormatted = Array.isArray(payload.genres) 
    ? payload.genres.join(', ') 
    : (payload.genres || 'Action, Fantasy');

  const release = payload.releaseDate || new Date().toISOString().split('T')[0];
  const rating = payload.rating ? `⭐ ${payload.rating}` : '⭐ 8.5/10';
  const subDub = payload.subOrDub || 'Sub/Dub';
  const rawDesc = payload.description || 'Watch now in full HD on Anova Anime Network with multiple audio tracks and instant fast streaming servers!';
  const descShort = rawDesc.length > 300 ? rawDesc.substring(0, 297) + '...' : rawDesc;

  const watchLink = payload.watchUrl || appUrl;

  let caption = `${typeHeader}\n\n`;
  caption += `🎬 <b>Title:</b>\n${escapeHtml(payload.title)}\n\n`;

  if (payload.type === 'movie') {
    caption += `📺 <b>Format:</b>\nFull Movie\n\n`;
  } else if (payload.type === 'episode' && payload.episodeNumber) {
    caption += `📺 <b>Episode:</b>\nEpisode ${payload.episodeNumber}\n\n`;
  }

  caption += `🎙 <b>Type:</b>\n${escapeHtml(subDub)}\n\n`;
  caption += `⭐ <b>Rating:</b>\n${escapeHtml(rating)}\n\n`;
  caption += `🎭 <b>Genres:</b>\n${escapeHtml(genresFormatted)}\n\n`;
  caption += `📅 <b>Release:</b>\n${escapeHtml(release)}\n\n`;
  caption += `📝 <b>Description:</b>\n${escapeHtml(descShort)}\n\n`;
  caption += `━━━━━━━━━━━━━━━\n`;
  caption += `▶ <b><a href="${watchLink}">Click to Stream "${escapeHtml(payload.title)}" on Anova</a></b>`;

  return { typeHeader, caption };
}

function escapeHtml(text: string = ''): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Send Telegram Post with automatic retry, poster/banner fallback, and text-only fallback
 */
export async function sendTelegramPost(rawPayload: PublishPayload): Promise<{ success: boolean; messageId?: number | string; error?: string }> {
  const config = await getTelegramConfig();

  if (!config.enabled) {
    console.log('[Telegram Service] Posting skipped because Telegram Integration is disabled.');
    return { success: false, error: 'Telegram integration is disabled in settings.' };
  }

  if (!config.botToken || !config.channelId) {
    const err = 'Bot Token or Channel ID is not configured.';
    console.warn('[Telegram Service]', err);
    await logTelegramEvent({
      type: rawPayload.type,
      title: rawPayload.title,
      success: false,
      error: err
    });
    return { success: false, error: err };
  }

  const appUrl = (process.env.APP_URL || 'https://ai.studio').replace(/\/$/, '');

  // Deduplication check: prevent sending duplicate anime/movie notification within 15 minutes
  const cleanTitleForDedup = sanitizeTitleInServer(rawPayload.title || '').toLowerCase();
  const dedupKey = rawPayload.animeId ? `id_${rawPayload.animeId}` : `title_${cleanTitleForDedup}`;

  if (dedupKey && (rawPayload.type === 'anime' || rawPayload.type === 'movie')) {
    const lastSent = recentlyPublishedMap.get(dedupKey);
    const now = Date.now();
    if (lastSent && (now - lastSent < 15 * 60 * 1000)) {
      console.log(`[Telegram Service] Skipping duplicate ${rawPayload.type} notification for "${dedupKey}" (already sent ${Math.round((now - lastSent)/1000)}s ago)`);
      return { success: true, messageId: 'skipped_duplicate' };
    }
    recentlyPublishedMap.set(dedupKey, now);
  }
  
  // Auto-enrich payload with poster, description, rating, and watch URL
  const payload = await enrichPayloadFromAnimeData(rawPayload, appUrl);
  const { caption } = buildTelegramCaption(payload, appUrl);

  const watchUrl = payload.watchUrl || appUrl;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: `▶ Stream ${payload.title.length > 18 ? payload.title.substring(0, 18) + '...' : payload.title}`, url: watchUrl },
        { text: '🌐 Visit Website', url: appUrl }
      ]
    ]
  };

  const botToken = config.botToken.trim();
  const channelId = config.channelId.trim();

  // Retry wrapper for Telegram HTTP requests
  const executeTelegramApi = async (endpoint: string, bodyObj: any, maxRetries = 3): Promise<any> => {
    let delayMs = 1500;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyObj)
        });

        const data = await res.json();
        if (data.ok) {
          return { ok: true, result: data.result };
        }

        // Handle Rate Limit (429) or transient server errors
        if (data.error_code === 429 || res.status === 429) {
          const retryAfterSeconds = data.parameters?.retry_after || 2;
          console.warn(`[Telegram API 429] Rate limited. Waiting ${retryAfterSeconds}s... (Attempt ${i + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, retryAfterSeconds * 1000 + 500));
          continue;
        }

        // Return error description
        return { ok: false, error: data.description || `HTTP ${res.status} error` };
      } catch (e: any) {
        if (i < maxRetries - 1) {
          await new Promise(r => setTimeout(r, delayMs));
          delayMs *= 2;
          continue;
        }
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'Max retries reached' };
  };

  let sendResult: any = null;
  let usedMedia = 'poster';

  // 1. Try sending Photo with Poster
  if (payload.poster && (payload.poster.startsWith('http://') || payload.poster.startsWith('https://'))) {
    sendResult = await executeTelegramApi('sendPhoto', {
      chat_id: channelId,
      photo: payload.poster,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard
    });
  }

  // 2. Fallback to Banner if Poster failed or didn't exist
  if ((!sendResult || !sendResult.ok) && payload.banner && (payload.banner.startsWith('http://') || payload.banner.startsWith('https://'))) {
    usedMedia = 'banner';
    console.warn(`[Telegram Service] Poster failed or unavailable. Retrying with banner: ${payload.banner}`);
    sendResult = await executeTelegramApi('sendPhoto', {
      chat_id: channelId,
      photo: payload.banner,
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard
    });
  }

  // 3. Fallback to Text-Only message if photo attempts failed or no image exists
  if (!sendResult || !sendResult.ok) {
    usedMedia = 'text-only';
    console.warn('[Telegram Service] Image dispatch failed or no valid image URL provided. Falling back to text-only message.');
    sendResult = await executeTelegramApi('sendMessage', {
      chat_id: channelId,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard
    });
  }

  if (sendResult && sendResult.ok) {
    const msgId = sendResult.result?.message_id || 'unknown';
    console.log(`[Telegram Service SUCCESS] Posted "${payload.title}" to ${channelId} (Media: ${usedMedia}, Message ID: ${msgId})`);
    
    await logTelegramEvent({
      type: payload.type,
      title: payload.title,
      messageId: msgId,
      success: true,
      details: { channelId, usedMedia, episodeNumber: payload.episodeNumber }
    });

    return { success: true, messageId: msgId };
  } else {
    const errMsg = sendResult?.error || 'Unknown Telegram API error';
    console.error(`[Telegram Service ERROR] Failed to post "${payload.title}": ${errMsg}`);

    await logTelegramEvent({
      type: payload.type,
      title: payload.title,
      success: false,
      error: errMsg
    });

    return { success: false, error: errMsg };
  }
}

/**
 * Non-blocking background publisher wrapper
 */
export function queueTelegramPost(payload: PublishPayload) {
  setImmediate(async () => {
    try {
      await sendTelegramPost(payload);
    } catch (err: any) {
      console.error('[Telegram Queue Async Error]:', err.message);
    }
  });
}
