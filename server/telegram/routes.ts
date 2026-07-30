import { Router, Request, Response } from 'express';
import { 
  getTelegramConfig, 
  updateTelegramConfig, 
  testBotConnection, 
  sendTelegramPost, 
  queueTelegramPost, 
  getTelegramLogs, 
  logTelegramEvent,
  deleteTelegramWebhook,
  setTelegramWebhook,
  PublishPayload 
} from './telegramService';
import { handleBotCommand } from './botCommands';

export const telegramRouter = Router();

/**
 * GET /api/telegram/status
 * Get current bot status, username, and config summary
 */
telegramRouter.get('/status', async (req: Request, res: Response) => {
  try {
    const config = await getTelegramConfig();
    const connection = await testBotConnection(config.botToken);

    // Mask bot token safely for display
    const rawToken = config.botToken || '';
    const maskedToken = rawToken.length > 10 
      ? `${rawToken.substring(0, 6)}****${rawToken.substring(rawToken.length - 4)}` 
      : 'Not set';

    return res.json({
      success: true,
      enabled: config.enabled,
      isConfigured: !!(config.botToken && config.channelId),
      channelId: config.channelId,
      maskedToken: maskedToken,
      hasToken: !!config.botToken,
      botInfo: connection.botInfo || null,
      connectionOk: connection.success,
      error: connection.error || null
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/config
 * Save or update Bot Token, Channel ID, and Enabled state
 */
telegramRouter.post('/config', async (req: Request, res: Response) => {
  try {
    const { botToken, channelId, enabled } = req.body;

    // Validate token if provided
    if (botToken) {
      const test = await testBotConnection(botToken);
      if (!test.success) {
        return res.status(400).json({
          success: false,
          error: `Invalid Telegram Bot Token: ${test.error}`
        });
      }
    }

    const updated = await updateTelegramConfig({
      botToken,
      channelId,
      enabled
    });

    const connection = await testBotConnection(updated.botToken);

    return res.json({
      success: true,
      message: 'Telegram settings updated successfully.',
      config: {
        enabled: updated.enabled,
        channelId: updated.channelId,
        hasToken: !!updated.botToken
      },
      botInfo: connection.botInfo || null,
      connectionOk: connection.success
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/test-connection
 * Test Telegram API connection
 */
telegramRouter.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const { botToken } = req.body;
    const result = await testBotConnection(botToken);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/test-message
 * Send a test broadcast message to the configured channel
 */
telegramRouter.post('/test-message', async (req: Request, res: Response) => {
  try {
    const testPayload: PublishPayload = {
      type: 'announcement',
      title: 'Anova Anime Network Telegram Test',
      subOrDub: 'Sub/Dub',
      rating: '10/10',
      genres: ['Action', 'System', 'Anime'],
      releaseDate: new Date().toISOString().split('T')[0],
      description: 'This is a test notification verifying the Telegram integration for Anova Anime Network. System connected successfully!',
      watchUrl: `${(process.env.APP_URL || 'https://ai.studio').replace(/\/$/, '')}/home`
    };

    const result = await sendTelegramPost(testPayload);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/telegram/logs
 * Retrieve Telegram operation logs
 */
telegramRouter.get('/logs', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = await getTelegramLogs(limit);
    return res.json({ success: true, logs });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/publish
 * Trigger asynchronous Telegram post for anime, episode, movie, announcement, or news
 * Non-blocking: returns 200 immediately
 */
telegramRouter.post('/publish', (req: Request, res: Response) => {
  try {
    const payload: PublishPayload = req.body;

    if (!payload || !payload.title) {
      return res.status(400).json({ success: false, error: 'Title is required for Telegram publishing.' });
    }

    // Queue post asynchronously so admin response is never blocked
    queueTelegramPost(payload);

    return res.json({
      success: true,
      message: 'Telegram publication queued successfully.',
      title: payload.title,
      type: payload.type || 'anime'
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/webhook & POST /api/telegram/command
 * Process bot webhooks or manual command invocation
 */
telegramRouter.post('/webhook', async (req: Request, res: Response) => {
  try {
    const update = req.body;
    const message = update?.message || update?.edited_message;

    if (message && message.text) {
      const commandText = message.text;
      const chatId = message.chat?.id;

      if (commandText.startsWith('/')) {
        const responseObj = await handleBotCommand(commandText);
        
        // If webhook came from Telegram chat, send message back
        if (chatId) {
          const config = await getTelegramConfig();
          if (config.botToken) {
            await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: responseObj.text,
                parse_mode: responseObj.parse_mode,
                reply_markup: responseObj.reply_markup
              })
            }).catch(() => {});
          }
        }
      }
    }

    return res.json({ ok: true });
  } catch (err: any) {
    return res.json({ ok: true }); // Always return 200 to Telegram Webhook
  }
});

/**
 * POST /api/telegram/delete-webhook
 * Remove Telegram Webhook to allow Long Polling
 */
telegramRouter.post('/delete-webhook', async (req: Request, res: Response) => {
  try {
    const result = await deleteTelegramWebhook();
    return res.json({ success: result.success, message: result.description });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/set-webhook
 * Register a Telegram Webhook URL
 */
telegramRouter.post('/set-webhook', async (req: Request, res: Response) => {
  try {
    const appUrl = (process.env.APP_URL || 'https://ai.studio').replace(/\/$/, '');
    const webhookUrl = `${appUrl}/api/telegram/webhook`;
    const result = await setTelegramWebhook(webhookUrl);
    return res.json({ success: result.success, message: result.description, url: webhookUrl });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/telegram/command
 * Direct command API execution for testing command output
 */
telegramRouter.post('/command', async (req: Request, res: Response) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ success: false, error: 'Command string is required.' });
    }

    const output = await handleBotCommand(command);
    return res.json({ success: true, result: output });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
