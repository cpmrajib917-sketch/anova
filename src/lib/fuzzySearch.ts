import Fuse from 'fuse.js';

export interface SearchableAnime {
  id: string;
  title: string;
  poster?: string;
  banner?: string;
  type?: string;
  status?: string;
  season?: string;
  year?: string | number;
  season_year?: string | number;
  genres?: string[];
  rating?: string | number;
  description?: string;
  englishTitle?: string;
  romajiTitle?: string;
  synonyms?: string[];
  aliases?: string[];
  [key: string]: any;
}

// Dictionary of known aliases, typos, romaji, and short titles
const KNOWN_ALIASES_MAP: Record<string, string[]> = {
  "jujutsu kaisen": [
    "jujutsu", "kaisen", "jujutsu keisan", "jjk", "jujutsukaisen", 
    "jujutsu kaisen 2nd season", "jujutsu kaisen 0", "sorcery fight"
  ],
  "solo leveling": [
    "solo", "leveling", "leviling", "solo leveling", "solo levelling", 
    "sololeveling", "ore dake level up na ken"
  ],
  "rent-a-girlfriend": [
    "rent girlfriend", "rent-a-girlfriend", "rent girlfriend anime", 
    "kanojo okarishimasu", "rent a girlfriend", "rentgirlfriend"
  ],
  "attack on titan": [
    "attack titan", "aot", "attack on titan", "shingeki no kyojin", 
    "shingeki", "attackontitan"
  ],
  "demon slayer": [
    "demom slayer", "demon slayer", "kimetsu no yaiba", "kimetsu", 
    "demon slayer kimetsu no yaiba", "demonslayer"
  ],
  "my hero academia": [
    "mha", "bnha", "boku no hero", "my hero academia", 
    "boku no hero academia", "myheroacademia"
  ],
  "one piece": ["op", "one piece", "onepiece"],
  "naruto": ["naruto", "naruto shippuden", "narutogame"],
  "bleach": ["bleach", "bleach thousand year blood war", "tybw"],
  "death note": ["death note", "deathnote"],
  "tokyo ghoul": ["tokyo ghoul", "tokyoghoul"],
  "fullmetal alchemist": ["fma", "fmab", "fullmetal alchemist brotherhood"],
  "chainsaw man": ["csm", "chainsaw man", "chainsawman"],
  "spy x family": ["spy family", "spy x family", "spyxfamily"],
  "hunter x hunter": ["hxh", "hunter x hunter", "hunter hunter"],
  "sword art online": ["sao", "sword art online"],
  "tokyo revengers": ["tokyo revengers", "tokyorevengers"],
  "haikyu!!": ["haikyu", "haikyuu", "haikyu!!"],
  "kaguya-sama": ["kaguya sama", "kaguya", "kaguya sama wa kokorasetai"],
  "oshi no ko": ["oshi no ko", "osino ko", "oshinoko"],
  "mushoku tensei": ["jobless reincarnation", "mushoku tensei"],
  "dragon ball": ["dbz", "dragon ball", "dragonball", "dragon ball z", "dragon ball super"],
  "re:zero": ["rezero", "re:zero", "re zero", "starting life in another world"],
  "fate/zero": ["fate zero", "fate stay night", "fate"],
  "jojo's bizarre adventure": ["jojo", "jojos bizarre adventure", "jjba"],
  "classroom of the elite": ["cote", "classroom of the elite", "youkoso jitsuryoku"],
  "vinland saga": ["vinland saga", "vinlandsaga"],
  "steins;gate": ["steins gate", "steinsgate", "steins;gate"],
  "horimiya": ["horimiya"],
  "blue lock": ["blue lock", "bluelock"],
  "bocchi the rock!": ["bocchi", "bocchi the rock"],
  "frieren": ["frieren", "frieren beyond journey's end", "sousou no frieren"],
  "kaiju no. 8": ["kaiju no 8", "kaiju 8", "kaijuno8"],
  "dandadan": ["dandadan"],
  "hell's paradise": ["jigokuraku", "hells paradise", "hell's paradise"],
  "wind breaker": ["wind breaker", "windbreaker"],
  "mashle": ["mashle", "mashle magic and muscles"]
};

/**
 * Returns a corrected canonical search query if the rawQuery matches a known typo/alias or has high similarity
 */
