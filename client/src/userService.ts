import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { AppUser, UserRole } from './types';

/**
 * Fetch the AppUser document from the 'users' collection by UID.
 */
export async function getAppUser(uid: string): Promise<AppUser | null> {
  try {
    const userDocRef = doc(db, 'users', uid);
    const userSnapshot = await getDoc(userDocRef);
    if (userSnapshot.exists()) {
      const data = userSnapshot.data();
      const isDiscord = uid.startsWith('discord:');
      return {
        uid,
        ...data,
        loginProviders: data?.loginProviders || [isDiscord ? 'discord' : 'google']
      } as AppUser;
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch user from users collection:', error);
    return null;
  }
}

/**
 * Check if user doc exists in the 'users' collection. If not, create it.
 */
export async function createAppUserIfNotExist(
  uid: string,
  email: string | null,
  displayName: string | null,
  photoURL: string | null
): Promise<AppUser> {
  try {
    const userDocRef = doc(db, 'users', uid);
    const userSnapshot = await getDoc(userDocRef);

    if (userSnapshot.exists()) {
      const data = userSnapshot.data();
      const isDiscord = uid.startsWith('discord:');
      const defaultProviders = [isDiscord ? 'discord' : 'google'];

      return {
        uid,
        ...data,
        loginProviders: data?.loginProviders || defaultProviders
      } as AppUser;
    }

    const isDiscord = uid.startsWith('discord:');
    const newUser: AppUser = {
      uid,
      email,
      displayName,
      photoURL,
      role: 'visitor', // Always create as visitor initially
      createdAt: new Date().toISOString(),
      loginProviders: [isDiscord ? 'discord' : 'google']
    };

    await setDoc(userDocRef, {
      email: newUser.email,
      displayName: newUser.displayName,
      photoURL: newUser.photoURL,
      role: newUser.role,
      createdAt: newUser.createdAt,
      loginProviders: newUser.loginProviders
    });

    return newUser;
  } catch (error) {
    console.error('Failed to check/create user in users collection:', error);
    throw error;
  }
}
