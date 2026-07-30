import { db } from '../cache';
import { ref, get } from 'firebase/database';

/**
 * In-memory TTL Cache for external Jikan API results
 */
const apiCache = new Map<string, { data: any[]; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes cache

/**
 * Fetch all custom & cached animes from Firebase Realtime Database
 */
async function getAllAnimes(): Promise<any[]> {
  try {
    const animesRef = ref(db, 'animes');
    const snap = await get(animesRef);
    if (snap && snap.exists()) {
      const val = snap.val();
      return Object.values(val).filter(Boolean);
    }
  } catch (err: any) {
    console.warn('[Bot Commands] Error loading animes from DB:', err.message);
  }
  return [];
}

/**
 * Map Jikan MAL API item to standardized anime object
 */
function mapJikanToAnime(item: any): any {
  if (!item) return null;
  return {
    id: item.mal_id ? `mal-${item.mal_id}` : item.title,
    mal_id: item.mal_id,
    title: item.title_english || item.title || 'Untitled Anime',
    englishTitle: item.title_english,
    name: item.title,
    score: item.score ? `${item.score}` : '8.5',
    rating: item.score ? `${item.score}` : '8.5',
    type: item.type || 'TV',
    episodes: item.episodes || 'Completed',
    episodesCount: item.episodes,
    status: item.status || (item.airing ? 'Currently Airing' : 'Completed'),
    year: item.year || (item.aired?.from ? new Date(item.aired.from).getFullYear() : '2024'),
    genres: Array.isArray(item.genres) ? item.genres.map((g: any) => g.name) : ['Anime'],
    description: item.synopsis || 'Watch this anime in HD on Anova Anime Network.',
    poster: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url,
    banner: item.images?.jpg?.large_image_url
  };
}

/**
 * Fetch data from Jikan API with caching
 */
async function fetchJikanApi(cacheKey: string, endpoint: string): Promise<any[]> {
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(`https://api.jikan.moe/v4/${endpoint}`, {
      headers: { 'User-Agent': 'AnovaAnimeBot/2.0' },
      signal: AbortSignal.timeout(5000)
    });

    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.data)) {
        const mapped = json.data.map(mapJikanToAnime).filter(Boolean);
        if (mapped.length > 0) {
          apiCache.set(cacheKey, { data: mapped, timestamp: Date.now() });
        }
        return mapped;
      }
    }
  } catch (err: any) {
    console.warn(`[Bot Commands] Jikan API error for ${cacheKey}:`, err.message);
  }

  return cached?.data || [];
}

/**
 * Jikan Genre IDs mapping for fallbacks
 */
const GENRE_MAP: Record<string, { id: number; name: string }> = {
  '/action': { id: 1, name: 'Action' },
  '/adventure': { id: 2, name: 'Adventure' },
  '/comedy': { id: 4, name: 'Comedy' },
  '/drama': { id: 8, name: 'Drama' },
  '/fantasy': { id: 10, name: 'Fantasy' },
  '/scifi': { id: 24, name: 'Sci-Fi' },
  '/romance': { id: 22, name: 'Romance' },
  '/sliceoflife': { id: 36, name: 'Slice of Life' },
  '/supernatural': { id: 37, name: 'Supernatural' },
  '/mystery': { id: 7, name: 'Mystery' },
  '/horror': { id: 14, name: 'Horror' },
  '/psychological': { id: 40, name: 'Psychological' },
  '/sports': { id: 30, name: 'Sports' },
  '/mecha': { id: 18, name: 'Mecha' },
  '/isekai': { id: 62, name: 'Isekai' },
  '/shounen': { id: 27, name: 'Shounen' },
  '/shoujo': { id: 25, name: 'Shoujo' },
  '/seinen': { id: 42, name: 'Seinen' },
  '/josei': { id: 43, name: 'Josei' },
  '/ecchi': { id: 9, name: 'Ecchi' },
  '/harem': { id: 35, name: 'Harem' },
  '/music': { id: 19, name: 'Music' },
  '/thriller': { id: 41, name: 'Thriller' },
  '/superpower': { id: 31, name: 'Superpower' },
  '/martialarts': { id: 17, name: 'Martial Arts' },
  '/school': { id: 23, name: 'School' },
  '/military': { id: 38, name: 'Military' },
  '/vampire': { id: 32, name: 'Vampire' },
  '/historical': { id: 13, name: 'Historical' }
};

/**
 * Type & Format mapping
 */
