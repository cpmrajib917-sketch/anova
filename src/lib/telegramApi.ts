export interface TelegramPublishPayload {
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

export async function getTelegramStatus() {
  try {
    const res = await fetch('/api/telegram/status');
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function updateTelegramConfig(config: { botToken?: string; channelId?: string; enabled?: boolean }) {
  try {
    const res = await fetch('/api/telegram/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function testTelegramConnection(botToken?: string) {
  try {
    const res = await fetch('/api/telegram/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken })
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendTestTelegramMessage() {
  try {
    const res = await fetch('/api/telegram/test-message', {
      method: 'POST'
    });
    return await res.json();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getTelegramLogs() {
  try {
    const res = await fetch('/api/telegram/logs');
    return await res.json();
  } catch (err: any) {
    return { success: false, logs: [] };
  }
}

/**
 * Non-blocking publish call to Telegram backend
 */
export async function publishToTelegram(payload: TelegramPublishPayload) {
  try {
    const res = await fetch('/api/telegram/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err: any) {
    console.warn('[Telegram Client] Non-blocking publish failed:', err.message);
    return { success: false, error: err.message };
  }
}
