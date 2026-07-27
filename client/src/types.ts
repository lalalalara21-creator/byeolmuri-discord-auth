export type UserRole = 'visitor' | 'member' | 'staff' | 'admin' | 'superAdmin';

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  role: UserRole;
  createdAt: string;
  loginProviders?: string[];
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string;
  avatar: string;
  email: string | null;
}
