import React, { useState, useEffect } from 'react';
import { 
  Activity, 
  CheckCircle2, 
  AlertTriangle, 
  Trash2, 
  RefreshCw, 
  Play, 
  ShieldCheck, 
  Sparkles, 
  Filter, 
  Search, 
  Youtube, 
  XCircle, 
  EyeOff, 
  Clock, 
  ExternalLink,
  Layers,
  VideoOff,
  Film
} from 'lucide-react';
import { getCustomAnimes, getCustomEpisodes, addCustomEpisodesBatch, deleteCustomAnime, addCustomAnime } from '../lib/firebaseSync';
import { cn, getYoutubeId } from '../lib/utils';

export interface VideoHealthItem {
  id: string;
  animeId: string;
  animeTitle: string;
  episodeNumber: number;
  language: string;
  videoId: string;
  url: string;
  status: 'active' | 'broken' | 'private' | 'deleted' | 'unavailable' | 'short' | 'checking';
  reason?: string;
  title?: string;
  durationSeconds?: number;
  checkedAt?: number;
  isDuplicate?: boolean;
}

// Helper: Detect promotional clips, trailers, shorts, and teasers accidentally added as episodes
export const isPromotionalOrShortClip = (title?: string, durationSeconds?: number): boolean => {
  // Duration under 90 seconds (1.5 minutes) is almost certainly a promotional teaser/short, not a full episode
  if (durationSeconds && durationSeconds > 0 && durationSeconds <= 90) {
    return true;
  }
  
  if (title) {
    const lowerTitle = title.toLowerCase();
    const promoKeywords = [
      'trailer', 'teaser', 'promo', 'pv 1', 'pv 2', 'pv 3', 'official pv',
      'official trailer', 'tvcm', 'commercial', 'preview', 'announcement', 'short clip'
    ];
    const hasPromoKeyword = promoKeywords.some(kw => lowerTitle.includes(kw));
    
    // If title has promo keyword and duration is under 180 seconds (3 mins) or unknown
    if (hasPromoKeyword && (!durationSeconds || durationSeconds <= 180)) {
      return true;
    }
  }
  return false;
};

