// src/hooks/useQuota.ts
import { useState, useEffect, useCallback } from 'react';
import { useAuth, isModernUser } from '../context/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export interface QuotaInfo {
  user_role: string;
  questions_used_today: number;
  questions_limit: number;
  questions_remaining: number;
  can_create_projects: boolean;
  can_use_offline_llm: boolean;
  can_use_tools: boolean;
  subscription_expires_at?: string;
  subscription_active: boolean;
  resets_at: string;
}

export interface TierInfo {
  tier_name: string;
  max_questions_per_day: number;
  can_create_projects: boolean;
  can_use_offline_llm: boolean;
  can_use_tools: boolean;
  subscription_duration_days?: number;
  description?: string;
}

const DEFAULT_QUOTA: QuotaInfo = {
  user_role: 'free',
  questions_used_today: 0,
  questions_limit: 20,
  questions_remaining: 20,
  can_create_projects: false,
  can_use_offline_llm: false,
  can_use_tools: false,
  subscription_active: true,
  resets_at: '',
};

// localStorage cache key — one entry per user, scoped by id so a
// shared device doesn't leak another user's count if both log in.
// We carry the usage_date along so a refresh AFTER midnight UTC
// doesn't replay yesterday's tally onto today; the day-rollover
// check below treats stale entries as "no cache".
const QUOTA_CACHE_KEY_PREFIX = 'simorgh_quota_';
function cacheKey(userId?: string | null): string | null {
  return userId ? `${QUOTA_CACHE_KEY_PREFIX}${userId}` : null;
}
function todayUtcDateStr(): string {
  // Match Postgres CURRENT_DATE (UTC in our deploy). Just the
  // YYYY-MM-DD piece — we don't care about hours here.
  return new Date().toISOString().slice(0, 10);
}
function loadCachedQuota(userId?: string | null): QuotaInfo | null {
  const key = cacheKey(userId);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaInfo & { _cached_date?: string };
    // Discard cache from a previous UTC day — server resets at
    // midnight UTC; we shouldn't paint yesterday's count over
    // today's fresh slate while the network fetch is in flight.
    if (parsed._cached_date && parsed._cached_date !== todayUtcDateStr()) {
      return null;
    }
    delete parsed._cached_date;
    return parsed as QuotaInfo;
  } catch {
    return null;
  }
}
function saveCachedQuota(userId: string | null | undefined, q: QuotaInfo) {
  const key = cacheKey(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify({ ...q, _cached_date: todayUtcDateStr() }));
  } catch {
    /* localStorage quota / private mode — non-fatal */
  }
}

export function useQuota() {
  const { user, token, isAuthenticated } = useAuth();
  const isModern = user && isModernUser(user);
  const isLegacy = user && !isModernUser(user);
  const userId = (user && isModernUser(user))
    ? (user as any).id as string
    : null;

  // Initial state: the LAST-KNOWN quota cached in localStorage from
  // the previous page. Without this the ring shows DEFAULT_QUOTA
  // (20 used today: 0) for ~200ms on every page refresh, which
  // operators read as "the quota reset on refresh". Server fetch
  // runs in the background and corrects the local copy if the
  // cached one is stale. Day-rollover stale entries are dropped
  // by loadCachedQuota itself.
  const [quota, setQuota] = useState<QuotaInfo>(
    () => loadCachedQuota(userId) || DEFAULT_QUOTA
  );
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchQuota = useCallback(async () => {
    if (!isAuthenticated || !token || !isModern) return;

    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/v2/quota/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setQuota(data);
        saveCachedQuota(userId, data);
      }
    } catch (error) {
      console.error('Failed to fetch quota:', error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, token, isModern, userId]);

  const fetchTiers = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v2/quota/tiers`);
      if (response.ok) {
        const data = await response.json();
        setTiers(data);
      }
    } catch (error) {
      console.error('Failed to fetch tiers:', error);
    }
  }, []);

  // Listen for stream-completion events from useChat. The
  // backend's general_chat_hr now yields its `done` SSE frame
  // AFTER incrementing the user's daily-quota counter, so we
  // can fetch the authoritative remaining count the moment the
  // stream finishes — no racy setTimeout, no polling. See the
  // matching dispatchEvent in useChat.ts onDone handler.
  useEffect(() => {
    if (!isModern) return;
    const onStreamed = () => { fetchQuota(); };
    window.addEventListener('simorgh-message-streamed', onStreamed);
    return () => window.removeEventListener('simorgh-message-streamed', onStreamed);
  }, [isModern, fetchQuota]);

  // Fetch quota on auth change
  useEffect(() => {
    if (isModern) {
      fetchQuota();
    } else if (isLegacy) {
      // Legacy users have unlimited access
      setQuota({
        ...DEFAULT_QUOTA,
        user_role: 'legacy',
        questions_limit: 999999,
        questions_remaining: 999999,
        can_create_projects: true,
        can_use_offline_llm: true,
        can_use_tools: true,
      });
    }
  }, [isModern, isLegacy, fetchQuota]);

  // Decrement remaining locally after sending a message (optimistic update)
  const decrementLocal = useCallback(() => {
    setQuota(prev => {
      const next = {
        ...prev,
        questions_used_today: prev.questions_used_today + 1,
        questions_remaining: Math.max(0, prev.questions_remaining - 1),
      };
      saveCachedQuota(userId, next);
      return next;
    });
  }, [userId]);

  const quotaExceeded = isModern && quota.questions_remaining <= 0;
  const quotaWarning = isModern && quota.questions_remaining > 0 && quota.questions_remaining <= 5;
  const quotaPercentage = quota.questions_limit > 0
    ? Math.round((quota.questions_used_today / quota.questions_limit) * 100)
    : 0;

  return {
    quota,
    tiers,
    loading,
    isModern: !!isModern,
    isLegacy: !!isLegacy,
    quotaExceeded,
    quotaWarning,
    quotaPercentage,
    fetchQuota,
    fetchTiers,
    decrementLocal,
    canCreateProjects: isLegacy || quota.can_create_projects,
    canUseOfflineLlm: isLegacy || quota.can_use_offline_llm,
    canUseTools: isLegacy || quota.can_use_tools,
  };
}