export function suggestCorrectedKeyword(rawQuery: string): string {
  if (!rawQuery) return '';
  const norm = normalizeString(rawQuery);
  const cleanSpaced = cleanSpacedString(rawQuery);

  if (!norm) return '';

  for (const [canonicalTitle, aliasList] of Object.entries(KNOWN_ALIASES_MAP)) {
    const canonicalNorm = normalizeString(canonicalTitle);
    if (norm === canonicalNorm) return canonicalTitle;
    for (const a of aliasList) {
      if (norm === normalizeString(a) || cleanSpaced === cleanSpacedString(a)) {
        return canonicalTitle;
      }
    }
  }

  // Fuzzy similarity lookup against dictionary
  for (const [canonicalTitle, aliasList] of Object.entries(KNOWN_ALIASES_MAP)) {
    const canonicalNorm = normalizeString(canonicalTitle);
    if (calculateSimilarity(norm, canonicalNorm) >= 0.70) {
      return canonicalTitle;
    }
    for (const a of aliasList) {
      if (a.length >= 3 && calculateSimilarity(norm, normalizeString(a)) >= 0.70) {
        return canonicalTitle;
      }
    }
  }

  return rawQuery;
}

/**
 * Normalizes any string by stripping uppercase/lowercase, extra spaces, symbols, hyphens, apostrophes, colons.
 * E.g., "Jujutsu-Kaisen: Season 1" -> "jujutsukaisen season 1" or "jujutsukaisen"
 */
export function normalizeString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, '')
    .trim();
}

/**
 * Clean string preserving spaces between words for token matching
 */
export function cleanSpacedString(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Auto-generates acronyms and token variations for titles
 */
export function generateAutoAliases(title: string): string[] {
  if (!title) return [];
  const aliases: Set<string> = new Set();
  
  const cleanSpaced = cleanSpacedString(title);
  const normalized = normalizeString(title);
  aliases.add(cleanSpaced);
  aliases.add(normalized);

  // Generate acronym (e.g. "Attack on Titan" -> "aot", "Jujutsu Kaisen" -> "jjk" or "jk")
  const words = cleanSpaced.split(' ').filter(w => w.length > 0);
  if (words.length >= 2) {
    const acronym = words.map(w => w[0]).join('');
    if (acronym.length >= 2) {
      aliases.add(acronym);
    }
    // Filter common stop words for secondary acronym
    const stopWords = new Set(['of', 'the', 'a', 'an', 'on', 'in', 'no', 'wa', 'to', 'for', 'and', 'or', 'is', 'x']);
    const meaningfulWords = words.filter(w => !stopWords.has(w));
    if (meaningfulWords.length >= 2 && meaningfulWords.length !== words.length) {
      const meaningfulAcronym = meaningfulWords.map(w => w[0]).join('');
      if (meaningfulAcronym.length >= 2) {
        aliases.add(meaningfulAcronym);
      }
    }
  }

  // Check known aliases dictionary
  const normalizedKey = cleanSpaced;
  for (const [key, knownList] of Object.entries(KNOWN_ALIASES_MAP)) {
    if (normalizedKey.includes(key) || key.includes(normalizedKey) || normalized.includes(normalizeString(key))) {
      knownList.forEach(a => {
        aliases.add(a);
        aliases.add(cleanSpacedString(a));
        aliases.add(normalizeString(a));
      });
    }
  }

  return Array.from(aliases).filter(Boolean);
}

/**
 * Calculates Levenshtein similarity ratio between 0.0 and 1.0
 */
export function calculateSimilarity(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;
  
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0) return len2 === 0 ? 1.0 : 0.0;
  if (len2 === 0) return 0.0;

  const track = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len1; i += 1) track[0][i] = i;
  for (let j = 0; j <= len2; j += 1) track[j][0] = j;

  for (let j = 1; j <= len2; j += 1) {
    for (let i = 1; i <= len1; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }

  const distance = track[len2][len1];
  const maxLen = Math.max(len1, len2);
  return 1.0 - distance / maxLen;
}

interface IndexedItem {
  anime: SearchableAnime;
  titleNorm: string;
  titleCleanSpaced: string;
  allAliases: string[];
  allAliasesNorm: string[];
  genresClean: string[];
}

let cachedAnimeListRef: SearchableAnime[] | null = null;
let cachedIndexedItems: IndexedItem[] = [];
let cachedFuseInstance: Fuse<IndexedItem> | null = null;

/**
 * Builds or retrieves the cached in-memory search index
 */