export function VideoHealthDashboard() {
  const [stats, setStats] = useState({
    totalVideos: 0,
    activeCount: 0,
    brokenCount: 0,
    privateCount: 0,
    deletedCount: 0,
    unavailableCount: 0,
    duplicateCount: 0,
    promosCount: 0,
    deadAnimeCount: 0,
    lastScanTime: 0
  });

  const [healthItems, setHealthItems] = useState<VideoHealthItem[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    current: 0,
    total: 0,
    currentTitle: '',
    statusText: ''
  });

  const [filterStatus, setFilterStatus] = useState<'all' | 'broken' | 'private' | 'deleted' | 'active' | 'duplicates' | 'promos'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [cleanLog, setCleanLog] = useState<string[]>([]);
  const [isCleaning, setIsCleaning] = useState(false);

  // Initial stats fetch
  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    try {
      const res = await fetch('/api/video-health/dashboard-stats');
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.stats) {
          setStats(prev => ({
            ...prev,
            activeCount: json.stats.activeCount || 0,
            brokenCount: json.stats.brokenCount || 0,
            privateCount: json.stats.privateCount || 0,
            deletedCount: json.stats.deletedCount || 0,
            unavailableCount: json.stats.unavailableCount || 0,
            lastScanTime: json.stats.lastScanTime || 0
          }));
        }
      }
    } catch (e) {
      console.warn("Failed to fetch dashboard stats from API:", e);
    }
    // Also load local scan items if cached
    try {
      const local = localStorage.getItem('anova_video_health_items');
      if (local) {
        const parsed: VideoHealthItem[] = JSON.parse(local);
        setHealthItems(parsed);
        updateStatsFromItems(parsed);
      }
    } catch (_) {}
  };

  const updateStatsFromItems = (items: VideoHealthItem[]) => {
    let active = 0, broken = 0, priv = 0, del = 0, unavail = 0, dups = 0, promos = 0;
    items.forEach(item => {
      if (item.isDuplicate) dups++;
      if (item.status === 'short' || isPromotionalOrShortClip(item.title, item.durationSeconds)) promos++;
      if (item.status === 'active') active++;
      else if (item.status === 'broken') broken++;
      else if (item.status === 'private') priv++;
      else if (item.status === 'deleted') del++;
      else if (item.status === 'unavailable') unavail++;
    });

    setStats(prev => ({
      ...prev,
      totalVideos: items.length,
      activeCount: active,
      brokenCount: broken,
      privateCount: priv,
      deletedCount: del,
      unavailableCount: unavail,
      duplicateCount: dups,
      promosCount: promos,
      lastScanTime: Date.now()
    }));
  };

  // Run Batch Video Check across all database custom episodes
  const handleScanAllVideos = async (onlyBroken = false) => {
    setIsScanning(true);
    setScanProgress({ current: 0, total: 0, currentTitle: 'Gathering episodes...', statusText: 'Initializing database scan' });

    try {
      const customAnimes = await getCustomAnimes();
      const animeList = Object.values(customAnimes || {}).filter(Boolean);

      const itemsToScan: VideoHealthItem[] = [];
      const seenVideoIds = new Map<string, VideoHealthItem>();

      for (let i = 0; i < animeList.length; i++) {
        const anime: any = animeList[i];
        setScanProgress({
          current: i + 1,
          total: animeList.length,
          currentTitle: anime.title || 'Anime',
          statusText: `Loading episodes for ${anime.title || 'Anime'}`
        });

        try {
          const episodesMap = await getCustomEpisodes(String(anime.id));
          const epArray = Object.values(episodesMap || {}).filter(Boolean);

          epArray.forEach((ep: any) => {
            const sources = ep.videoSources || {};
            const langs = ['sub', 'eng_dub', 'hindi_dub', 'other'];

            langs.forEach(lang => {
              const src = sources[lang];
              if (src && src.enabled && src.url) {
                const ytId = getYoutubeId(src.url);
                if (ytId) {
                  const existingItem = seenVideoIds.get(`${anime.id}_${ep.episodeNumber}_${lang}`);
                  const isDup = seenVideoIds.has(`yt_${ytId}`);

                  const newItem: VideoHealthItem = {
                    id: `${anime.id}_${ep.episodeNumber}_${lang}_${ytId}`,
                    animeId: String(anime.id),
                    animeTitle: anime.title || 'Unknown Anime',
                    episodeNumber: ep.episodeNumber || 1,
                    language: lang,
                    videoId: ytId,
                    url: src.url,
                    status: ep.status || 'checking',
                    isDuplicate: isDup,
                    checkedAt: ep.checkedAt || 0
                  };

                  seenVideoIds.set(`yt_${ytId}`, newItem);

                  if (!onlyBroken || (ep.status && ep.status !== 'active')) {
                    itemsToScan.push(newItem);
                  }
                }
              }
            });
          });
        } catch (e) {
          console.error(`Failed to load episodes for anime ${anime.id}:`, e);
        }
      }

      setScanProgress({
        current: 0,
        total: itemsToScan.length,
        currentTitle: 'Verifying YouTube links in batches...',
        statusText: `Checking ${itemsToScan.length} YouTube videos`
      });

      // Batch verify via Server API
      const batchSize = 30;
      const verifiedItems: VideoHealthItem[] = [...itemsToScan];

      for (let j = 0; j < itemsToScan.length; j += batchSize) {
        const chunk = itemsToScan.slice(j, j + batchSize);
        const chunkIds = chunk.map(c => c.videoId);

        setScanProgress({
          current: Math.min(j + batchSize, itemsToScan.length),
          total: itemsToScan.length,
          currentTitle: `Verifying batch ${Math.floor(j / batchSize) + 1} of ${Math.ceil(itemsToScan.length / batchSize)}`,
          statusText: `Checking IDs: ${chunkIds.slice(0, 3).join(', ')}...`
        });

        try {
          const res = await fetch('/api/video-health/check-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoIds: chunkIds })
          });

          if (res.ok) {
            const data = await res.json();
            if (data.success && data.results) {
              chunk.forEach(item => {
                const resObj = data.results[item.videoId];
                if (resObj) {
                  item.status = resObj.status;
                  item.reason = resObj.reason;
                  item.title = resObj.title;
                  item.durationSeconds = resObj.durationSeconds;
                  item.checkedAt = resObj.checkedAt || Date.now();
                }
              });
            }
          }
        } catch (e) {
          console.warn(`Batch check failed for chunk starting at index ${j}:`, e);
        }
      }

      setHealthItems(verifiedItems);
      updateStatsFromItems(verifiedItems);

      try {
        localStorage.setItem('anova_video_health_items', JSON.stringify(verifiedItems.slice(0, 500)));
      } catch (_) {}

    } catch (e: any) {
      alert(`Error during video scan: ${e.message || 'Scan failed'}`);
    } finally {
      setIsScanning(false);
    }
  };

  // Auto clean duplicates, promo clips & broken episodes + clean dead anime (0 working episodes)
  const handleAutoCleanDuplicatesAndBroken = async () => {
    if (!confirm("Are you sure you want to run Auto Clean?\n\n✔ Good/Working videos and anime will be strictly PROTECTED.\n✔ Broken/Deleted video links will be removed.\n✔ Promotional clips / short trailers (< 90s) mixed into episodes will be removed.\n✔ Animes with 0 working episodes will be hidden/removed from the Homepage.")) {
      return;
    }

    setIsCleaning(true);
    const logs: string[] = [];
    logs.push("Starting Comprehensive Auto Clean procedure...");

    try {
      const customAnimes = await getCustomAnimes();
      const animeList = Object.values(customAnimes || {}).filter(Boolean);

      let totalDuplicatesRemoved = 0;
      let totalBrokenHidden = 0;
      let totalPromosRemoved = 0;
      let totalDeadAnimeHandled = 0;

      // Build health status map from current scan if available
      const healthMap = new Map<string, VideoHealthItem>();
      healthItems.forEach(item => healthMap.set(item.videoId, item));

      for (let i = 0; i < animeList.length; i++) {
        const anime: any = animeList[i];
        const animeId = String(anime.id);
        const epMap = await getCustomEpisodes(animeId);

        if (!epMap || Object.keys(epMap).length === 0) {
          // Anime has 0 episode entries in database -> Hide from homepage
          if (anime.visibility !== 'draft') {
            anime.visibility = 'draft';
            await addCustomAnime(animeId, anime);
            totalDeadAnimeHandled++;
            logs.push(`[DEAD ANIME HIDDEN] '${anime.title}' hidden from homepage (No episodes present)`);
          }
          continue;
        }

        const cleanMap: Record<number, any> = {};
        const seenVideoIds = new Set<string>();
        let workingEpisodesCount = 0;

        Object.keys(epMap).forEach(epNumStr => {
          const epNum = Number(epNumStr);
          const ep = epMap[epNum];
          if (!ep) return;

          // Skip explicitly broken/deleted episodes
          if (ep.status === 'broken' || ep.status === 'deleted' || ep.status === 'private') {
            totalBrokenHidden++;
            logs.push(`Hidden broken episode #${epNum} in '${anime.title}'`);
            return;
          }

          const sources = ep.videoSources || {};
          let validSourcesCount = 0;

          ['sub', 'eng_dub', 'hindi_dub', 'other'].forEach(lang => {
            const src = sources[lang];
            if (src && src.enabled && src.url) {
              const ytId = getYoutubeId(src.url);
              const scannedItem = ytId ? healthMap.get(ytId) : null;

              // Check 1: Is video broken/deleted/private?
              if (scannedItem && (scannedItem.status === 'broken' || scannedItem.status === 'deleted' || scannedItem.status === 'private')) {
                sources[lang].enabled = false;
                totalBrokenHidden++;
                logs.push(`Disabled broken video link (${ytId}) in '${anime.title}' Ep ${epNum}`);
                return;
              }

              // Check 2: Is it a duplicate?
              if (ytId && seenVideoIds.has(ytId)) {
                sources[lang].enabled = false;
                totalDuplicatesRemoved++;
                logs.push(`Removed duplicate video ID ${ytId} in '${anime.title}' Ep ${epNum}`);
                return;
              }

              // Check 3: Is it a promotional video / short clip / trailer?
              if (scannedItem && isPromotionalOrShortClip(scannedItem.title, scannedItem.durationSeconds)) {
                sources[lang].enabled = false;
                totalPromosRemoved++;
                logs.push(`Removed promotional video clip '${scannedItem.title || ytId}' from '${anime.title}' Ep ${epNum}`);
                return;
              }

              // Valid working video source!
              if (ytId) seenVideoIds.add(ytId);
              validSourcesCount++;
            }
          });

          if (validSourcesCount > 0) {
            cleanMap[epNum] = {
              ...ep,
              videoSources: sources
            };
            workingEpisodesCount++;
          }
        });

        // If anime has 0 working episodes remaining, hide/delete from Homepage!
        if (workingEpisodesCount === 0) {
          if (anime.visibility !== 'draft') {
            anime.visibility = 'draft';
            await addCustomAnime(animeId, anime);
            totalDeadAnimeHandled++;
            logs.push(`[DEAD ANIME REMOVED FROM HOMEPAGE] '${anime.title}' hidden (0 working episodes remaining)`);
          }
        } else {
          // Update cleaned episodes batch
          await addCustomEpisodesBatch(animeId, cleanMap);
          // If anime was previously draft, restore visibility so good anime are visible
          if (anime.visibility === 'draft') {
            anime.visibility = 'public';
            await addCustomAnime(animeId, anime);
            logs.push(`[GOOD ANIME PROTECTED & RESTORED] '${anime.title}' verified with ${workingEpisodesCount} working episodes`);
          }
        }
      }

      logs.push(`Auto Clean Complete: Cleared ${totalDuplicatesRemoved} duplicates, ${totalPromosRemoved} promo clips, hid ${totalBrokenHidden} broken links, and removed ${totalDeadAnimeHandled} dead animes from homepage.`);
      setCleanLog(logs);
      
      setStats(prev => ({
        ...prev,
        deadAnimeCount: totalDeadAnimeHandled,
        promosCount: totalPromosRemoved
      }));

      alert(`Auto Clean Successful!\n\n✔ Preserved all working anime & episodes\n✔ Removed ${totalDuplicatesRemoved} duplicate links\n✔ Removed ${totalPromosRemoved} promotional clips/trailers\n✔ Handled ${totalBrokenHidden} broken episode links\n✔ Removed/Hidden ${totalDeadAnimeHandled} dead animes (0 working episodes) from Homepage.`);
      loadDashboardStats();
    } catch (e: any) {
      alert(`Auto Clean failed: ${e.message || 'Clean operation error'}`);
    } finally {
      setIsCleaning(false);
    }
  };

  // Quick single item status toggle
  const handleToggleStatus = (item: VideoHealthItem) => {
    const updated = healthItems.map(h => {
      if (h.id === item.id) {
        const nextStatus = h.status === 'active' ? 'broken' : 'active';
        return { ...h, status: nextStatus, reason: nextStatus === 'active' ? 'Manually restored by Admin' : 'Manually flagged as broken' };
      }
      return h;
    });
    setHealthItems(updated);
    updateStatsFromItems(updated);
  };

  const filteredItems = healthItems.filter(item => {
    if (filterStatus === 'broken' && item.status !== 'broken') return false;
    if (filterStatus === 'private' && item.status !== 'private') return false;
    if (filterStatus === 'deleted' && item.status !== 'deleted') return false;
    if (filterStatus === 'active' && item.status !== 'active') return false;
    if (filterStatus === 'duplicates' && !item.isDuplicate) return false;
    if (filterStatus === 'promos' && !isPromotionalOrShortClip(item.title, item.durationSeconds) && item.status !== 'short') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        item.animeTitle.toLowerCase().includes(q) ||
        item.videoId.toLowerCase().includes(q) ||
        (item.title || '').toLowerCase().includes(q) ||
        String(item.episodeNumber).includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6 animate-fadeIn text-gray-300">
      {/* Header & Overview */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 bg-[#0a0d14]/60 border border-white/5 p-6 rounded-2xl backdrop-blur-md">
        <div>
          <h2 className="text-xl font-black text-white uppercase tracking-wider flex items-center gap-2">
            <Activity className="text-primary" size={22} />
            YouTube Video Health Monitor & Auto Clean
          </h2>
          <p className="text-xs text-gray-400 mt-1">
            Automated health scanner, dead link detector, and duplicate episode cleanup system.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => handleScanAllVideos(false)}
            disabled={isScanning}
            className="bg-primary hover:bg-primary/90 text-black px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-primary/20 disabled:opacity-50"
          >
            {isScanning ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                Scanning Videos...
              </>
            ) : (
              <>
                <Search size={14} />
                Check All Videos
              </>
            )}
          </button>

          <button
            onClick={handleAutoCleanDuplicatesAndBroken}
            disabled={isCleaning}
            className="bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
          >
            {isCleaning ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                Cleaning Database...
              </>
            ) : (
              <>
                <Sparkles size={14} className="text-purple-400" />
                Auto Clean Duplicates
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress Bar during Scanning */}
      {isScanning && (
        <div className="bg-[#0a0d14] border border-primary/30 p-5 rounded-2xl animate-pulse space-y-3">
          <div className="flex items-center justify-between text-xs font-black uppercase tracking-wider">
            <span className="text-primary flex items-center gap-2">
              <RefreshCw size={14} className="animate-spin" />
              {scanProgress.statusText}
            </span>
            <span className="text-white">
              {scanProgress.total > 0 ? `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` : '0%'}
            </span>
          </div>

          <div className="w-full bg-white/5 h-2.5 rounded-full overflow-hidden">
            <div 
              className="bg-gradient-to-r from-primary to-purple-500 h-full transition-all duration-300"
              style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
            />
          </div>

          <div className="text-[10px] text-gray-400 truncate font-mono">
            Scanning: <span className="text-white font-bold">{scanProgress.currentTitle}</span>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
        <div className="bg-[#0a0d14]/40 border border-white/5 p-4 rounded-xl text-center">
          <span className="text-[9px] text-gray-400 font-black uppercase tracking-wider block">Checked Videos</span>
          <p className="text-xl font-black text-white mt-1">{stats.totalVideos}</p>
        </div>

        <div className="bg-emerald-500/5 border border-emerald-500/10 p-4 rounded-xl text-center">
          <span className="text-[9px] text-emerald-400 font-black uppercase tracking-wider block">Active / Playable</span>
          <p className="text-xl font-black text-emerald-400 mt-1">{stats.activeCount}</p>
        </div>

        <div className="bg-amber-500/5 border border-amber-500/10 p-4 rounded-xl text-center">
          <span className="text-[9px] text-amber-400 font-black uppercase tracking-wider block">Broken Videos</span>
          <p className="text-xl font-black text-amber-400 mt-1">{stats.brokenCount}</p>
        </div>

        <div className="bg-rose-500/5 border border-rose-500/10 p-4 rounded-xl text-center">
          <span className="text-[9px] text-rose-400 font-black uppercase tracking-wider block">Deleted Videos</span>
          <p className="text-xl font-black text-rose-400 mt-1">{stats.deletedCount}</p>
        </div>

        <div className="bg-blue-500/5 border border-blue-500/10 p-4 rounded-xl text-center">
          <span className="text-[9px] text-blue-400 font-black uppercase tracking-wider block">Private Videos</span>
          <p className="text-xl font-black text-blue-400 mt-1">{stats.privateCount}</p>
        </div>

        <div className="bg-purple-500/5 border border-purple-500/10 p-4 rounded-xl text-center">
          <span className="text-[9px] text-purple-400 font-black uppercase tracking-wider block">Duplicates</span>
          <p className="text-xl font-black text-purple-400 mt-1">{stats.duplicateCount}</p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-[#0a0d14]/40 border border-white/5 p-4 rounded-xl">
        <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto hide-scrollbar">
          {[
            { id: 'all', label: `All (${healthItems.length})` },
            { id: 'active', label: `Active (${stats.activeCount})` },
            { id: 'broken', label: `Broken (${stats.brokenCount})` },
            { id: 'deleted', label: `Deleted (${stats.deletedCount})` },
            { id: 'private', label: `Private (${stats.privateCount})` },
            { id: 'duplicates', label: `Duplicates (${stats.duplicateCount})` },
            { id: 'promos', label: `Promo Clips (${stats.promosCount})` }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setFilterStatus(tab.id as any)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer whitespace-nowrap",
                filterStatus === tab.id
                  ? "bg-primary text-black font-bold"
                  : "bg-white/5 text-gray-400 hover:text-white"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64 shrink-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search anime, video ID..."
            className="w-full bg-black/40 border border-white/10 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Health Table */}
      <div className="bg-[#0a0d14]/60 border border-white/5 rounded-2xl overflow-hidden backdrop-blur-md">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-gray-300">
            <thead className="bg-white/[0.02] border-b border-white/5 text-[10px] font-black uppercase tracking-wider text-gray-400">
              <tr>
                <th className="py-3.5 px-4">Anime Title</th>
                <th className="py-3.5 px-4">Episode</th>
                <th className="py-3.5 px-4">Language</th>
                <th className="py-3.5 px-4">YouTube Video ID</th>
                <th className="py-3.5 px-4">Health Status</th>
                <th className="py-3.5 px-4">Details / Reason</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-gray-500 text-xs uppercase font-bold">
                    {healthItems.length === 0 ? 'No video health scan performed yet. Click "Check All Videos" to scan.' : 'No matching videos found for this filter.'}
                  </td>
                </tr>
              ) : (
                filteredItems.slice(0, 100).map(item => (
                  <tr key={item.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="py-3 px-4 font-bold text-white max-w-[180px] truncate">
                      {item.animeTitle}
                    </td>
                    <td className="py-3 px-4 font-black text-primary">
                      Ep #{item.episodeNumber}
                    </td>
                    <td className="py-3 px-4 uppercase text-[10px] font-bold text-gray-400">
                      {item.language}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px]">
                      <a 
                        href={`https://www.youtube.com/watch?v=${item.videoId}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-gray-300 hover:text-primary flex items-center gap-1 inline-flex"
                      >
                        {item.videoId}
                        <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="py-3 px-4">
                      {item.status === 'active' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 size={10} />
                          Active
                        </span>
                      )}
                      {item.status === 'broken' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <AlertTriangle size={10} />
                          Broken
                        </span>
                      )}
                      {item.status === 'deleted' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase bg-rose-500/10 text-rose-400 border border-rose-500/20">
                          <XCircle size={10} />
                          Deleted
                        </span>
                      )}
                      {item.status === 'private' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-black uppercase bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          <EyeOff size={10} />
                          Private
                        </span>
                      )}
                      {item.isDuplicate && (
                        <span className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-black uppercase bg-purple-500/20 text-purple-300">
                          Duplicate
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-gray-400 text-[11px] max-w-[200px] truncate">
                      {item.reason || item.title || 'Verified'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => handleToggleStatus(item)}
                        className="text-[10px] font-black uppercase px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-white transition-all cursor-pointer"
                      >
                        {item.status === 'active' ? 'Mark Broken' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Auto Clean Logs */}
      {cleanLog.length > 0 && (
        <div className="bg-[#0a0d14] border border-white/10 p-4 rounded-xl space-y-2">
          <h4 className="text-xs font-black text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles size={14} />
            Auto Clean Activity Logs
          </h4>
          <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-gray-400 space-y-1 bg-black/40 p-3 rounded-lg border border-white/5">
            {cleanLog.map((log, idx) => (
              <div key={idx} className="truncate">
                • {log}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