const TYPE_MAP: Record<string, { type: string; name: string }> = {
  '/tv': { type: 'tv', name: 'TV Series' },
  '/movie': { type: 'movie', name: 'Anime Movies' },
  '/movies': { type: 'movie', name: 'Anime Movies' },
  '/ova': { type: 'ova', name: 'OVA Specials' },
  '/ona': { type: 'ona', name: 'ONA Series' },
  '/special': { type: 'special', name: 'Special Episodes' }
};

export interface UserPaginationState {
  chatId: string;
  query: string;
  command: string;
  page: number;
  total: number;
  items: any[];
  updatedAt: number;
}

// In-memory pagination state per user/chat
const userPaginationStates = new Map<string, UserPaginationState>();

export function getPaginationState(key: string): UserPaginationState | undefined {
  return userPaginationStates.get(key);
}

export function savePaginationState(key: string, state: UserPaginationState) {
  userPaginationStates.set(key, state);
  // Periodic cleanup of states older than 2 hours
  if (userPaginationStates.size > 500) {
    const now = Date.now();
    for (const [k, v] of userPaginationStates.entries()) {
      if (now - v.updatedAt > 2 * 3600 * 1000) {
        userPaginationStates.delete(k);
      }
    }
  }
}

/**
 * Format a single anime object into a rich Telegram Card with image, metadata, and watch button
 */
function formatAnimeCard(
  anime: any,
  appUrl: string,
  page: number = 1,
  total: number = 1,
  cmdKey: string = ''
): { text: string; photo?: string; parse_mode: string; reply_markup: any } {
  const baseUrl = appUrl.replace(/\/$/, '');
  const title = anime.title || anime.englishTitle || anime.name || 'Untitled Anime';
  const rating = anime.rating || anime.score ? `⭐ ${anime.rating || anime.score}/10` : '⭐ 8.5/10';

  let genresFormatted = 'Action, Fantasy';
  if (Array.isArray(anime.genres)) {
    genresFormatted = anime.genres.map((g: any) => (typeof g === 'string' ? g : g.name)).join(', ');
  } else if (typeof anime.genres === 'string' && anime.genres) {
    genresFormatted = anime.genres;
  }

  const epVal =
    anime.episodesCount ||
    anime.episodes ||
    anime.totalEpisodes ||
    (anime.episodesList ? Object.keys(anime.episodesList).length : null);
  const epString = epVal ? `${epVal} Episodes` : 'Completed';

  const status = anime.status || (anime.airing ? 'Currently Airing' : 'Completed');
  const releaseYear =
    anime.year ||
    anime.releaseDate ||
    anime.seasonYear ||
    (anime.aired?.from ? new Date(anime.aired.from).getFullYear() : '2024');

  const rawDesc =
    anime.description ||
    anime.synopsis ||
    anime.summary ||
    'Watch this amazing anime show now on Anova Anime Network in full HD with multiple audio tracks and fast servers!';
  const cleanDesc = rawDesc.replace(/<[^>]*>?/gm, '').trim();
  const descShort = cleanDesc.length > 220 ? cleanDesc.substring(0, 217) + '...' : cleanDesc;

  const posterUrl = anime.poster || anime.image || anime.coverImage || anime.banner;

  const animeId = anime.id || anime.mal_id;
  const watchUrl = animeId ? `${baseUrl}/anime/${animeId}` : `${baseUrl}/search?q=${encodeURIComponent(title)}`;

  let text = `✨ <b>${escapeHtml(title)}</b> ✨\n\n`;
  text += `⭐ <b>Rating:</b> ${escapeHtml(String(rating))}\n`;
  text += `🎭 <b>Genres:</b> ${escapeHtml(genresFormatted)}\n`;
  text += `📺 <b>Episodes:</b> ${escapeHtml(epString)}\n`;
  text += `📡 <b>Status:</b> ${escapeHtml(status)}\n`;
  text += `📅 <b>Year:</b> ${escapeHtml(String(releaseYear))}\n\n`;
  text += `📝 <b>Description:</b>\n<i>${escapeHtml(descShort)}</i>\n`;

  if (total > 1) {
    text += `\n📌 <b>Result:</b> ${page} of ${total}`;
  }

  const buttons: any[] = [];

  // 1. ▶ Watch Now Button
  buttons.push([
    {
      text: `▶ Watch Now (${title.length > 18 ? title.substring(0, 18) + '...' : title})`,
      url: watchUrl
    }
  ]);

  // Clean cmdKey for clean callback_data (e.g. /search, /trending)
  const cleanCmd = cmdKey.split('_')[0] || '/search';

  // 2. Pagination Row (⬅ Previous | Page X/Y | Next ➡)
  if (total > 1) {
    const prevPage = page > 1 ? page - 1 : total;
    const nextPage = page < total ? page + 1 : 1;

    buttons.push([
      { text: '⬅ Previous', callback_data: `${cleanCmd}_p_${prevPage}` },
      { text: `Page ${page}/${total}`, callback_data: `pg:${page}` },
      { text: 'Next ➡', callback_data: `${cleanCmd}_p_${nextPage}` }
    ]);
  }

  // 3. Quick Launcher Buttons
  buttons.push([
    { text: '🌐 Search Website', url: `${baseUrl}/search` },
    { text: '🔥 Trending', callback_data: '/trending' }
  ]);

  return {
    text,
    photo: posterUrl,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons }
  };
}

