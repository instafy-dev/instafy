import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasSupabaseConfig, supabase } from "../lib/supabaseClient";
import { useAuth } from "../providers/AuthProvider";

const LOCAL_PROFILE_PREFIX = "instafy.profile.";

export interface UserProfile {
  fullName: string | null;
  avatarUrl: string | null;
}

export interface ProfileUpdateInput {
  fullName?: string | null;
  avatarUrl?: string | null;
}

interface ProfileContextValue {
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  updateProfile: (updates: ProfileUpdateInput) => Promise<{ success: boolean; error?: string }>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

function readLocalProfile(userId: string): UserProfile | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(`${LOCAL_PROFILE_PREFIX}${userId}`);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as UserProfile;
    return {
      fullName: typeof parsed.fullName === "string" ? parsed.fullName : null,
      avatarUrl: typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : null
    };
  } catch {
    return null;
  }
}

function writeLocalProfile(userId: string, profile: UserProfile) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(`${LOCAL_PROFILE_PREFIX}${userId}`, JSON.stringify(profile));
  } catch {
    // ignore storage failures
  }
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!userId) {
        setProfile(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (inflightRef.current && !options?.force) {
        return;
      }
      inflightRef.current = true;
      setLoading(true);
      try {
        if (!hasSupabaseConfig) {
          const localProfile = readLocalProfile(userId);
          setProfile(localProfile ?? { fullName: null, avatarUrl: null });
          setError(null);
          return;
        }
        const { data, error: fetchError } = await supabase
          .from("profiles")
          .select("full_name, avatar_url")
          .eq("user_id", userId)
          .limit(1);
        if (fetchError) {
          setError(fetchError.message);
          return;
        }
        const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
        setProfile({
          fullName: row?.full_name ?? null,
          avatarUrl: row?.avatar_url ?? null
        });
        setError(null);
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [userId]
  );

  const updateProfile = useCallback(
    async (updates: ProfileUpdateInput) => {
      if (!userId) {
        return { success: false, error: "Sign in to update your profile." };
      }
      const nextProfile: UserProfile = {
        fullName: updates.fullName === undefined ? profile?.fullName ?? null : updates.fullName,
        avatarUrl: updates.avatarUrl === undefined ? profile?.avatarUrl ?? null : updates.avatarUrl
      };

      if (!hasSupabaseConfig) {
        writeLocalProfile(userId, nextProfile);
        setProfile(nextProfile);
        setError(null);
        return { success: true };
      }

      const { error: upsertError } = await supabase
        .from("profiles")
        .upsert(
          {
            user_id: userId,
            full_name: nextProfile.fullName ?? null,
            avatar_url: nextProfile.avatarUrl ?? null
          },
          { onConflict: "user_id" }
        );
      if (upsertError) {
        return { success: false, error: upsertError.message };
      }
      setProfile(nextProfile);
      setError(null);
      return { success: true };
    },
    [profile?.avatarUrl, profile?.fullName, userId]
  );

  useEffect(() => {
    void refresh({ force: true });
  }, [refresh]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      loading,
      error,
      refresh,
      updateProfile
    }),
    [profile, loading, error, refresh, updateProfile]
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile must be used within ProfileProvider");
  }
  return context;
}
