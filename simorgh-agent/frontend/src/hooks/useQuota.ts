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

export function useQuota() {
  const { user, token, isAuthenticated } = useAuth();
  const [quota, setQuota] = useState<QuotaInfo>(DEFAULT_QUOTA);
  const [tiers, setTiers] = useState<TierInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const isModern = user && isModernUser(user);
  const isLegacy = user && !isModernUser(user);

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
      }
    } catch (error) {
      console.error('Failed to fetch quota:', error);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, token, isModern]);

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
    setQuota(prev => ({
      ...prev,
      questions_used_today: prev.questions_used_today + 1,
      questions_remaining: Math.max(0, prev.questions_remaining - 1),
    }));
  }, []);

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
