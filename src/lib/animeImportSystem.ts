// @ts-nocheck
import { addCustomAnime, addCustomEpisodesBatch, getCustomAnimes } from './firebaseSync';
import { db } from './firebase';
import { ref, get, remove } from 'firebase/database';

export interface SkippedVideoLog {
  title: string;
  videoId?: string;
  playlistTitle?: string;
  reason: string;
}

export interface FailedMetadataLog {
  animeId: string;
  animeTitle: string;
  reason: string;
}

export interface ImportStats {
  playlistsProcessed: number;
  episodesAdded: number;
  animeCreatedCount: number;
  animeUpdatedCount: number;
  skippedVideos: SkippedVideoLog[];
  failedMetadata: FailedMetadataLog[];
  metadataProgress: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
}

// Words/keywords that indicate NON-EPISODE content (Never Import)
const EXCLUDED_KEYWORDS = [
  'short', 'shorts', '#shorts',
  'clip', 'clips',
  'highlight', 'highlights',
  'trailer', 'trailers',
  'teaser', 'teasers',
  'preview', 'previews',
  'promotional video', 'pv', 'cm',
  'opening', 'ending', 'creditless op', 'creditless ed',
  'amv',
  'reaction', 'reactions',
  'review', 'reviews',
  'news',
  'live stream', 'livestream', 'stream',
  'music video', 'mv',
  'announcement',
  'character video', 'character pv', 'character teaser',
  'compilation',
  'recap',
  'funny moments', 'best moments', 'top moments', 'top 10', 'top 5',
  'fan upload', 'fan made', 'fanmade'
];

// Regexes for precise standalone word boundary checking for short acronyms like OP, ED, PV, CM, AMV, MV
const EXCLUDED_REGEXES = [
  /\b(shorts?|#shorts)\b/i,
  /\b(clips?)\b/i,
  /\b(highlights?)\b/i,
  /\b(trailers?)\b/i,
  /\b(teasers?)\b/i,
  /\b(previews?)\b/i,
  /\b(promotional\s*videos?|pv|cm)\b/i,
  /\b(openings?|endings?|op|ed|creditless)\b/i,
  /\b(amv)\b/i,
  /\b(reactions?)\b/i,
  /\b(reviews?)\b/i,
  /\b(news)\b/i,
  /\b(live\s*streams?|livestreams?)\b/i,
  /\b(music\s*videos?|mv)\b/i,
  /\b(announcements?)\b/i,
  /\b(character\s*(video|pv|teaser))\b/i,
  /\b(compilations?)\b/i,
  /\b(recaps?)\b/i,
  /\b(funny\s*moments|best\s*moments|top\s*moments|top\s*\d+)\b/i,
  /\b(fan\s*upload|fan\s*made|fanmade)\b/i,
];

/**
 * Checks if a video title or description contains non-episode keywords.
 */
export function containsExcludedKeyword(title: string): { isExcluded: boolean; matchedKeyword?: string } {
  if (!title) return { isExcluded: false };
  const lower = title.toLowerCase();

  for (const regex of EXCLUDED_REGEXES) {
    const match = lower.match(regex);
    if (match && match[0]) {
      // Guard against false positives like "Episode" matching "ED" or "OP" inside words
      const kw = match[0].toLowerCase();
      if ((kw === 'op' || kw === 'ed' || kw === 'pv' || kw === 'cm' || kw === 'mv') && lower.includes('episode')) {
        // Double check if it's really an OP/ED or just episode
        if (!/\b(opening|ending|creditless|clean\s*(op|ed))\b/i.test(lower)) {
          continue;
        }
      }
      return { isExcluded: true, matchedKeyword: match[0] };
    }
  }

  return { isExcluded: false };
}

/**
 * Parses video duration string (HH:MM:SS, MM:SS, or ISO 8601 PT#M#S) into total seconds.
 */
export function parseDurationToSeconds(durationStr: any): number {
  if (!durationStr || durationStr === 'N/A') return 0;
  if (typeof durationStr === 'number') return durationStr;
  
  const str = String(durationStr).trim();

  // ISO 8601 duration format (e.g., PT23M12S or PT1H2M)
  if (str.startsWith('PT')) {
    let seconds = 0;
    const hoursMatch = str.match(/(\d+)H/);
    const minsMatch = str.match(/(\d+)M/);
    const secsMatch = str.match(/(\d+)S/);
    if (hoursMatch) seconds += parseInt(hoursMatch[1], 10) * 3600;
    if (minsMatch) seconds += parseInt(minsMatch[1], 10) * 60;
    if (secsMatch) seconds += parseInt(secsMatch[1], 10);
    return seconds;
  }

  // Standard string format e.g. "23:45" or "1:12:30"
  const parts = str.split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return 0;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }

  return 0;
}

