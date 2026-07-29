import React, { createContext, useContext, useState, useEffect } from 'react';
import { User, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { auth } from './firebase';
import { AppUser } from './types';
import { createAppUserIfNotExist } from './userService';
import { signInWithGoogle, signOut, signInWithDiscord } from './authService';
import { getFunctions, httpsCallable } from 'firebase/functions';

export type AuthProviderType = 'google' | 'discord' | null;

interface AuthContextType {
  user: User | null;
  appUser: AppUser | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  loginProvider: AuthProviderType;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  signInWithDiscord: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginProvider, setLoginProvider] = useState<AuthProviderType>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        
        // Detect login provider from Firebase Auth user data
        const providerId = firebaseUser.providerData[0]?.providerId;
        if (providerId === 'google.com') {
          setLoginProvider('google');
        } else if (providerId?.includes('discord') || firebaseUser.uid.startsWith('discord:')) {
          setLoginProvider('discord');
        } else {
          setLoginProvider('google'); // fallback default
        }

        try {
          const appUserData = await createAppUserIfNotExist(
            firebaseUser.uid,
            firebaseUser.email,
            firebaseUser.displayName,
            firebaseUser.photoURL
          );
          setAppUser(appUserData);
        } catch (error) {
          console.error('Error in onAuthStateChanged checking/creating AppUser:', error);
          setAppUser(null);
        }
      } else {
        setUser(null);
        setAppUser(null);
        setLoginProvider(null);
      }
      
      // Only set authLoading to false if we are not on the Discord callback path
      if (window.location.pathname !== '/auth/discord/callback') {
        setAuthLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const handleDiscordCallback = async () => {
      if (window.location.pathname !== '/auth/discord/callback') {
        return;
      }

      setAuthLoading(true);

      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error');

      // Retrieve and immediately remove stored state to prevent reuse
      const storedState = sessionStorage.getItem('discord_oauth_state');
      sessionStorage.removeItem('discord_oauth_state');

      const cleanUrlAndHome = () => {
        window.history.replaceState({}, document.title, '/');
      };

      if (error) {
        cleanUrlAndHome();
        setAuthLoading(false);
        if (error === 'access_denied') {
          alert('디스코드 로그인이 취소되었습니다.');
        } else {
          alert('디스코드 로그인 중 오류가 발생했습니다.');
        }
        return;
      }

      if (!code || !state) {
        cleanUrlAndHome();
        setAuthLoading(false);
        if (code || state) {
          alert('잘못된 로그인 요청입니다. 인증 정보가 누락되었습니다.');
        }
        return;
      }

      // Cryptographically secure state validation (CSRF Check)
      if (!storedState || storedState !== state) {
        cleanUrlAndHome();
        setAuthLoading(false);
        console.error('Discord OAuth State verification failed.');
        alert('보안 검증 실패: 유효하지 않은 요청 세션(State)입니다. 다시 시도해 주세요.');
        return;
      }

      try {
        const redirectUri = window.location.origin + '/auth/discord/callback';
        const railwayApiUrl = (import.meta as any).env?.VITE_RAILWAY_AUTH_URL || 'https://byeolmuri-discord-auth-production.up.railway.app/api/auth/discord';

        let customToken = '';

        try {
          // Attempt HTTP POST to Railway Auth Server first
          const response = await fetch(railwayApiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, redirectUri }),
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.customToken) {
              customToken = data.customToken;
            } else {
              throw new Error(data.error || 'Token response missing customToken');
            }
          } else {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.error || `HTTP ${response.status}`);
          }
        } catch (httpErr: any) {
          console.warn('Railway Auth API request failed or not reachable, falling back to Firebase Functions callable:', httpErr);
          
          // Fallback to Firebase Functions callable
          const functionsInstance = getFunctions();
          const callDiscordCallback = httpsCallable<{ code: string; redirectUri: string }, { success: boolean; customToken: string }>(
            functionsInstance,
            'discordAuthCallback'
          );
          const result = await callDiscordCallback({ code, redirectUri });
          if (result.data?.success && result.data?.customToken) {
            customToken = result.data.customToken;
          } else {
            throw new Error('No custom token returned from Firebase Functions');
          }
        }

        if (customToken) {
          await signInWithCustomToken(auth, customToken);
        } else {
          throw new Error('커스텀 토큰을 발급받지 못했습니다.');
        }
      } catch (err: any) {
        console.error('Discord callback sign-in failed:', err);
        const codeMsg = err?.code ? ` [Code: ${err.code}]` : '';
        const detailMsg = err?.message || '인증 서버와의 통신 중 오류가 발생했습니다.';
        alert(`디스코드 로그인 인증 처리 중 오류가 발생했습니다.\n\n오류 상세${codeMsg}: ${detailMsg}`);
      } finally {
        cleanUrlAndHome();
        setAuthLoading(false);
      }
    };

    handleDiscordCallback();
  }, []);

  const value: AuthContextType = {
    user,
    appUser,
    isAuthenticated: !!user,
    authLoading,
    loginProvider,
    signInWithGoogle,
    signOut,
    signInWithDiscord,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
