import express, { Request, Response } from "express";
import cors from "cors";
import * as admin from "firebase-admin";

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://service-846179397596.us-west1.run.app",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("허용되지 않은 요청 주소입니다."));
    },
  }),
);

app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "byeolmuri-discord-auth",
  });
});

app.post("/api/auth/discord", async (req: Request, res: Response) => {
  try {
    const { code, redirectUri } = req.body as {
      code?: string;
      redirectUri?: string;
    };

    if (!code || !redirectUri) {
      res.status(400).json({
        error: "code와 redirectUri가 필요합니다.",
      });
      return;
    }

    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const configuredRedirectUri = process.env.DISCORD_REDIRECT_URI;

    if (!clientId || !clientSecret || !configuredRedirectUri) {
      res.status(500).json({
        error: "Discord 서버 환경변수가 설정되지 않았습니다.",
      });
      return;
    }

    if (redirectUri !== configuredRedirectUri) {
      res.status(400).json({
        error: "등록되지 않은 Redirect URI입니다.",
      });
      return;
    }

    const tokenResponse = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      },
    );

    if (!tokenResponse.ok) {
      res.status(401).json({
        error: "Discord 인증 코드 교환에 실패했습니다.",
      });
      return;
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
    };

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userResponse.ok) {
      res.status(401).json({
        error: "Discord 사용자 정보를 가져오지 못했습니다.",
      });
      return;
    }

    const discordUser = (await userResponse.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
      email?: string | null;
    };

    const firebaseUid = `discord:${discordUser.id}`;

    const customToken = await admin.auth().createCustomToken(firebaseUid, {
      provider: "discord",
      discordId: discordUser.id,
    });

    await admin
      .firestore()
      .collection("users")
      .doc(firebaseUid)
      .set(
        {
          uid: firebaseUid,
          discordId: discordUser.id,
          displayName: discordUser.global_name || discordUser.username,
          username: discordUser.username,
          email: discordUser.email || null,
          avatar: discordUser.avatar || null,
          loginProviders: {
            discord: true,
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    res.status(200).json({
      customToken,
      user: {
        uid: firebaseUid,
        discordId: discordUser.id,
        username: discordUser.username,
        displayName: discordUser.global_name || discordUser.username,
        avatar: discordUser.avatar || null,
      },
    });
  } catch (error) {
    console.error("Discord OAuth 처리 실패:", error);

    res.status(500).json({
      error: "Discord 로그인 처리 중 서버 오류가 발생했습니다.",
    });
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port} (0.0.0.0:${port})`);
});