/**
 * Detects if anime or video is a Movie, OVA, or ONA based on title / metadata.
 */
export function detectVideoType(title: string, playlistTitle: string = ''): 'TV' | 'Movie' | 'OVA' | 'ONA' {
  const combined = `${title} ${playlistTitle}`.toLowerCase();
  if (combined.includes('movie') || combined.includes('the movie') || combined.includes('gekijouban')) {
    return 'Movie';
  }
  if (combined.includes('ova')) {
    return 'OVA';
  }
  if (combined.includes('ona')) {
    return 'ONA';
  }
  return 'TV';
}

export function isPromotionalPlaylistTitle(playlistTitle: string): boolean {
  if (!playlistTitle) return false;
  const lower = playlistTitle.trim().toLowerCase();
  
  // Playlist titles that indicate trailer/promo collections rather than a real anime
  const promoPlaylistRegex = /\b(trailers?|pvs?|pv\b|promotional|promotions?|promotional\s*video|previews?|teasers?|clips?|short\s*clips?|best\s*moments|compilations?|movie\s*trailers?|movie\s*clips?|all\s*trailers?|official\s*trailers?|anime\s*pv|behind\s*the\s*scenes|cast\s*interview|voice\s*actors?)\b/i;
  
  // If the title is strictly a trailer or promo collection title
  if (promoPlaylistRegex.test(lower) && !/\b(full\s*anime|all\s*episodes|season\s*\d+|episodes?|ep\s*\d+)\b/i.test(lower)) {
    return true;
  }
  return false;
}

export interface FilterResult {
  shouldImport: boolean;
  skipReason?: string;
  category?: 'trailer' | 'short' | 'clip' | 'op_ed' | 'under_18m' | 'other';
}

/**
 * Validates whether a video should be imported according to Smart Import rules.
 */
