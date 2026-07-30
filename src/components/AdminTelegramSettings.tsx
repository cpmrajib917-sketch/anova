import React, { useState, useEffect } from 'react';
import { 
  Send, 
  Bot, 
  CheckCircle2, 
  XCircle, 
  RefreshCw, 
  AlertTriangle, 
  Key, 
  Radio, 
  FileText, 
  Clock, 
  ShieldCheck, 
  Sparkles, 
  Link, 
  ExternalLink,
  MessageSquare,
  Search,
  Eye,
  EyeOff
} from 'lucide-react';
import { 
  getTelegramStatus, 
  updateTelegramConfig, 
  testTelegramConnection, 
  sendTestTelegramMessage, 
  getTelegramLogs, 
  publishToTelegram,
  TelegramPublishPayload 
} from '../lib/telegramApi';

export function AdminTelegramSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [publishing, setPublishing] = useState(false);
  
  // Status & Configuration
  const [status, setStatus] = useState<any>(null);
  const [botTokenInput, setBotTokenInput] = useState('');
  const [channelIdInput, setChannelIdInput] = useState('');
  const [enabledInput, setEnabledInput] = useState(true);
  const [showToken, setShowToken] = useState(false);

  // Feedback messages
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Logs
  const [logs, setLogs] = useState<any[]>([]);
  const [logFilter, setLogFilter] = useState('');
  const [refreshingLogs, setRefreshingLogs] = useState(false);

  // Manual Broadcast Form
  const [broadcastForm, setBroadcastForm] = useState<TelegramPublishPayload>({
    type: 'announcement',
    title: '',
    subOrDub: 'Sub/Dub',
    rating: '9.0/10',
    genres: 'Action, Fantasy, Adventure',
    description: '',
    poster: '',
    banner: ''
  });

  const showToast = (type: 'success' | 'error' | 'info', text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 4000);
  };

  const loadStatusAndLogs = async () => {
    setLoading(true);
    const [statusRes, logsRes] = await Promise.all([
      getTelegramStatus(),
      getTelegramLogs()
    ]);

    if (statusRes && statusRes.success) {
      setStatus(statusRes);
      setEnabledInput(statusRes.enabled);
      setChannelIdInput(statusRes.channelId || '');
    }
    if (logsRes && logsRes.logs) {
      setLogs(logsRes.logs);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStatusAndLogs();
  }, []);

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    
    const payload: any = {
      channelId: channelIdInput,
      enabled: enabledInput
    };

    if (botTokenInput.trim()) {
      payload.botToken = botTokenInput.trim();
    }

    const res = await updateTelegramConfig(payload);
    setSaving(false);

    if (res && res.success) {
      showToast('success', 'Telegram configuration saved & validated successfully!');
      setBotTokenInput(''); // Clear input for security
      loadStatusAndLogs();
    } else {
      showToast('error', res.error || 'Failed to update configuration.');
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    const res = await testTelegramConnection(botTokenInput.trim() || undefined);
    setTesting(false);

    if (res && res.success) {
      showToast('success', `Connected! Bot Name: ${res.botInfo?.first_name} (@${res.botInfo?.username})`);
    } else {
      showToast('error', res.error || 'Connection test failed.');
    }
  };

  const handleSendTestMessage = async () => {
    setSendingTest(true);
    const res = await sendTestTelegramMessage();
    setSendingTest(false);

    if (res && res.success) {
      showToast('success', `Test message posted successfully! Message ID: ${res.messageId}`);
      loadLogs();
    } else {
      showToast('error', res.error || 'Failed to send test message.');
    }
  };

  const loadLogs = async () => {
    setRefreshingLogs(true);
    const logsRes = await getTelegramLogs();
    if (logsRes && logsRes.logs) {
      setLogs(logsRes.logs);
    }
    setRefreshingLogs(false);
  };

  const handleBroadcastSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastForm.title.trim()) {
      showToast('error', 'Title is required for broadcast.');
      return;
    }

    setPublishing(true);
    const res = await publishToTelegram(broadcastForm);
    setPublishing(false);

    if (res && res.success) {
      showToast('success', `Broadcast for "${broadcastForm.title}" queued successfully!`);
      setBroadcastForm({
        type: 'announcement',
        title: '',
        subOrDub: 'Sub/Dub',
        rating: '9.0/10',
        genres: 'Action, Fantasy, Adventure',
        description: '',
        poster: '',
        banner: ''
      });
      setTimeout(loadLogs, 1500);
    } else {
      showToast('error', res.error || 'Failed to queue broadcast.');
    }
  };

  const filteredLogs = logs.filter(log => {
    if (!logFilter) return true;
    const q = logFilter.toLowerCase();
    return (
      (log.title && log.title.toLowerCase().includes(q)) ||
      (log.type && log.type.toLowerCase().includes(q)) ||
      (log.error && log.error.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-8 animate-fadeIn text-gray-200">
      
      {/* Toast Alert */}
      {toast && (
        <div className={`p-4 rounded-xl border flex items-center justify-between text-xs sm:text-sm font-semibold shadow-xl transition-all ${
          toast.type === 'success' 
            ? 'bg-emerald-950/80 border-emerald-500/40 text-emerald-300' 
            : toast.type === 'error'
            ? 'bg-rose-950/80 border-rose-500/40 text-rose-300'
            : 'bg-cyan-950/80 border-cyan-500/40 text-cyan-300'
        }`}>
          <div className="flex items-center gap-2">
            {toast.type === 'success' && <CheckCircle2 size={18} className="text-emerald-400" />}
            {toast.type === 'error' && <XCircle size={18} className="text-rose-400" />}
            {toast.type === 'info' && <Radio size={18} className="text-cyan-400 animate-pulse" />}
            <span>{toast.text}</span>
          </div>
          <button onClick={() => setToast(null)} className="text-slate-400 hover:text-white ml-4">✕</button>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0a0d14]/60 border border-slate-800 p-6 rounded-2xl backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />
        
        <div>
          <h2 className="text-xl font-black text-white uppercase tracking-wider flex items-center gap-2.5">
            <Send className="text-cyan-400 animate-bounce" size={24} />
            <span>Telegram Integration Hub</span>
          </h2>
          <p className="text-xs text-gray-400 mt-1 max-w-2xl leading-relaxed">
            Automatically publish new anime, episodes, movies, news, and announcements to your official Telegram Channel with interactive buttons, posters, and real-time logs.
          </p>
        </div>

        {/* Live Status Pill */}
        <div className="flex items-center gap-3">
          <div className={`px-4 py-2 rounded-xl border flex items-center gap-2 text-xs font-bold uppercase tracking-wider ${
            status?.connectionOk && status?.enabled
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : !status?.enabled
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              status?.connectionOk && status?.enabled ? 'bg-emerald-400 animate-ping' : 'bg-rose-400'
            }`} />
            <span>
              {status?.connectionOk && status?.enabled 
                ? 'Active & Syncing' 
                : !status?.enabled 
                ? 'Integration Disabled' 
                : 'Connection Offline'}
            </span>
          </div>

          <button
            onClick={loadStatusAndLogs}
            disabled={loading}
            className="p-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-xl transition-all cursor-pointer"
            title="Refresh Bot Status"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Grid: Bot Status & Settings Form */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Card 1: Bot Live Status & Test Controls */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-xl">
          <div>
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
              <div className="flex items-center gap-2 text-sm font-bold text-white uppercase tracking-wider">
                <Bot className="text-cyan-400" size={18} />
                <span>Bot Info & Status</span>
              </div>
              <span className="text-[10px] bg-cyan-950 text-cyan-300 px-2 py-0.5 rounded border border-cyan-800">
                v1.0 API
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex justify-between items-center py-1.5 border-b border-slate-800/40">
                <span className="text-slate-400 font-semibold">Bot Username:</span>
                <span className="font-mono text-cyan-300 font-bold">
                  {status?.botInfo?.username ? `@${status.botInfo.username}` : 'Not connected'}
                </span>
              </div>

              <div className="flex justify-between items-center py-1.5 border-b border-slate-800/40">
                <span className="text-slate-400 font-semibold">Bot Display Name:</span>
                <span className="text-white font-medium">
                  {status?.botInfo?.first_name || '—'}
                </span>
              </div>

              <div className="flex justify-between items-center py-1.5 border-b border-slate-800/40">
                <span className="text-slate-400 font-semibold">Target Channel:</span>
                <span className="font-mono text-emerald-400 font-bold">
                  {status?.channelId || 'Not set'}
                </span>
              </div>

              <div className="flex justify-between items-center py-1.5 border-b border-slate-800/40">
                <span className="text-slate-400 font-semibold">Bot Token Status:</span>
                <span className="font-mono text-slate-300">
                  {status?.maskedToken || 'Missing'}
                </span>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-800/60 mt-6 space-y-2.5">
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-98"
            >
              <Radio size={14} className={testing ? 'animate-spin text-cyan-400' : 'text-cyan-400'} />
              <span>{testing ? 'Testing Connection...' : 'Test Bot API Connection'}</span>
            </button>

            <button
              onClick={handleSendTestMessage}
              disabled={sendingTest || !status?.connectionOk}
              className="w-full py-2.5 px-4 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl font-medium text-xs flex items-center justify-center gap-2 transition-all cursor-pointer active:scale-98 shadow-lg shadow-cyan-600/20 disabled:opacity-50"
            >
              <Send size={14} className={sendingTest ? 'animate-bounce' : ''} />
              <span>{sendingTest ? 'Sending Broadcast...' : 'Send Test Channel Post'}</span>
            </button>
          </div>
        </div>

        {/* Card 2 & 3: Configuration Form */}
        <div className="lg:col-span-2 bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
              <div className="flex items-center gap-2 text-sm font-bold text-white uppercase tracking-wider">
                <Key className="text-cyan-400" size={18} />
                <span>Credentials & Channel Configuration</span>
              </div>
              
              {/* Enable / Disable Toggle */}
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs font-semibold text-slate-400">Auto-Post:</span>
                <input 
                  type="checkbox" 
                  checked={enabledInput} 
                  onChange={(e) => setEnabledInput(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500 relative"></div>
              </label>
            </div>

            <form onSubmit={handleSaveConfig} className="space-y-5">
              
              {/* Bot Token Field */}
              <div>
                <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
                  Telegram Bot Token <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={botTokenInput}
                    onChange={(e) => setBotTokenInput(e.target.value)}
                    placeholder={status?.hasToken ? `(Current token saved: ${status.maskedToken}) — Enter new to change` : 'e.g. 8605704574:AAFQD5cDq4SU4o8...'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                  >
                    {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Obtain your bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">@BotFather</a> on Telegram. Token is safely saved server-side.
                </p>
              </div>

              {/* Target Channel ID Field */}
              <div>
                <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
                  Telegram Channel ID / Username <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={channelIdInput}
                  onChange={(e) => setChannelIdInput(e.target.value)}
                  placeholder="e.g. @anovaanime or -1001234567890"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 transition-colors font-mono"
                  required
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Make sure your Telegram Bot is added as an <strong>Administrator</strong> with permission to post messages to this channel.
                </p>
              </div>

              {/* Safety notice */}
              <div className="p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl flex items-start gap-2.5 text-xs text-slate-400 leading-relaxed">
                <ShieldCheck size={18} className="text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <strong>Asynchronous Safety Guaranteed:</strong> Publishing operations on Anova Anime will never fail or slow down if the Telegram API encounters network latency or rate limits.
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer active:scale-95 shadow-lg shadow-emerald-600/20"
                >
                  <CheckCircle2 size={16} className={saving ? 'animate-spin' : ''} />
                  <span>{saving ? 'Saving Configuration...' : 'Save Configuration'}</span>
                </button>
              </div>

            </form>
          </div>
        </div>

      </div>

      {/* Manual Broadcast / Post Creator */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-5">
        <div className="border-b border-slate-800 pb-4">
          <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <Sparkles className="text-cyan-400" size={18} />
            <span>Manual Broadcast & Announcement Publisher</span>
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Send custom announcements, episode alerts, or news directly to your Telegram channel at any time.
          </p>
        </div>

        <form onSubmit={handleBroadcastSubmit} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          
          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Event Type
            </label>
            <select
              value={broadcastForm.type}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, type: e.target.value as any })}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500"
            >
              <option value="announcement">📢 Announcement</option>
              <option value="news">📰 Anime News</option>
              <option value="episode">📺 New Episode</option>
              <option value="anime">🌟 New Anime</option>
              <option value="movie">🎬 New Movie</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Title <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={broadcastForm.title}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, title: e.target.value })}
              placeholder="e.g. Solo Leveling Season 2 Episode 5 Released!"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Audio Type (Sub/Dub)
            </label>
            <input
              type="text"
              value={broadcastForm.subOrDub}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, subOrDub: e.target.value })}
              placeholder="Sub / Dub / Dual Audio"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Rating
            </label>
            <input
              type="text"
              value={broadcastForm.rating}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, rating: e.target.value })}
              placeholder="8.9/10"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Genres
            </label>
            <input
              type="text"
              value={Array.isArray(broadcastForm.genres) ? broadcastForm.genres.join(', ') : broadcastForm.genres}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, genres: e.target.value })}
              placeholder="Action, Fantasy, Adventure"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Custom Watch Link / URL (Optional)
            </label>
            <input
              type="url"
              value={broadcastForm.watchUrl || ''}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, watchUrl: e.target.value })}
              placeholder="Leave blank for auto-detected link"
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Poster Image URL (Optional)
            </label>
            <input
              type="url"
              value={broadcastForm.poster}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, poster: e.target.value })}
              placeholder="https://..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Banner Image URL (Fallback)
            </label>
            <input
              type="url"
              value={broadcastForm.banner}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, banner: e.target.value })}
              placeholder="https://..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
              Short Description / Message
            </label>
            <textarea
              rows={2}
              value={broadcastForm.description}
              onChange={(e) => setBroadcastForm({ ...broadcastForm, description: e.target.value })}
              placeholder="Enter short summary or announcement text..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="md:col-span-3 flex justify-end">
            <button
              type="submit"
              disabled={publishing || !status?.connectionOk}
              className="px-6 py-2.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl font-bold text-xs uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-cyan-600/20 active:scale-95 disabled:opacity-50"
            >
              <Send size={14} className={publishing ? 'animate-bounce' : ''} />
              <span>{publishing ? 'Dispatching Broadcast...' : 'Post Broadcast to Telegram'}</span>
            </button>
          </div>

        </form>
      </div>

      {/* Telegram Real-Time Operations Logs */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Clock className="text-cyan-400" size={18} />
              <span>Telegram Operations & API Logs</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Live audit trail of broadcast events, message IDs, and API response status.
            </p>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            {/* Search Filter */}
            <div className="relative flex-1 sm:flex-initial">
              <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
              <input
                type="text"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="Search logs..."
                className="w-full sm:w-48 bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white focus:outline-none focus:border-cyan-500"
              />
            </div>

            <button
              onClick={loadLogs}
              disabled={refreshingLogs}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl border border-slate-700 transition-all cursor-pointer"
              title="Refresh Logs"
            >
              <RefreshCw size={14} className={refreshingLogs ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Log Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-800/80 bg-slate-950/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/90 text-slate-400 text-[10px] uppercase font-bold tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Time</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Title / Item</th>
                <th className="py-3 px-4">Message ID</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">API Errors / Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-500 font-sans">
                    No Telegram operation logs found.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-900/40 transition-colors">
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString()} <span className="text-[10px] text-slate-600">{new Date(log.timestamp).toLocaleDateString()}</span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-cyan-300 border border-slate-700">
                        {log.type || 'system'}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-sans font-medium text-white max-w-xs truncate">
                      {log.title}
                    </td>
                    <td className="py-3 px-4 text-slate-400">
                      {log.messageId ? `#${log.messageId}` : '—'}
                    </td>
                    <td className="py-3 px-4">
                      {log.success ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                          <CheckCircle2 size={12} /> Success
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-400 font-bold text-[11px]">
                          <XCircle size={12} /> Failed
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400 max-w-xs truncate text-[11px]">
                      {log.error ? (
                        <span className="text-rose-300">{log.error}</span>
                      ) : log.details?.usedMedia ? (
                        <span className="text-slate-500">Media: {log.details.usedMedia}</span>
                      ) : (
                        <span className="text-slate-600">OK</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

      </div>

    </div>
  );
}