export function buildSearchIndex(animeList: SearchableAnime[]) {
  if (cachedAnimeListRef === animeList && cachedFuseInstance && cachedIndexedItems.length > 0) {
    return { indexedItems: cachedIndexedItems, fuse: cachedFuseInstance };
  }

  cachedAnimeListRef = animeList;
  cachedIndexedItems = animeList.map(anime => {
    const mainTitle = anime.title || '';
    const engTitle = anime.englishTitle || (anime as any).titles?.english || '';
    const romTitle = anime.romajiTitle || (anime as any).titles?.romaji || '';
    const altList = Array.isArray(anime.synonyms) ? anime.synonyms : [];
    
    const combinedTitles = [mainTitle, engTitle, romTitle, ...altList].filter(Boolean);
    const autoAliases = combinedTitles.flatMap(t => generateAutoAliases(t));
    const customAliases = Array.isArray(anime.aliases) ? anime.aliases : [];

    const allAliases = Array.from(new Set([...combinedTitles, ...autoAliases, ...customAliases]));
    const allAliasesNorm = allAliases.map(a => normalizeString(a));
    const genresClean = Array.isArray(anime.genres)
      ? anime.genres.map(g => cleanSpacedString(typeof g === 'string' ? g : (g as any)?.name || ''))
      : [];

    return {
      anime,
      titleNorm: normalizeString(mainTitle),
      titleCleanSpaced: cleanSpacedString(mainTitle),
      allAliases,
      allAliasesNorm,
      genresClean
    };
  });

  cachedFuseInstance = new Fuse(cachedIndexedItems, {
    keys: [
      { name: 'titleCleanSpaced', weight: 0.4 },
      { name: 'allAliases', weight: 0.35 },
      { name: 'genresClean', weight: 0.15 },
      { name: 'anime.description', weight: 0.1 }
    ],
    threshold: 0.45, // Sensitivity for fuzzy match
    distance: 100,
    minMatchCharLength: 2,
    includeScore: true,
    ignoreLocation: true,
    useExtendedSearch: true
  });

  return { indexedItems: cachedIndexedItems, fuse: cachedFuseInstance };
}

export function isMovieItem(item: SearchableAnime): boolean {
  if (!item) return false;
  const aType = (item.type || (item as any).format || '').toLowerCase().trim();
  const idStr = String(item.id || '').toLowerCase();
  const playlistStr = String((item as any).playlistId || '').toLowerCase();

  // Explicit ID or property markers
  if (idStr.startsWith('yt-movie') || idStr.startsWith('movie-yt') || playlistStr.startsWith('yt-movie')) return true;
  if ((item as any).isMovie === true) return true;
  if ((item as any).categories && ((item as any).categories.movie === true || (item as any).categories.movies === true)) return true;
  if (aType === 'movie' || aType === 'film' || aType.includes('movie') || aType.includes('film')) return true;

  const title = (item.title || (item as any).name || '').toLowerCase();
  if (
    title.includes('movie') || 
    title.includes(' film') || 
    title.includes('the movie') || 
    title.includes('cinema') ||
    title.includes('gekijouban') ||
    title.includes('gekijoban')
  ) return true;

  // Check genres array for explicit movie tags
  const genres = Array.isArray(item.genres) 
    ? item.genres.map(g => (typeof g === 'string' ? g : (g as any)?.name || '').toLowerCase()) 
    : [];
  if (genres.some(g => g.includes('movie') || g.includes('film'))) {
    return true;
  }

  // Single episode non-TV specials/OVAs/ONAs without high episode count
  if (Number(item.episodes) === 1 && aType !== 'tv' && aType !== 'ongoing') {
    return true;
  }

  return false;
}

/**
 * Primary Smart Fuzzy Search Function
 * Ranks by:
 * 1. Exact title / Exact normalized title
 * 2. Normalized title prefix / substring match
 * 3. Exact alias / acronym match
 * 4. Fuzzy match (Similarity score >= 70%)
 * 5. Popularity / Score
 */