export function filterVideoForImport(video: any, playlistTitle: string = ''): FilterResult {
  if (!video) return { shouldImport: false, skipReason: 'Invalid video object', category: 'other' };

  // 0. Check if entire playlist is a trailer/promotional collection
  if (playlistTitle && isPromotionalPlaylistTitle(playlistTitle)) {
    return { shouldImport: false, skipReason: 'Promotional / Trailer Playlist', category: 'trailer' };
  }

  const title = String(video.title || '').trim();
  const url = String(video.url || video.videoId || '').toLowerCase();

  // 1. YouTube Shorts check (Rule 5)
  if (url.includes('/shorts/') || /\b(shorts?|#shorts)\b/i.test(title)) {
    return { shouldImport: false, skipReason: 'YouTube Short', category: 'short' };
  }

  // 2. Trailer / Promotional check (Rule 4)
  const trailerRegex = /\b(trailers?|official\s*trailer|pvs?|pv\d*|special\s*pv|teaser\s*pv|main\s*pv|character\s*pv|promotional|promotion|promotional\s*video|promotional\s*clip|previews?|web\s*preview|next\s*ep\s*preview|ep\d*\s*preview|teasers?|announcements?|coming\s*soon|cm|commercials?|tvcm|tv-cm|webcm|web-cm|special\s*digest|special\s*video|interview|comment\s*video|voice\s*cast|cast\s*comment|behind\s*the\s*scenes)\b/i;
  if (trailerRegex.test(title)) {
    return { shouldImport: false, skipReason: 'Trailer / PV / Promo', category: 'trailer' };
  }

  // 3. Clips / Highlights / Edits / AMV / Reaction / Recap / Compilation check (Rule 6)
  const clipRegex = /\b(clips?|scenes?|famous\s*scene|movie\s*clip|film\s*clip|best\s*moments|highlights?|edits?|amv|recaps?|reactions?|compilations?|extra\s*clip|cuttings?|short\s*ver|short\s*version)\b/i;
  if (clipRegex.test(title)) {
    return { shouldImport: false, skipReason: 'Clip / Highlight / Edit / AMV', category: 'clip' };
  }

  // 4. Opening / Ending / OST check (Rule 7)
  const opEdRegex = /\b(openings?|endings?|creditless\s*op|creditless\s*ed|audio\s*drama|voice\s*drama|ost|soundtrack|music\s*video)\b/i;
  if (opEdRegex.test(title)) {
    return { shouldImport: false, skipReason: 'Opening / Ending / OST', category: 'op_ed' };
  }
  if (/\b(op|ed|pv|cm|mv)\d*\b/i.test(title) && !/episode/i.test(title) && !/\bep\s*\d+/i.test(title) && !/\be\d+/i.test(title)) {
    return { shouldImport: false, skipReason: 'Opening / Ending / Promo Acronym', category: 'op_ed' };
  }

  // 5. Movie Clip / Movie Trailer Filter
  const combinedText = `${title} ${playlistTitle}`.toLowerCase();
  const isMovieContent = /\b(movies?|films?|gekijouban)\b/i.test(combinedText);
  const durationSec = parseDurationToSeconds(video.duration);

  if (isMovieContent) {
    // If a movie video contains trailer/clip keywords, skip as movie trailer/clip
    const movieTrailerKeywords = /\b(trailers?|clips?|teasers?|pvs?|previews?|scenes?|cuts?|promos?|cm|digest|highlights?|official\s*trailer|special\s*video)\b/i;
    if (movieTrailerKeywords.test(title)) {
      return { shouldImport: false, skipReason: 'Movie Clip / Movie Trailer', category: 'trailer' };
    }
    // Full movies run 15-20+ minutes at minimum. If under 15 minutes (900 seconds), it's a trailer or promotional clip
    if (durationSec > 0 && durationSec < 900) {
      return { shouldImport: false, skipReason: 'Movie Clip / Movie Trailer (Duration under 15m)', category: 'trailer' };
    }
  }

  // 6. Check Duration under 3 minutes (180 seconds) for standard TV episodes (Rule 8)
  const isOvaOna = /\b(ona|ova|specials?)\b/i.test(combinedText);
  if (durationSec > 0 && durationSec < 180 && !isMovieContent && !isOvaOna) {
    return { shouldImport: false, skipReason: 'Duration under 3 minutes (Short Clip/Promo)', category: 'under_18m' };
  }

  return { shouldImport: true };
}

/**
 * Thoroughly sanitizes raw YouTube/API titles by stripping all tags, hashtags, bracket blocks,
 * channel watermarks, CJK tag prefixes/suffixes, and promo junk.
 */
export function sanitizeAnimeTitle(title: string): string {
  if (!title) return '';
  let cleaned = String(title).trim();

  // 1. Remove YouTube hashtags (#ULTRAEarlyBird搶先看, #shorts, #anime, #hindidub, etc.)
  cleaned = cleaned.replace(/#[\w\u4e00-\u9fa5\u3040-\u30ff\u3000-\u303f_-]+/g, ' ');

  // 2. Remove bracketed channel watermarks and CJK tag blocks
  // e.g. 【Ani-One Asia ULTRA】, 【Ani-One Asia】, 【Ani-One】, 【Muse Asia】, [ENG SUB], [HINDI DUB], etc.
  cleaned = cleaned.replace(/【[^】]*】/g, ' ');
  cleaned = cleaned.replace(/⟪[^⟫]*⟫/g, ' ');
  cleaned = cleaned.replace(/〈[^〉]*〉/g, ' ');
  cleaned = cleaned.replace(/「[^」]*」/g, ' ');
  cleaned = cleaned.replace(/『[^』]*』/g, ' ');

  // For 《...》 double guillemets (commonly used in Chinese/Japanese titles like 《You and I are Polar Opposites Season 2》 or 《相反的...》)
  cleaned = cleaned.replace(/《([^》]*)》/g, (_, content) => {
    if (/[a-zA-Z]/.test(content)) {
      const engOnly = content.replace(/[\u4e00-\u9fa5\u3040-\u30ff]/g, '').trim();
      return engOnly ? ` ${engOnly} ` : ' ';
    }
    return ' ';
  });

  // 3. Strip YouTube channel watermarks, handles, and branding tags after pipes |, dashes -, or @
  cleaned = cleaned.replace(/(?:\||-|@)\s*(?:Ani-One|Muse|AnimeLog|Crunchyroll|Netflix|Kagura|Ganga|GangaAnime|Anime\s*Zone|Anime\s*India|Anime\s*Asia|Ani-One\s*Asia|Muse\s*Asia|Muse\s*India|Muse\s*Vietnam|Muse\s*Malaysia|Ani-One\s*ULTRA|Official\s*Channel|Official\s*Anime|Telegram).*$/gi, '');
  cleaned = cleaned.replace(/@[\w_]+/gi, '');

  // 4. Strip bracketed noise like [ENG SUB], [HINDI DUB], [1080p], (Full Episode), [Batch], etc.
  cleaned = cleaned.replace(/\[\s*(?:HINDI|ENG|ENGLISH|SUB|DUB|SUBBED|DUBBED|HINDI\s*DUB|ENG\s*DUB|DUAL\s*AUDIO|MULTI|JP|UNCENSORED|BATCH|COMPLETED|ALL\s*EPISODES|FULL\s*ANIME|FULL\s*PLAYLIST|PLAYLIST|HD|1080P|720P|4K|OFFICIAL)\s*\]/gi, ' ');
  cleaned = cleaned.replace(/\(\s*(?:HINDI|ENG|ENGLISH|SUB|DUB|SUBBED|DUBBED|HINDI\s*DUB|ENG\s*DUB|DUAL\s*AUDIO|MULTI|JP|UNCENSORED|BATCH|COMPLETED|ALL\s*EPISODES|FULL\s*ANIME|FULL\s*PLAYLIST|PLAYLIST|HD|1080P|720P|4K|OFFICIAL)\s*\)/gi, ' ');

  // 5. Strip residual standalone CJK (Chinese/Japanese/Korean) characters if English text is present
  if (/[a-zA-Z]/.test(cleaned)) {
    cleaned = cleaned.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g, ' ');
  }

  // 6. Strip common video quality / batch noise words
  cleaned = cleaned.replace(/\b(full\s*anime|full\s*playlist|playlist|official|4k|1080p|720p|hd|batch|completed|all\s*episodes|full\s*season|complete\s*series|english\s*sub|english\s*dub|hindi\s*dub|uncensored|dual\s*audio)\b/gi, ' ');

  // 7. Strip episode tags if purifying anime series name
  cleaned = cleaned.replace(/\b(episode\s*\d+(?:\s*-\s*\d+)?|ep\s*\d+(?:\s*-\s*\d+)?|eps\s*\d+)\b/gi, ' ');

  // Clean remaining punctuation and extra spaces
  cleaned = cleaned.replace(/[-_:\/|]+/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned || title;
}

export function cleanAnimeTitleForDisplay(title: string): string {
  if (!title) return '';
  const sanitized = sanitizeAnimeTitle(title);
  return sanitized || title;
}

/**
 * Cleans anime titles for metadata searching by stripping episode numbers, sub/dub tags, channel watermarks, etc.
 */
export function cleanTitleForSearch(title: string): string {
  if (!title) return '';
  return sanitizeAnimeTitle(title);
}

/**
 * Normalizes title string for exact duplicate matching (e.g., "Apocalypse Bringer Mynoghra" -> "apocalypsebringermynoghra").
 */
export function normalizeTitleForComparison(title: string): string {
  if (!title) return '';
  return cleanTitleForSearch(title)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Calculates Sorensen-Dice similarity coefficient between two strings (0.0 to 1.0)
 */
export function calculateTitleSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

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
}

/**
 * Search anime metadata hierarchically: AniList -> Jikan (MAL) -> Kitsu
 */
export async function fetchAnimeMetadataHierarchical(searchTitle: string): Promise<{
  success: boolean;
  data?: any;
  source?: 'anilist' | 'jikan' | 'kitsu';
  error?: string;
}> {
  const cleanQuery = cleanTitleForSearch(searchTitle);
  if (!cleanQuery) {
    return { success: false, error: 'Empty search query' };
  }

  // First try server API proxy endpoint if available
  try {
    const res = await fetch(`/api/anime-metadata?title=${encodeURIComponent(cleanQuery)}`);
    if (res.ok) {
      const result = await res.json();
      if (result.success && result.data) {
        return { success: true, data: result.data, source: result.source };
      }
    }
  } catch (err) {
    // Fallback to client-side direct calls if server endpoint unavailable
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
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { search: cleanQuery } })
    });

    if (res.ok) {
      const json = await res.json();
      const media = json.data?.Media;
      if (media && (media.description || media.genres?.length > 0 || media.coverImage?.extraLarge)) {
        const candEng = media.title?.english || '';
        const candRom = media.title?.romaji || '';
        const candNat = media.title?.native || '';
        const maxSim = Math.max(
          calculateTitleSimilarity(cleanQuery, candEng),
          calculateTitleSimilarity(cleanQuery, candRom),
          calculateTitleSimilarity(cleanQuery, candNat)
        );

        if (maxSim >= 0.45 || candEng.toLowerCase().includes(cleanQuery.toLowerCase()) || cleanQuery.toLowerCase().includes(candEng.toLowerCase())) {
          // Strip HTML tags if any residual exist in description
          let desc = media.description || '';
          desc = desc.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

          const formatted = {
            anilistId: String(media.id || ''),
            malId: String(media.idMal || ''),
            title: media.title?.english || media.title?.romaji || cleanQuery,
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

          if (formatted.description) {
            return { success: true, data: formatted, source: 'anilist' };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[AniList Metadata Fetch Error]:', err);
  }

  // 2. MyAnimeList / Jikan API v4 (2nd Preference)
  try {
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(cleanQuery)}&limit=1`);
    if (res.ok) {
      const json = await res.json();
      const anime = json.data?.[0];
      if (anime && (anime.synopsis || anime.genres?.length > 0)) {
        const formatted = {
          malId: String(anime.mal_id || ''),
          anilistId: '',
          title: anime.title_english || anime.title || cleanQuery,
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

        if (formatted.description) {
          return { success: true, data: formatted, source: 'jikan' };
        }
      }
    }
  } catch (err) {
    console.warn('[Jikan Metadata Fetch Error]:', err);
  }

  // 3. Kitsu API (3rd Preference Fallback)
  try {
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(cleanQuery)}&page[limit]=1`);
    if (res.ok) {
      const json = await res.json();
      const anime = json.data?.[0]?.attributes;
      if (anime && (anime.synopsis || anime.posterImage?.large)) {
        const formatted = {
          title: anime.canonicalTitle || cleanQuery,
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

        if (formatted.description) {
          return { success: true, data: formatted, source: 'kitsu' };
        }
      }
    }
  } catch (err) {
    console.warn('[Kitsu Metadata Fetch Error]:', err);
  }

  return { success: false, error: `No metadata found on AniList, MAL, or Kitsu for '${cleanQuery}'` };
}

/**
 * Finds if an anime already exists in DB to prevent duplicates (Rule 1 & Rule 2).
 * Compares AniList ID, MAL ID, Title, Alternative titles, Slugs, Fuzzy Similarity, and Video Sources.
 */
export function findExistingAnimeMatch(
  title: string,
  playlistId: string,
  customAnimes: Record<string, any>,
  metaIds?: { anilistId?: string; malId?: string },
  playlistVideoIds?: string[]
): string | null {
  if (!customAnimes || typeof customAnimes !== 'object') return null;

  const targetPlaylistAnimeId = playlistId ? `yt-pl-${playlistId}` : '';
  if (targetPlaylistAnimeId && customAnimes[targetPlaylistAnimeId]) {
    return targetPlaylistAnimeId;
  }

  // 1. Direct ID, Playlist ID, or Slug match across all custom animes
  for (const [id, anime] of Object.entries(customAnimes)) {
    if (!anime) continue;

    // AniList ID Match
    if (metaIds?.anilistId && anime.anilistId && String(metaIds.anilistId) === String(anime.anilistId)) {
      return id;
    }

    // MAL ID Match
    if (metaIds?.malId && anime.malId && String(metaIds.malId) === String(anime.malId)) {
      return id;
    }

    // Direct Playlist ID or Anime ID / Slug match
    if (
      (playlistId && (anime.playlistId === playlistId || anime.id === playlistId)) ||
      (targetPlaylistAnimeId && (anime.id === targetPlaylistAnimeId || id === targetPlaylistAnimeId)) ||
      (anime.slug && playlistId && anime.slug === playlistId)
    ) {
      return id;
    }
  }

  // 2. Video Source ID Overlap Check
  if (playlistVideoIds && playlistVideoIds.length > 0) {
    const targetVideoSet = new Set(playlistVideoIds.filter(Boolean));
    if (targetVideoSet.size > 0) {
      for (const [id, anime] of Object.entries(customAnimes)) {
        if (!anime) continue;
        const episodes = anime.episodesList || anime.episodesData || anime.episodes || [];
        const epValues = typeof episodes === 'object' ? Object.values(episodes) : Array.isArray(episodes) ? episodes : [];
        let matchCount = 0;
        for (const ep of epValues) {
          if (!ep) continue;
          const urls = [
            ep.videoSources?.sub?.url,
            ep.videoSources?.eng_dub?.url,
            ep.videoSources?.hindi_dub?.url,
            ep.videoSources?.other?.url,
            ep.url
          ].filter(Boolean);

          for (const u of urls) {
            for (const vid of targetVideoSet) {
              if (u.includes(vid)) {
                matchCount++;
                if (matchCount >= 2 || (targetVideoSet.size <= 3 && matchCount >= 1)) {
                  return id;
                }
              }
            }
          }
        }
      }
    }
  }

  // 3. Multi-field Normalized Title, Fuzzy & Token Overlap Checks
  const cleanedTargetTitle = cleanTitleForSearch(title);
  const normalizedTargetTitle = normalizeTitleForComparison(title);

  for (const [id, anime] of Object.entries(customAnimes)) {
    if (!anime) continue;

    const titlesToCheck = [
      anime.title,
      anime.englishTitle,
      anime.romajiTitle,
      anime.nativeTitle,
      anime.name
    ].filter((t): t is string => Boolean(t) && typeof t === 'string');

    for (const t of titlesToCheck) {
      const cleanedExisting = cleanTitleForSearch(t);
      const normExisting = normalizeTitleForComparison(t);

      // A) Exact normalized title match
      if (normalizedTargetTitle && normExisting && normalizedTargetTitle === normExisting) {
        return id;
      }

      // B) High Fuzzy Similarity Match (>= 82% similarity)
      if (cleanedTargetTitle.length >= 3 && cleanedExisting.length >= 3) {
        const sim = calculateTitleSimilarity(cleanedTargetTitle, cleanedExisting);
        if (sim >= 0.82) {
          return id;
        }
      }

      // C) Core word containment ratio check (e.g., "solo leveling" vs "solo leveling season 1")
      if (normalizedTargetTitle.length >= 7 && normExisting.length >= 7) {
        if (normalizedTargetTitle.includes(normExisting) || normExisting.includes(normalizedTargetTitle)) {
          const lenRatio = Math.min(normalizedTargetTitle.length, normExisting.length) / Math.max(normalizedTargetTitle.length, normExisting.length);
          if (lenRatio >= 0.60) {
            return id;
          }
        }
      }
    }
  }

  return null;
}
