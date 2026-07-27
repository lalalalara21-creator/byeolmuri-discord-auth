import * as admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp();
}

// Export Discord Auth Cloud Function
export { discordAuthCallback } from './auth/discordAuth';