export function fuzzySearchAnime(
  query: string, 
  animeList: SearchableAnime[], 
  options: {
    type?: string;
    status?: string;
    season?: string;
    year?: string | number;
    genre?: string;
  } = {}
): SearchableAnime[] {
  if (!animeList || animeList.length === 0) return [];
  
  const rawQuery = (query || '').trim();
  const normQuery = normalizeString(rawQuery);
  const spacedQuery = cleanSpacedString(rawQuery);

  const MOVIE_TERMS = ['movie', 'movies', 'anime movies', 'anime movie', 'film', 'films'];
  const TV_TERMS = ['tv', 'series', 'tv series', 'shows', 'anime series', 'anime shows'];

  const optType = (options.type || '').toLowerCase().trim();
  const optGenre = (options.genre || '').toLowerCase().trim();

  const isMovieFilter = (
    MOVIE_TERMS.includes(optType) ||
    MOVIE_TERMS.includes(optGenre) ||
    MOVIE_TERMS.includes(normQuery)
  );

  const isTvFilter = (
    TV_TERMS.includes(optType) ||
    TV_TERMS.includes(optGenre) ||
    TV_TERMS.includes(normQuery)
  );

  // Filters helper
  const passesFilters = (item: SearchableAnime): boolean => {
    // 1. Strict Movie vs TV separation
    if (isMovieFilter) {
      if (!isMovieItem(item)) return false;
    } else if (isTvFilter) {
      if (isMovieItem(item)) return false;
    } else if (optType && optType !== 'all') {
      const aType = (item.type || '').toLowerCase();
      if (!aType.includes(optType)) return false;
    }

    if (options.status && options.status.toLowerCase() !== 'all') {
      const aStatus = (item.status || '').toLowerCase();
      const fStatus = options.status.toLowerCase();
      if ((fStatus === 'completed' || fStatus === 'finished') && !aStatus.includes('completed') && !aStatus.includes('finished')) return false;
      if ((fStatus === 'releasing' || fStatus === 'ongoing') && !aStatus.includes('releasing') && !aStatus.includes('ongoing') && !aStatus.includes('airing')) return false;
    }

    if (options.year && String(options.year).toLowerCase() !== 'all') {
      const aYear = String(item.season_year || item.year || '');
      if (!aYear.includes(String(options.year))) return false;
    }

    if (options.season && options.season.toLowerCase() !== 'all') {
      const aSeason = String(item.season || '').toLowerCase();
      if (!aSeason.includes(options.season.toLowerCase())) return false;
    }

    if (options.genre && options.genre.toLowerCase() !== 'all') {
      const gClean = options.genre.toLowerCase().trim();
      const normGClean = gClean.replace(/[^a-z0-9]/g, '');

      if (!MOVIE_TERMS.includes(gClean) && !TV_TERMS.includes(gClean) && gClean !== 'anime') {
        let matched = false;

        // 1. Check item.categories object
        if (item.categories && typeof item.categories === 'object') {
          for (const [key, value] of Object.entries(item.categories)) {
            if (value === true) {
              const lowerKey = key.toLowerCase().trim();
              const normKey = lowerKey.replace(/[^a-z0-9]/g, '');
              if (lowerKey === gClean || normKey === normGClean || lowerKey.includes(gClean) || gClean.includes(lowerKey)) {
                matched = true;
                break;
              }
            }
          }
        }

        // 2. Check item.genres (whether array or string)
        if (!matched && item.genres) {
          let genreList: string[] = [];
          if (Array.isArray(item.genres)) {
            genreList = item.genres.map(g => (typeof g === 'string' ? g : (g as any)?.name || '').toLowerCase());
          } else if (typeof item.genres === 'string') {
            genreList = (item.genres as string).split(/[,\/|;]+/).map(s => s.trim().toLowerCase());
          }
          if (genreList.some(g => g.includes(gClean) || gClean.includes(g) || g.replace(/[^a-z0-9]/g, '') === normGClean)) {
            matched = true;
          }
        }

        // 3. Language & Special Category checks
        if (!matched) {
          if (normGClean === 'hindidubbed' || normGClean === 'hindi' || normGClean === 'hindidub') {
            if (item.hindiAvailable === true || String(item.language || '').toLowerCase().includes('hindi') || String(item.title || '').toLowerCase().includes('dub')) {
              matched = true;
            }
          } else if (normGClean === 'bangladubbed' || normGClean === 'bangla' || normGClean === 'bangladub') {
            if (String(item.language || '').toLowerCase().includes('bangla') || String(item.title || '').toLowerCase().includes('bangla')) {
              matched = true;
            }
          } else if (normGClean === 'englishdubbed' || normGClean === 'english' || normGClean === 'englishdub') {
            if (String(item.language || '').toLowerCase().includes('english') || String(item.title || '').toLowerCase().includes('eng')) {
              matched = true;
            }
          } else if (normGClean === 'ongoing' || normGClean === 'releasing') {
            const status = String(item.status || '').toLowerCase();
            if (status.includes('releasing') || status.includes('ongoing') || status.includes('airing')) matched = true;
          } else if (normGClean === 'completed' || normGClean === 'finished') {
            const status = String(item.status || '').toLowerCase();
            if (status.includes('completed') || status.includes('finished')) matched = true;
          }
        }

        if (!matched) return false;
      }
    }

    return true;
  };

  // If query is empty or 'all' or category keyword, return all filtered items ordered by popularity/rating
  const isAllQuery = !normQuery || [
    'all',
    'allanime',
    'all anime',
    'all-anime',
    'all_anime',
    'all animes',
    'allanimes',
    'browse',
    'everything',
    ...MOVIE_TERMS,
    ...TV_TERMS,
    'anime'
  ].includes(normQuery);

  if (isAllQuery) {
    return animeList.filter(passesFilters);
  }

  const { indexedItems, fuse } = buildSearchIndex(animeList);

  // Ranked buckets:
  const exactMatches: IndexedItem[] = [];
  const normalizedMatches: IndexedItem[] = [];
  const aliasMatches: IndexedItem[] = [];
  const fuzzyMatches: { item: IndexedItem; score: number }[] = [];

  const seenIds = new Set<string>();

  // 1. First Pass: Scan indexed items for exact, normalized, and alias matches + Levenshtein >= 70%
  for (const item of indexedItems) {
    if (!passesFilters(item.anime)) continue;

    const id = String(item.anime.id);
    const titleRaw = (item.anime.title || '').toLowerCase();

    // Exact title match
    if (titleRaw === rawQuery.toLowerCase() || item.titleNorm === normQuery) {
      exactMatches.push(item);
      seenIds.add(id);
      continue;
    }

    // Substring or prefix match on title
    if (item.titleNorm.includes(normQuery) || normQuery.includes(item.titleNorm)) {
      normalizedMatches.push(item);
      seenIds.add(id);
      continue;
    }

    // Alias / acronym / typo dictionary match
    let isAliasMatch = false;
    for (const aliasNorm of item.allAliasesNorm) {
      if (aliasNorm === normQuery || aliasNorm.includes(normQuery) || normQuery.includes(aliasNorm)) {
        isAliasMatch = true;
        break;
      }
    }
    if (isAliasMatch) {
      aliasMatches.push(item);
      seenIds.add(id);
      continue;
    }

    // Levenshtein / similarity check against title and aliases (score >= 70%)
    let maxSim = calculateSimilarity(normQuery, item.titleNorm);
    for (const aliasNorm of item.allAliasesNorm) {
      if (aliasNorm.length >= 3) {
        const sim = calculateSimilarity(normQuery, aliasNorm);
        if (sim > maxSim) maxSim = sim;
      }
    }

    if (maxSim >= 0.68) {
      fuzzyMatches.push({ item, score: maxSim });
      seenIds.add(id);
    }
  }

  // 2. Second Pass: Fuse.js search to catch complex tokens/typos not caught in first pass
  if (fuse) {
    const fuseResults = fuse.search(spacedQuery);
    for (const result of fuseResults) {
      const item = result.item;
      const id = String(item.anime.id);
      if (seenIds.has(id)) continue;
      if (!passesFilters(item.anime)) continue;

      const fuseScore = 1 - (result.score || 0); // Convert Fuse 0 (best) to 1 (best)
      if (fuseScore >= 0.5) {
        fuzzyMatches.push({ item, score: fuseScore });
        seenIds.add(id);
      }
    }
  }

  // Sort fuzzy matches by similarity score descending
  fuzzyMatches.sort((a, b) => b.score - a.score);

  // Helper score sorter for items inside buckets by popularity / rating
  const sortByRatingOrPopularity = (a: IndexedItem, b: IndexedItem) => {
    const rA = parseFloat(String(a.anime.rating || 0)) || 0;
    const rB = parseFloat(String(b.anime.rating || 0)) || 0;
    return rB - rA;
  };

  exactMatches.sort(sortByRatingOrPopularity);
  normalizedMatches.sort(sortByRatingOrPopularity);
  aliasMatches.sort(sortByRatingOrPopularity);

  const combinedIndexedResults = [
    ...exactMatches,
    ...normalizedMatches,
    ...aliasMatches,
    ...fuzzyMatches.map(f => f.item)
  ];

  // Return deduplicated SearchableAnime array
  return combinedIndexedResults.map(i => i.anime);
}
