import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hasSupabaseConfig, supabase } from "../lib/supabaseClient";
import { useAuth } from "../providers/AuthProvider";
import { resolveProfileDefaults } from "./profileDefaults";

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
  const { fullName: defaultName, avatarUrl: defaultAvatar } = resolveProfileDefaults(user?.user_metadata);
  const [profileState, setProfileState] = useState<{ userId: string; profile: UserProfile } | null>(null);
  const profile = profileState?.userId === userId ? profileState.profile : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeUserIdRef = useRef(userId);
  const accountVersionRef = useRef(0);
  if (activeUserIdRef.current !== userId) {
    accountVersionRef.current += 1;
    activeUserIdRef.current = userId;
  }
  const requestVersionRef = useRef(0);
  const inflightRef = useRef<string | null>(null);
  const saveVersionRef = useRef(0);
  const pendingSaveRef = useRef<{ userId: string; accountVersion: number; version: number } | null>(null);

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (activeUserIdRef.current !== userId) return;
      if (pendingSaveRef.current?.userId === userId &&
          pendingSaveRef.current.accountVersion === accountVersionRef.current) return;
      if (!userId) {
        requestVersionRef.current += 1;
        inflightRef.current = null;
        setProfileState(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (inflightRef.current === userId && !options?.force) {
        return;
      }
      const version = ++requestVersionRef.current;
      const isCurrent = () => activeUserIdRef.current === userId && requestVersionRef.current === version;
      inflightRef.current = userId;
      setLoading(true);
      setError(null);
      try {
        if (!hasSupabaseConfig) {
          const stored = readLocalProfile(userId);
          const localProfile = stored ?? { fullName: defaultName, avatarUrl: defaultAvatar };
          if (!stored) writeLocalProfile(userId, localProfile);
          setProfileState({ userId, profile: localProfile });
          setError(null);
          return;
        }
        const readProfile = () => supabase
          .from("profiles")
          .select("full_name, avatar_url")
          .eq("user_id", userId)
          .limit(1);
        const { data, error: fetchError } = await readProfile();
        if (!isCurrent()) return;
        if (fetchError) {
          setError(fetchError.message);
          return;
        }
        let row = Array.isArray(data) && data.length > 0 ? data[0] : null;
        if (!row) {
          // Insert once. Another tab may have saved a profile since this read;
          // never replace it, and reread the winner rather than assuming ours won.
          const { error: insertError } = await supabase.from("profiles").upsert({
            user_id: userId,
            full_name: defaultName,
            avatar_url: defaultAvatar
          }, { onConflict: "user_id", ignoreDuplicates: true });
          if (!isCurrent()) return;
          if (insertError) {
            setError(insertError.message);
            return;
          }
          const result = await readProfile();
          if (!isCurrent()) return;
          if (result.error) {
            setError(result.error.message);
            return;
          }
          row = Array.isArray(result.data) && result.data.length > 0 ? result.data[0] : null;
          if (!row) {
            setError("Unable to load your profile. Please retry.");
            return;
          }
        }
        setProfileState({ userId, profile: {
          fullName: row.full_name ?? null,
          avatarUrl: row.avatar_url ?? null
        } });
        setError(null);
      } catch (cause) {
        if (isCurrent()) setError(cause instanceof Error ? cause.message : "Unable to load your profile.");
      } finally {
        if (isCurrent()) {
          inflightRef.current = null;
          setLoading(false);
        }
      }
    },
    [userId, defaultName, defaultAvatar]
  );

  const updateProfile = useCallback(
    async (updates: ProfileUpdateInput) => {
      if (!userId || activeUserIdRef.current !== userId) {
        return { success: false, error: "Sign in to update your profile." };
      }
      // A pending initialization/refresh must not overwrite this explicit edit.
      const version = ++saveVersionRef.current;
      const accountVersion = accountVersionRef.current;
      const isCurrent = () => activeUserIdRef.current === userId &&
        accountVersionRef.current === accountVersion && saveVersionRef.current === version;
      pendingSaveRef.current = { userId, accountVersion, version };
      requestVersionRef.current += 1;
      inflightRef.current = null;
      setLoading(false);
      const baseProfile = profile ?? { fullName: defaultName, avatarUrl: defaultAvatar };
      const nextProfile: UserProfile = {
        fullName: updates.fullName === undefined ? baseProfile.fullName : updates.fullName,
        avatarUrl: updates.avatarUrl === undefined ? baseProfile.avatarUrl : updates.avatarUrl
      };

      try {
        if (!hasSupabaseConfig) {
          writeLocalProfile(userId, nextProfile);
          setProfileState({ userId, profile: nextProfile });
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
        if (isCurrent()) {
          setProfileState({ userId, profile: nextProfile });
          setError(null);
        }
        return { success: true };
      } catch (cause) {
        return { success: false, error: cause instanceof Error ? cause.message : "Unable to update your profile." };
      } finally {
        if (pendingSaveRef.current?.version === version) pendingSaveRef.current = null;
      }
    },
    [profile, userId, defaultName, defaultAvatar]
  );

  useEffect(() => {
    void refresh({ force: true });
    return () => {
      requestVersionRef.current += 1;
      inflightRef.current = null;
    };
  }, [refresh]);

  useEffect(() => () => { saveVersionRef.current += 1; }, []);

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
