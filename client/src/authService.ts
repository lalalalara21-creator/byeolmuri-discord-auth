import { GoogleAuthProvider, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase';

/**
 * Sign in using Google OAuth Popup
 */
export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

/**
 * Sign out the currently logged-in user
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}

/**
 * Sign in using Discord OAuth2 redirect
 */
export async function signInWithDiscord(): Promise<void> {
  const clientId = (import.meta as any).env.VITE_DISCORD_CLIENT_ID || '1528735887125385346';
  if (!clientId) {
    console.error('VITE_DISCORD_CLIENT_ID is not configured.');
    alert('디스코드 클라이언트 ID가 구성되지 않았습니다. .env 환경변수를 확인해주세요.');
    return;
  }

  // Generate a cryptographically secure random state string using crypto.getRandomValues
  const array = new Uint32Array(4);
  window.crypto.getRandomValues(array);
  const state = Array.from(array, dec => dec.toString(16).padStart(8, '0')).join('');

  // Store in sessionStorage securely
  sessionStorage.setItem('discord_oauth_state', state);

  // Determine dynamic redirect URI matching the environment
  const redirectUri = window.location.origin + '/auth/discord/callback';

  // Construct URL
  const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20email&state=${state}`;

  // Redirect the browser tab
  window.location.href = url;
}
