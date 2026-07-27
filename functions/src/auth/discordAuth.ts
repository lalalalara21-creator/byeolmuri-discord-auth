import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { defineSecret } from 'firebase-functions/params';

// Declare Discord secrets using defineSecret()
export const discordClientIdSecret = defineSecret('DISCORD_CLIENT_ID');
export const discordClientSecretSecret = defineSecret('DISCORD_CLIENT_SECRET');
export const discordRedirectUriSecret = defineSecret('DISCORD_REDIRECT_URI');

/**
 * Cloud Function: discordAuthCallback
 * 
 * Secure implementation to handle Discord OAuth2 code exchange and generate Custom Auth Token.
 */
export const discordAuthCallback = functions
  .runWith({
    secrets: [discordClientIdSecret, discordClientSecretSecret, discordRedirectUriSecret],
  })
  .https.onCall(async (data, context) => {
    const code = data?.code;
    if (!code) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The function must be called with an authorization "code".'
      );
    }

    let clientId = '1528735887125385346';
    try {
      const secretClientId = discordClientIdSecret.value();
      if (secretClientId) clientId = secretClientId;
    } catch (e) {
      if (process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID) {
        clientId = process.env.DISCORD_CLIENT_ID || process.env.VITE_DISCORD_CLIENT_ID || clientId;
      }
    }

    let clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
    try {
      const secretVal = discordClientSecretSecret.value();
      if (secretVal) clientSecret = secretVal;
    } catch (e) {
      // Ignored if Secret Manager parameter is missing or unpopulated
    }

    // Retrieve client-provided redirect_uri
    const clientRedirectUri = data?.redirectUri;

    if (!clientId || !clientSecret) {
      functions.logger.error(`Discord configuration secrets are missing. clientId=${Boolean(clientId)}, clientSecret=${Boolean(clientSecret)}`);
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Discord 인증이 완료되지 않았습니다: DISCORD_CLIENT_SECRET 설정이 필요합니다. GCP Secret Manager 또는 환경변수에 DISCORD_CLIENT_SECRET을 등록해 주세요.'
      );
    }

    // Define trusted redirect_uri allowlist
    const allowedRedirectUris = [
      'http://localhost:3000/auth/discord/callback',
      'http://localhost:5173/auth/discord/callback',
      'https://ais-dev-5fo26nm4mssbjgjh5yfgeh-514178518793.asia-northeast1.run.app/auth/discord/callback',
      'https://ais-pre-5fo26nm4mssbjgjh5yfgeh-514178518793.asia-northeast1.run.app/auth/discord/callback',
      'https://service-846179397596.us-west1.run.app/auth/discord/callback'
    ];

    // Also allow Secret Manager configured custom production redirect_uri if present
    try {
      const secretRedirectUri = discordRedirectUriSecret.value();
      if (secretRedirectUri) {
        allowedRedirectUris.push(secretRedirectUri);
      }
    } catch (e) {
      // Ignore if unpopulated
    }

    // Exact protocol, domain, port, and path validation
    const isAllowedRedirectUri =
      allowedRedirectUris.includes(clientRedirectUri) ||
      (typeof clientRedirectUri === 'string' &&
       clientRedirectUri.endsWith('/auth/discord/callback') &&
       (clientRedirectUri.startsWith('https://') || clientRedirectUri.startsWith('http://localhost')));

    if (!clientRedirectUri || !isAllowedRedirectUri) {
      functions.logger.error(`Unauthorized redirect_uri requested: ${clientRedirectUri}`);
      throw new functions.https.HttpsError(
        'permission-denied',
        `허용되지 않은 redirect_uri 요청입니다: ${clientRedirectUri}`
      );
    }

    try {
      functions.logger.info(`Exchanging code for access token with Discord using redirect_uri: ${clientRedirectUri}...`);

      // 1. Exchange authorization code for a Discord access token
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
          redirect_uri: clientRedirectUri,
        }).toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text().catch(() => '');
        functions.logger.error(`Discord token exchange failed (HTTP ${tokenResponse.status}): ${errorText}`);
        throw new functions.https.HttpsError(
          'invalid-argument',
          `Discord 토큰 교환 실패 (HTTP ${tokenResponse.status}): ${errorText}`
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token: string;
        scope: string;
      };

      functions.logger.info('Token exchange successful. Retrieving user profile...');

      // 2. Fetch Discord user profile
      const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
        headers: {
          Authorization: `${tokenData.token_type} ${tokenData.access_token}`,
        },
      });

      if (!userResponse.ok) {
        const userErrText = await userResponse.text().catch(() => '');
        functions.logger.error(`Discord user profile fetch failed (HTTP ${userResponse.status}): ${userErrText}`);
        throw new functions.https.HttpsError(
          'unknown',
          `Discord 사용자 정보 조회 실패 (HTTP ${userResponse.status}): ${userErrText}`
        );
      }

      const discordUser = (await userResponse.json()) as {
        id: string;
        username: string;
        global_name: string | null;
        avatar: string | null;
        email?: string;
        verified?: boolean;
      };

      if (!discordUser.id) {
        throw new functions.https.HttpsError(
          'unknown',
          '유효한 Discord user ID를 취득하지 못했습니다.'
        );
      }

      functions.logger.info(`Discord user profile verified: ${discordUser.username} (${discordUser.id})`);

      // 4. Unique and collision-safe Firebase UID generation
      const firebaseUid = `discord:${discordUser.id}`;

      // Mint the custom token
      let customToken = '';
      try {
        customToken = await admin.auth().createCustomToken(firebaseUid);
      } catch (customTokenError: any) {
        functions.logger.error('Firebase Custom Token 생성 중 오류 발생:', customTokenError);
        throw new functions.https.HttpsError(
          'unknown',
          `Firebase Custom Token 생성 실패: ${customTokenError?.message || String(customTokenError)}`
        );
      }

      // Determine proper avatar URL
      let avatarURL = '';
      if (discordUser.avatar) {
        avatarURL = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`;
      } else {
        const defaultAvatarIndex = parseInt(discordUser.id) ? (parseInt(discordUser.id) % 5) : 0;
        avatarURL = `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
      }

      return {
        success: true,
        customToken,
        discordUser: {
          id: discordUser.id,
          username: discordUser.username,
          global_name: discordUser.global_name || discordUser.username,
          avatar: avatarURL,
          email: discordUser.email || null,
        }
      };
    } catch (error: any) {
      if (error instanceof functions.https.HttpsError) {
        throw error;
      }
      functions.logger.error('Unhandled error during Discord authentication callback:', error);
      throw new functions.https.HttpsError(
        'unknown',
        `디스코드 인증 처리 오류: ${error?.message || String(error)}`
      );
    }
  });
