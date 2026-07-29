// Force latest Railway build
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

import express, { Request, Response, Router } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';

console.log("SERVER START");

try {
  if (!admin.apps.length) {
    admin.initializeApp();
    console.log("Firebase Admin SDK initialized successfully");
  }
} catch (error) {
  console.error("Firebase Admin initialization error:", error);
}

const app = express();

// CORS origin configuration
const allowedOrigins: string[] = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://service-846179397596.us-west1.run.app'
];

app.use(cors({
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.run.app') || origin.endsWith('.railway.app')) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

// 1. Existing health check endpoint (GET /) - MUST NOT BE DELETED
app.get('/', (req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "byeolmuri-discord-auth"
  });
});

// 2. Express Router for Discord OAuth
const authRouter = Router();

// GET /auth/discord -> Redirect to Discord OAuth2 Authorization URL
authRouter.get('/discord', (req: Request, res: Response) => {
  try {
    const clientId = process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || '1528735887125385346';
    const redirectUri = process.env.DISCORD_REDIRECT_URI || 'https://byeolmuri-discord-auth-production.up.railway.app/auth/discord/callback';

    // Generate random state
    const state = crypto.randomBytes(16).toString('hex');

    // Store state in HttpOnly, SameSite=Lax cookie
    res.cookie('discord_oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000, // 10 minutes
    });

    const authorizeUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri
    )}&response_type=code&scope=identify&state=${state}`;

    res.redirect(authorizeUrl);
  } catch (error: any) {
    console.error('Error in GET /auth/discord:', error);
    res.status(500).json({ error: error?.message || 'Failed to initiate Discord OAuth' });
  }
});

// GET /auth/discord/callback -> Handle Discord OAuth2 callback
authRouter.get('/discord/callback', async (req: Request, res: Response): Promise<void> => {
  try {
    const { code, state } = req.query;
    const savedState = req.cookies?.discord_oauth_state;

    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'Missing authorization code parameter' });
      return;
    }

    // Validate state parameter against cookie
    if (!state || typeof state !== 'string' || !savedState || state !== savedState) {
      res.status(403).json({ error: 'Invalid state parameter' });
      return;
    }

    // Clear state cookie
    res.clearCookie('discord_oauth_state');

    const clientId = process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || '1528735887125385346';
    const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
    const redirectUri = process.env.DISCORD_REDIRECT_URI || 'https://byeolmuri-discord-auth-production.up.railway.app/auth/discord/callback';

    if (!clientSecret) {
      res.status(400).json({ error: 'DISCORD_CLIENT_SECRET is missing in environment variables' });
      return;
    }

    // Exchange authorization code for Discord access token
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => '');
      console.error(`Discord token exchange failed (HTTP ${tokenResponse.status}): ${errorText}`);
      res.status(400).json({ error: `Discord token exchange failed: ${errorText}` });
      return;
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };

    // Fetch Discord user profile
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        Authorization: `${tokenData.token_type} ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      const userErrText = await userResponse.text().catch(() => '');
      console.error(`Discord user profile fetch failed (HTTP ${userResponse.status}): ${userErrText}`);
      res.status(500).json({ error: `Discord user fetch failed: ${userErrText}` });
      return;
    }

    const discordUser = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name: string | null;
      avatar: string | null;
      email?: string;
    };

    if (!discordUser.id) {
      res.status(500).json({ error: 'Failed to retrieve valid Discord user ID' });
      return;
    }

    // Determine avatar URL
    let avatarURL = '';
    if (discordUser.avatar) {
      avatarURL = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`;
    } else {
      const defaultAvatarIndex = parseInt(discordUser.id) ? (parseInt(discordUser.id) % 5) : 0;
      avatarURL = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
    }

    // Return required JSON response
    res.json({
      success: true,
      discordId: discordUser.id,
      username: discordUser.username,
      avatar: avatarURL,
    });
  } catch (error: any) {
    console.error('Error in GET /auth/discord/callback:', error);
    res.status(500).json({ error: error?.message || 'Internal server error during Discord OAuth callback' });
  }
});

// Mount the router on /auth and /api/auth
app.use('/auth', authRouter);
app.use('/api/auth', authRouter);

// Port binding
const port: number = Number(process.env.PORT) || 3000;

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port} (0.0.0.0:${port})`);
});
