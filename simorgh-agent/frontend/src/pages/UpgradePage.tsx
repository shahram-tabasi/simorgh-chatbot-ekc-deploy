import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Check, Zap, Star, Crown, User,
  ExternalLink, Clock, CheckCircle, XCircle, Loader2
} from 'lucide-react';
import { useAuth, isModernUser } from '../context/AuthContext';
import { useQuota } from '../hooks/useQuota';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface PricingTier {
  name: string;
  price_usd: number;
  questions_per_day: number;
  can_create_projects: boolean;
  can_use_tools: boolean;
  duration_days: number;
  description?: string;
}

const TIER_FEATURES: Record<string, { icon: React.ReactNode; color: string; highlights: string[] }> = {
  pro: {
    icon: <Star className="w-8 h-8" />,
    color: 'blue',
    highlights: [
      '100 questions per day',
      'Project-based chats',
      'Priority support',
      '30-day access',
    ],
  },
  max: {
    icon: <Zap className="w-8 h-8" />,
    color: 'purple',
    highlights: [
      '500 questions per day',
      'Project-based chats',
      'All AI tools enabled',
      '30-day access',
    ],
  },
};

export default function UpgradePage() {
  const { user, token } = useAuth();
  const { quota, isModern } = useQuota();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tiers, setTiers] = useState<PricingTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);

  const status = searchParams.get('status');
  const txId = searchParams.get('tx');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Fetch pricing
  useEffect(() => {
    const fetchPricing = async () => {
      try {
        const res = await fetch(`${API_BASE}/v2/payments/pricing`);
        if (res.ok) {
          const data = await res.json();
          setTiers(data.tiers);
        }
      } catch (e) {
        console.error('Failed to fetch pricing:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchPricing();
  }, []);

  // Handle purchase
  const handlePurchase = useCallback(async (tierName: string) => {
    if (!token) {
      navigate('/login');
      return;
    }

    setPurchasing(tierName);
    try {
      const res = await fetch(`${API_BASE}/v2/payments/create-invoice`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier: tierName }),
      });

      if (res.ok) {
        const data = await res.json();
        // Redirect to NOWPayments checkout
        window.location.href = data.invoice_url;
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to create payment');
      }
    } catch (e) {
      console.error('Purchase failed:', e);
      alert('Payment service temporarily unavailable');
    } finally {
      setPurchasing(null);
    }
  }, [token, headers, navigate]);

  const currentRoleLevel = { free: 0, pro: 1, max: 2, admin: 3 }[quota.user_role] || 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-black/40 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="p-2 hover:bg-white/10 rounded-lg transition"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-bold">Upgrade Plan</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Payment Status Banner */}
        {status === 'success' && (
          <div className="mb-8 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center gap-3">
            <CheckCircle className="w-6 h-6 text-emerald-400 flex-shrink-0" />
            <div>
              <p className="text-emerald-400 font-medium">Payment submitted</p>
              <p className="text-sm text-gray-400">
                Your payment is being processed. Your plan will be upgraded automatically once confirmed on the blockchain.
              </p>
            </div>
          </div>
        )}

        {status === 'cancelled' && (
          <div className="mb-8 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-3">
            <XCircle className="w-6 h-6 text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-amber-400 font-medium">Payment cancelled</p>
              <p className="text-sm text-gray-400">
                No charges were made. You can try again anytime.
              </p>
            </div>
          </div>
        )}

        {/* Current Plan */}
        {isModern && (
          <div className="mb-8 p-5 rounded-xl bg-white/5 border border-white/10">
            <div className="flex items-center gap-3 mb-2">
              <User className="w-5 h-5 text-gray-400" />
              <span className="text-sm text-gray-400">Current Plan</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold capitalize">{quota.user_role}</span>
              <span className="text-sm text-gray-500">
                {quota.questions_remaining}/{quota.questions_limit} questions remaining today
              </span>
            </div>
          </div>
        )}

        {/* Pricing Section Header */}
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold mb-2">Choose Your Plan</h2>
          <p className="text-gray-400">
            Pay with cryptocurrency. Instant activation after blockchain confirmation.
          </p>
        </div>

        {/* Pricing Cards */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            Loading plans...
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-6 mb-12">
            {tiers.map(tier => {
              const features = TIER_FEATURES[tier.name];
              if (!features) return null;

              const isCurrent = quota.user_role === tier.name;
              const isUpgrade = ({ free: 0, pro: 1, max: 2, admin: 3 }[tier.name] || 0) > currentRoleLevel;
              const colorMap: Record<string, string> = {
                blue: 'border-blue-500/30 hover:border-blue-500/60',
                purple: 'border-purple-500/30 hover:border-purple-500/60',
              };
              const btnMap: Record<string, string> = {
                blue: 'from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700',
                purple: 'from-purple-500 to-purple-600 hover:from-purple-600 hover:to-purple-700',
              };
              const iconColorMap: Record<string, string> = {
                blue: 'text-blue-400',
                purple: 'text-purple-400',
              };

              return (
                <div
                  key={tier.name}
                  className={`relative rounded-2xl p-6 border-2 bg-white/5 transition-all ${
                    colorMap[features.color]
                  } ${tier.name === 'max' ? 'ring-1 ring-purple-500/20' : ''}`}
                >
                  {tier.name === 'max' && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-purple-500 rounded-full text-xs font-bold">
                      POPULAR
                    </div>
                  )}

                  <div className={`mb-4 ${iconColorMap[features.color]}`}>
                    {features.icon}
                  </div>

                  <h3 className="text-2xl font-bold capitalize mb-1">{tier.name}</h3>

                  <div className="flex items-baseline gap-1 mb-4">
                    <span className="text-3xl font-bold">${tier.price_usd}</span>
                    <span className="text-gray-500 text-sm">/ {tier.duration_days} days</span>
                  </div>

                  <ul className="space-y-3 mb-6">
                    {features.highlights.map((feature, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm">
                        <Check className={`w-4 h-4 ${iconColorMap[features.color]}`} />
                        <span className="text-gray-300">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <button
                      disabled
                      className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-gray-500 font-medium cursor-default"
                    >
                      Current Plan
                    </button>
                  ) : isUpgrade ? (
                    <button
                      onClick={() => handlePurchase(tier.name)}
                      disabled={purchasing !== null}
                      className={`w-full py-3 rounded-xl bg-gradient-to-r ${btnMap[features.color]} text-white font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2`}
                    >
                      {purchasing === tier.name ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Creating invoice...
                        </>
                      ) : (
                        <>
                          Upgrade to {tier.name}
                          <ExternalLink className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      disabled
                      className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-gray-500 font-medium cursor-default"
                    >
                      Included in your plan
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Free Tier */}
        <div className="rounded-xl p-5 border border-white/10 bg-white/5 mb-8">
          <div className="flex items-center gap-3 mb-3">
            <User className="w-6 h-6 text-gray-400" />
            <h3 className="text-lg font-bold">Free</h3>
            <span className="text-sm text-gray-500">$0</span>
          </div>
          <ul className="space-y-2 text-sm text-gray-400">
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-600" /> 20 questions per day</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-600" /> General chat only</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-gray-600" /> Online AI models</li>
          </ul>
        </div>

        {/* Payment Info */}
        <div className="text-center text-sm text-gray-500 space-y-2">
          <p className="flex items-center justify-center gap-2">
            <Clock className="w-4 h-4" />
            Payments are processed via NOWPayments. Support 300+ cryptocurrencies.
          </p>
          <p>
            Your plan activates automatically after blockchain confirmation (usually 5-30 minutes).
          </p>
        </div>
      </div>
    </div>
  );
}
