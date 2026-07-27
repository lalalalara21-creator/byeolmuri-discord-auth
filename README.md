# byeolmuri-discord-auth

별무리(Byeolmuri) 프로젝트에서 독립 수록된 **Discord OAuth2 인증 서버 & 클라이언트 SDK 모듈**입니다.

Firebase Cloud Functions(v2/v1)와 Discord OAuth2 API를 연동하여 안전하게 Discord 계정으로 로그인하고, Firebase Custom Auth Token을 발급받아 로그인 세션을 처리합니다.

---

## 📁 디렉터리 구조

```text
byeolmuri-discord-auth/
├── .env.example                # 환경 변수 템플릿
├── firebase.json               # Firebase Cloud Functions 배포 설정
├── package.json                # 루트 패키지 설정
├── functions/                  # Firebase Cloud Functions (서버 사이드)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Cloud Functions 진입점
│       └── auth/
│           └── discordAuth.ts  # Discord OAuth2 교환 & Custom Token 생성 핵심 로직
└── client/                     # 프론트엔드 리액트 클라이언트 연동 모듈 (클라이언트 사이드)
    └── src/
        ├── firebase.ts         # Firebase App / Auth / Functions 초기화
        ├── types.ts            # Discord 및 AppUser 타입 정의
        ├── authService.ts      # Discord OAuth 리다이렉트 요청 함수
        ├── userService.ts      # Firestore users 컬렉션 사용자 생성 및 조회
        └── AuthContext.tsx     # OAuth Callback URL 수신 및 Custom Token 로그인 컨텍스트
```

---

## ⚙️ 주요 기능 및 아키텍처

1. **Discord OAuth2 Authorization Code Flow**:
   - 프론트엔드에서 Cryptographically Secure Random State (`window.crypto.getRandomValues`)를 생성하여 CSRF 공격을 방지합니다.
   - Discord OAuth2 동의 페이지로 이동 후 `code` 및 `state`를 callback URL로 전달받습니다.
2. **Cloud Function (Backend Token Exchange)**:
   - Secret Manager(`defineSecret`)에 안전하게 저장된 `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`를 활용합니다.
   - Discord API (`https://discord.com/api/v10/oauth2/token`)와 통신하여 `access_token`을 교환합니다.
   - Discord User Profile (`https://discord.com/api/v10/users/@me`)을 조회하고, `discord:{discord_id}` 형식의 고유 Firebase UID를 생성합니다.
   - `admin.auth().createCustomToken(firebaseUid)`를 호출하여 Firebase Custom Token을 발급합니다.
3. **Firestore Sync**:
   - 발급받은 Custom Token으로 `signInWithCustomToken`을 실행한 후, `users` 컬렉션에 사용자 정보(`loginProviders: ['discord']`, `role: 'visitor'` 등)를 생성/갱신합니다.

---

## 🚀 설정 및 배포 방법

### 1. GCP Secret Manager 및 Cloud Functions 환경 설정
Secret Manager에 비밀값을 저장하거나 Firebase CLI 환경변수를 등록합니다.

```bash
firebase secrets:set DISCORD_CLIENT_ID
firebase secrets:set DISCORD_CLIENT_SECRET
firebase secrets:set DISCORD_REDIRECT_URI
```

### 2. Cloud Functions 배포
```bash
cd functions
npm install
npm run build
firebase deploy --only functions
```

### 3. 클라이언트 환경변수 설정 (`.env`)
```env
VITE_DISCORD_CLIENT_ID=1528735887125385346
```

---

## 📄 라이선스
MIT License