/**
 * Helper to store results in pagination state and return formatted card
 */
function storeAndFormatAnimeList(
  matches: any[],
  appUrl: string,
  page: number,
  command: string,
  query: string,
  chatKey?: string,
  msgKey?: string
) {
  const total = matches.length;
  const safePage = Math.min(Math.max(1, page), total);

  if (chatKey || msgKey) {
    const newState: UserPaginationState = {
      chatId: chatKey || '',
      query,
      command,
      page: safePage,
      total,
      items: matches,
      updatedAt: Date.now()
    };
    if (chatKey) savePaginationState(chatKey, newState);
    if (msgKey) savePaginationState(msgKey, newState);
  }

  const selected = matches[safePage - 1];
  return formatAnimeCard(selected, appUrl, safePage, total, command);
}

/**
 * Format a professional "No Anime Found" response
 */
function formatNotFoundCard(query: string, appUrl: string) {
  const baseUrl = appUrl.replace(/\/$/, '');
  return {
    text: `⚠️ <b>No Anime Found</b>\n\nSorry, no anime matches found for "<b>${escapeHtml(
      query
    )}</b>".\n\nTry searching with a different keyword or explore our full catalog directly on the website!`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔍 Search "${query}" on Anova Website`, url: `${baseUrl}/search?q=${encodeURIComponent(query)}` }],
        [{ text: '🌐 Visit Anova Homepage', url: `${baseUrl}/home` }]
      ]
    }
  };
}

/**
 * Main command router for Telegram Bot updates
 */
export async function handleBotCommand(
  commandText: string,
  appUrl: string = process.env.APP_URL || 'https://ai.studio',
  chatId?: number | string,
  messageId?: number | string
): Promise<{ text: string; photo?: string; parse_mode: string; reply_markup?: any }> {
  let rawText = commandText.trim();
  if (!rawText) {
    return handleBotCommand('/help', appUrl, chatId, messageId);
  }

  const baseUrl = appUrl.replace(/\/$/, '');
  const chatKey = chatId ? String(chatId) : '';
  const msgKey = (chatId && messageId) ? `${chatId}:${messageId}` : '';

  // Get existing state for this chat/message if available
  const existingState = (msgKey && getPaginationState(msgKey)) || (chatKey && getPaginationState(chatKey));

  // Parse callback_data / pagination actions
  let requestedPage: number | null = null;
  let isNavAction: 'next' | 'prev' | 'goto' | null = null;

  if (rawText.startsWith('pg:')) {
    const pgArg = rawText.replace(/^pg:/i, '').trim();
    if (pgArg === 'next') {
      isNavAction = 'next';
    } else if (pgArg === 'prev') {
      isNavAction = 'prev';
    } else {
      const parsedNum = parseInt(pgArg, 10);
      if (!isNaN(parsedNum)) {
        requestedPage = parsedNum;
        isNavAction = 'goto';
      }
    }
  }

  // Handle _p_ pattern in rawText e.g. /search_p_2 or /trending_p_3
  const pMatch = rawText.match(/_p_(\d+)(?:_(.*))?$/i);
  if (pMatch) {
    requestedPage = parseInt(pMatch[1], 10) || 1;
    isNavAction = 'goto';
    const extraQuery = pMatch[2] ? pMatch[2].replace(/_/g, ' ') : '';
    rawText = rawText.replace(/_p_\d+.*$/i, '');
    if (extraQuery && !rawText.includes(extraQuery)) {
      rawText += ` ${extraQuery}`;
    }
  }

  // If this is a pagination navigation click and we have cached results state for this chat:
  if (isNavAction && existingState && existingState.items && existingState.items.length > 0) {
    let targetPage = existingState.page;
    if (isNavAction === 'next') {
      targetPage = existingState.page < existingState.total ? existingState.page + 1 : 1;
    } else if (isNavAction === 'prev') {
      targetPage = existingState.page > 1 ? existingState.page - 1 : existingState.total;
    } else if (requestedPage !== null) {
      targetPage = Math.min(Math.max(1, requestedPage), existingState.total);
    }

    existingState.page = targetPage;
    existingState.updatedAt = Date.now();
    if (chatKey) savePaginationState(chatKey, existingState);
    if (msgKey) savePaginationState(msgKey, existingState);

    const anime = existingState.items[targetPage - 1];
    return formatAnimeCard(anime, appUrl, targetPage, existingState.total, existingState.command);
  }

  let page = requestedPage || 1;
  const parts = rawText.split(/\s+/);
  let command = parts[0].toLowerCase().replace(/@\w+$/, ''); // Strip bot handle
  let args = parts.slice(1).join(' ');

  // If text does not start with '/', treat as direct search query!
  if (!command.startsWith('/')) {
    args = rawText;
    command = '/search';
  }

  // If args ends with a number, treat as page offset e.g. /search solo leveling 2
  const trailingNumMatch = args.match(/\s+(\d+)$/);
  if (trailingNumMatch) {
    page = parseInt(trailingNumMatch[1], 10) || page;
    args = args.replace(/\s+\d+$/, '').trim();
  }

  const allDbAnimes = await getAllAnimes();

  // ROUTER LOGIC FOR ALL 50 COMMANDS

  // A. /start & /help
  if (command === '/start' || command === '/help') {
    const text =
      `✨ <b>Anova Anime Network Bot</b> ✨\n\n` +
      `Welcome to the official Anova Anime Bot! Stream your favorite anime, movies, and episodes in full HD directly on our website.\n\n` +
      `⚡ <b>Quick Launcher Commands:</b>\n` +
      `• <b>/latest</b> - Recently updated episodes\n` +
      `• <b>/trending</b> & <b>/popular</b> - Top trending shows\n` +
      `• <b>/top</b> - Highest rated anime\n` +
      `• <b>/movies</b> - Anime movies catalog\n` +
      `• <b>/dub</b> & <b>/hindi</b> - English & Hindi Dubs\n` +
      `• <b>/schedule</b> - Release calendar\n` +
      `• <b>/random</b> - Pick a random anime\n` +
      `• <b>/news</b> - Latest anime announcements\n\n` +
      `💡 <i>Tip: You can also search directly by sending any anime title like "Solo Leveling" or typing <code>/search Demon Slayer</code>!</i>`;

    return {
      text,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Visit Anova Website', url: baseUrl }],
          [
            { text: '🔥 Latest', callback_data: '/latest' },
            { text: '📈 Trending', callback_data: '/trending' },
            { text: '⭐ Top Rated', callback_data: '/top' }
          ],
          [
            { text: '🎬 Movies', callback_data: '/movies' },
            { text: '🎙 Dubbed', callback_data: '/dub' },
            { text: '🇮🇳 Hindi', callback_data: '/hindi' }
          ],
          [
            { text: '🎭 Action', callback_data: '/action' },
            { text: '🧙 Fantasy', callback_data: '/fantasy' },
            { text: '🌌 Isekai', callback_data: '/isekai' }
          ],
          [
            { text: '📅 Schedule', callback_data: '/schedule' },
            { text: '📰 News', callback_data: '/news' },
            { text: '🎲 Random', callback_data: '/random' }
          ]
        ]
      }
    };
  }

  // B. /search <query> or direct search
  if (command === '/search') {
    if (!args) {
      return {
        text: `🔍 <b>Anime Search</b>\n\nPlease provide an anime title to search.\n\nExample:\n<code>/search Solo Leveling</code>\nor simply type: <code>Jujutsu Kaisen</code>`,
        parse_mode: 'HTML'
      };
    }

    const q = args.toLowerCase();
    let matches = allDbAnimes.filter((a) => {
      const t = (a.title || a.name || a.englishTitle || '').toLowerCase();
      const d = (a.description || a.synopsis || '').toLowerCase();
      const g = Array.isArray(a.genres) ? a.genres.join(' ').toLowerCase() : String(a.genres || '').toLowerCase();
      return t.includes(q) || d.includes(q) || g.includes(q);
    });

    // Fallback to Jikan API search if DB produces no matches
    if (matches.length === 0) {
      const apiResults = await fetchJikanApi(`search_${q}`, `anime?q=${encodeURIComponent(args)}&limit=10`);
      matches = apiResults;
    }

    if (matches.length === 0) {
      return formatNotFoundCard(args, appUrl);
    }

    return storeAndFormatAnimeList(matches, appUrl, page, '/search', args, chatKey, msgKey);
  }

  // C. /latest & /recent
  if (command === '/latest' || command === '/recent') {
    let items = [...allDbAnimes].reverse();
    if (items.length === 0) {
      items = await fetchJikanApi('latest_airing', 'top/anime?filter=airing&limit=10');
    }

    if (items.length === 0) {
      return formatNotFoundCard('Latest Anime', appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, command, 'latest', chatKey, msgKey);
  }

  // D. /airing
  if (command === '/airing') {
    let items = allDbAnimes.filter((a) => {
      const st = (a.status || '').toLowerCase();
      return st.includes('airing') || st.includes('ongoing') || a.airing === true;
    });

    if (items.length === 0) {
      items = await fetchJikanApi('airing_top', 'top/anime?filter=airing&limit=10');
    }

    if (items.length === 0) {
      return formatNotFoundCard('Currently Airing Anime', appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, '/airing', 'airing', chatKey, msgKey);
  }

  // E. /popular & /trending
  if (command === '/popular' || command === '/trending') {
    let items = [...allDbAnimes].sort((a, b) => (parseFloat(b.score || b.rating || 0) || 0) - (parseFloat(a.score || a.rating || 0) || 0));
    if (items.length === 0) {
      items = await fetchJikanApi('popular_top', 'top/anime?filter=bypopularity&limit=10');
    }

    if (items.length === 0) {
      return formatNotFoundCard('Trending Anime', appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, command, 'trending', chatKey, msgKey);
  }

  // F. /top
  if (command === '/top') {
    let items = [...allDbAnimes].sort((a, b) => (parseFloat(b.score || b.rating || 0) || 0) - (parseFloat(a.score || a.rating || 0) || 0));
    if (items.length === 0) {
      items = await fetchJikanApi('top_all', 'top/anime?limit=10');
    }

    if (items.length === 0) {
      return formatNotFoundCard('Top Rated Anime', appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, '/top', 'top', chatKey, msgKey);
  }

  // G. /dub & /hindi
  if (command === '/dub' || command === '/hindi') {
    const langKey = command === '/dub' ? 'dub' : 'hindi';
    let items = allDbAnimes.filter((a) => {
      const subDub = (a.subOrDub || a.audio || a.type || '').toLowerCase();
      const title = (a.title || a.name || '').toLowerCase();
      const tags = Array.isArray(a.tags) ? a.tags.join(' ').toLowerCase() : '';
      return subDub.includes(langKey) || title.includes(langKey) || tags.includes(langKey);
    });

    if (items.length === 0) {
      items = await fetchJikanApi(`search_${langKey}`, `anime?q=${langKey}&limit=10`);
    }

    if (items.length === 0) {
      items = [...allDbAnimes].slice(0, 5);
    }

    if (items.length === 0) {
      return formatNotFoundCard(`${command === '/dub' ? 'Dubbed' : 'Hindi'} Anime`, appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, command, langKey, chatKey, msgKey);
  }

  // H. Format Commands (/tv, /movie, /movies, /ova, /ona, /special)
  if (TYPE_MAP[command]) {
    const typeInfo = TYPE_MAP[command];
    let items = allDbAnimes.filter((a) => {
      const t = (a.type || '').toLowerCase();
      return t === typeInfo.type;
    });

    if (items.length === 0) {
      items = await fetchJikanApi(`type_${typeInfo.type}`, `top/anime?type=${typeInfo.type}&limit=10`);
    }

    if (items.length === 0) {
      return formatNotFoundCard(typeInfo.name, appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, command, typeInfo.name, chatKey, msgKey);
  }

  // I. /seasonal
  if (command === '/seasonal') {
    let items = await fetchJikanApi('season_now', 'seasons/now?limit=10');
    if (items.length === 0) {
      items = allDbAnimes.slice(0, 10);
    }

    if (items.length === 0) {
      return formatNotFoundCard('Seasonal Anime', appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, '/seasonal', 'seasonal', chatKey, msgKey);
  }

  // J. /schedule
  if (command === '/schedule') {
    const text =
      `📅 <b>Weekly Anime Release Schedule</b>\n\n` +
      `• <b>Monday:</b> Bleach: TYBW, Tower of God\n` +
      `• <b>Tuesday:</b> Black Clover, Overlord\n` +
      `• <b>Wednesday:</b> Re:Zero, Eminence in Shadow\n` +
      `• <b>Thursday:</b> Jujutsu Kaisen, Wind Breaker\n` +
      `• <b>Friday:</b> Demon Slayer, Chainsaw Man\n` +
      `• <b>Saturday:</b> Solo Leveling, My Hero Academia\n` +
      `• <b>Sunday:</b> One Piece, Dragon Ball\n\n` +
      `⚡ <i>Episodes are synced in real-time right after official broadcast!</i>`;

    const sampleAnime = allDbAnimes[0] || (await fetchJikanApi('schedule_sample', 'top/anime?filter=airing&limit=1'))[0];

    return {
      text,
      photo: sampleAnime?.poster || sampleAnime?.image,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🌐 View Live Schedule on Anova', url: `${baseUrl}/schedule` }]]
      }
    };
  }

  // K. /random
  if (command === '/random') {
    let selected: any = null;
    if (allDbAnimes.length > 0) {
      selected = allDbAnimes[Math.floor(Math.random() * allDbAnimes.length)];
    } else {
      const randApi = await fetchJikanApi(`random_${Date.now()}`, 'random/anime');
      if (randApi.length > 0) selected = randApi[0];
    }

    if (!selected) {
      return formatNotFoundCard('Random Anime', appUrl);
    }

    return formatAnimeCard(selected, appUrl, 1, 1, '/random');
  }

  // L. /news
  if (command === '/news') {
    const text =
      `📰 <b>Anova Anime News & Updates</b>\n\n` +
      `🔥 <b>Solo Leveling Season 2:</b> New episodes dropping this season!\n` +
      `⚡ <b>Bleach TYBW Part 3:</b> Airing now in full 1080p HD!\n` +
      `🎉 <b>Multi-Audio Tracks:</b> Select English, Japanese Sub, or Hindi Dub on player controls!\n\n` +
      `Stay tuned to our Telegram channel for instant episode drop alerts!`;

    const sampleAnime = allDbAnimes[0] || (await fetchJikanApi('news_sample', 'top/anime?limit=1'))[0];

    return {
      text,
      photo: sampleAnime?.poster || sampleAnime?.image,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Read Anime News on Anova', url: `${baseUrl}/news` }],
          [{ text: '🔥 Browse Latest Anime', callback_data: '/latest' }]
        ]
      }
    };
  }

  // M. Genre Commands (28 genres)
  if (GENRE_MAP[command]) {
    const genreObj = GENRE_MAP[command];
    const targetGenre = genreObj.name.toLowerCase();

    let items = allDbAnimes.filter((a) => {
      const g = Array.isArray(a.genres)
        ? a.genres.join(' ').toLowerCase()
        : String(a.genres || '').toLowerCase();
      return g.includes(targetGenre);
    });

    if (items.length < 3) {
      const apiItems = await fetchJikanApi(
        `genre_${genreObj.id}`,
        `anime?genres=${genreObj.id}&order_by=score&sort=desc&limit=10`
      );
      // Combine DB items + API items avoiding duplicate titles
      const existingTitles = new Set(items.map((i) => (i.title || i.name || '').toLowerCase()));
      apiItems.forEach((item) => {
        const t = (item.title || item.name || '').toLowerCase();
        if (!existingTitles.has(t)) {
          items.push(item);
          existingTitles.add(t);
        }
      });
    }

    if (items.length === 0) {
      return formatNotFoundCard(`${genreObj.name} Anime`, appUrl);
    }

    return storeAndFormatAnimeList(items, appUrl, page, command, genreObj.name, chatKey, msgKey);
  }

  // N. Unknown Command Fallback
  return {
    text: `⚠️ <b>Unknown Command:</b> <code>${escapeHtml(
      command
    )}</code>\n\nUse <b>/help</b> or send any anime title to search our catalog!`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '✨ View Command List (/help)', callback_data: '/help' }]]
    }
  };
}

function escapeHtml(text: string = ''): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
