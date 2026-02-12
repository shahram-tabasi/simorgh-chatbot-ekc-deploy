import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, BarChart3, Settings, ArrowLeft, Search,
  Shield, ChevronDown, ChevronUp, UserCheck, UserX,
  Crown, Star, Zap, User, RefreshCw, Edit2, Check, X
} from 'lucide-react';
import { useAuth, isModernUser } from '../context/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface UserInfo {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  email_verified: boolean;
  is_active: boolean;
  user_role: string;
  subscription_expires_at?: string;
  created_at: string;
  last_login_at?: string;
}

interface SystemStats {
  total_users: number;
  users_by_role: Record<string, number>;
  active_today: number;
  questions_today: number;
  new_users_7d: number;
  expiring_subscriptions_7d: number;
}

interface TierConfig {
  tier_name: string;
  max_questions_per_day: number;
  can_create_projects: boolean;
  can_use_offline_llm: boolean;
  can_use_tools: boolean;
  subscription_duration_days?: number;
  description?: string;
}

type Tab = 'stats' | 'users' | 'tiers';

const ROLE_ICONS: Record<string, React.ReactNode> = {
  free: <User className="w-4 h-4" />,
  pro: <Star className="w-4 h-4" />,
  max: <Zap className="w-4 h-4" />,
  admin: <Crown className="w-4 h-4" />,
};

const ROLE_COLORS: Record<string, string> = {
  free: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
  pro: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  max: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  admin: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
};

export default function AdminPanel() {
  const { user, token } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('stats');
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [tiers, setTiers] = useState<TierConfig[]>([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingTier, setEditingTier] = useState<string | null>(null);
  const [tierEdits, setTierEdits] = useState<Partial<TierConfig>>({});
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Check admin access
  useEffect(() => {
    if (user && isModernUser(user) && user.user_role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v2/admin/stats`, { headers });
      if (res.ok) setStats(await res.json());
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  }, [token]);

  // Fetch users
  const fetchUsers = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: '15' });
      if (searchQuery) params.set('search', searchQuery);
      if (roleFilter) params.set('role', roleFilter);

      const res = await fetch(`${API_BASE}/v2/admin/users?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
        setTotalUsers(data.total);
        setTotalPages(data.pages);
        setCurrentPage(data.page);
      }
    } catch (e) {
      console.error('Failed to fetch users:', e);
    } finally {
      setLoading(false);
    }
  }, [token, searchQuery, roleFilter]);

  // Fetch tiers
  const fetchTiers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v2/admin/tiers`, { headers });
      if (res.ok) setTiers(await res.json());
    } catch (e) {
      console.error('Failed to fetch tiers:', e);
    }
  }, [token]);

  // Load data when tab changes
  useEffect(() => {
    if (activeTab === 'stats') fetchStats();
    if (activeTab === 'users') fetchUsers(1);
    if (activeTab === 'tiers') fetchTiers();
  }, [activeTab]);

  // Refetch users on filter change
  useEffect(() => {
    if (activeTab === 'users') {
      const debounce = setTimeout(() => fetchUsers(1), 300);
      return () => clearTimeout(debounce);
    }
  }, [searchQuery, roleFilter]);

  // Change user role
  const handleRoleChange = async (userId: string, newRole: string, subDays?: number) => {
    try {
      const body: any = { user_role: newRole };
      if (subDays) body.subscription_days = subDays;

      const res = await fetch(`${API_BASE}/v2/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setChangingRole(null);
        fetchUsers(currentPage);
        fetchStats();
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to update role');
      }
    } catch (e) {
      console.error('Failed to change role:', e);
    }
  };

  // Toggle user active
  const handleToggleActive = async (userId: string) => {
    try {
      const res = await fetch(`${API_BASE}/v2/admin/users/${userId}/active`, {
        method: 'PATCH',
        headers,
      });

      if (res.ok) {
        fetchUsers(currentPage);
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to toggle user');
      }
    } catch (e) {
      console.error('Failed to toggle active:', e);
    }
  };

  // Update tier config
  const handleTierSave = async (tierName: string) => {
    try {
      const res = await fetch(`${API_BASE}/v2/admin/tiers/${tierName}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(tierEdits),
      });

      if (res.ok) {
        setEditingTier(null);
        setTierEdits({});
        fetchTiers();
      } else {
        const err = await res.json();
        alert(err.detail || 'Failed to update tier');
      }
    } catch (e) {
      console.error('Failed to update tier:', e);
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'stats', label: 'Dashboard', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'users', label: 'Users', icon: <Users className="w-4 h-4" /> },
    { id: 'tiers', label: 'Tiers', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-black text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-black/40 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="p-2 hover:bg-white/10 rounded-lg transition"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <Shield className="w-6 h-6 text-amber-400" />
            <h1 className="text-lg font-bold">Admin Panel</h1>
          </div>
          <div className="flex gap-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                  activeTab === tab.id
                    ? 'bg-white/15 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Stats Dashboard */}
        {activeTab === 'stats' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">System Overview</h2>
              <button onClick={fetchStats} className="p-2 hover:bg-white/10 rounded-lg transition">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {stats ? (
              <>
                {/* Stat Cards */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <StatCard label="Total Users" value={stats.total_users} color="blue" />
                  <StatCard label="Active Today" value={stats.active_today} color="emerald" />
                  <StatCard label="Questions Today" value={stats.questions_today} color="purple" />
                  <StatCard label="New (7 days)" value={stats.new_users_7d} color="cyan" />
                  <StatCard label="Expiring Subs" value={stats.expiring_subscriptions_7d} color="amber" />
                </div>

                {/* Role Distribution */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-5">
                  <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">Users by Tier</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {['free', 'pro', 'max', 'admin'].map(role => (
                      <div key={role} className={`rounded-lg p-3 border ${ROLE_COLORS[role]}`}>
                        <div className="flex items-center gap-2 mb-1">
                          {ROLE_ICONS[role]}
                          <span className="capitalize font-medium">{role}</span>
                        </div>
                        <div className="text-2xl font-bold">
                          {stats.users_by_role[role] || 0}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-center py-12 text-gray-500">Loading stats...</div>
            )}
          </div>
        )}

        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            {/* Search + Filter */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search by email or name..."
                  className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <select
                value={roleFilter}
                onChange={e => setRoleFilter(e.target.value)}
                className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
              >
                <option value="">All roles</option>
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="max">Max</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {/* Users Table */}
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-gray-400 text-left">
                      <th className="px-4 py-3 font-medium">User</th>
                      <th className="px-4 py-3 font-medium hidden md:table-cell">Status</th>
                      <th className="px-4 py-3 font-medium">Role</th>
                      <th className="px-4 py-3 font-medium hidden lg:table-cell">Joined</th>
                      <th className="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {loading ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-500">Loading...</td>
                      </tr>
                    ) : users.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-500">No users found</td>
                      </tr>
                    ) : users.map(u => (
                      <tr key={u.id} className="hover:bg-white/5 transition">
                        <td className="px-4 py-3">
                          <div>
                            <div className="text-white font-medium">
                              {u.display_name || `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email}
                            </div>
                            <div className="text-xs text-gray-500">{u.email}</div>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <div className="flex items-center gap-2">
                            {u.is_active ? (
                              <span className="flex items-center gap-1 text-emerald-400 text-xs">
                                <UserCheck className="w-3 h-3" /> Active
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-red-400 text-xs">
                                <UserX className="w-3 h-3" /> Disabled
                              </span>
                            )}
                            {!u.email_verified && (
                              <span className="text-amber-400 text-xs">Unverified</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {changingRole === u.id ? (
                            <div className="flex flex-col gap-1">
                              {['free', 'pro', 'max', 'admin'].map(role => (
                                <button
                                  key={role}
                                  onClick={() => handleRoleChange(u.id, role, role === 'pro' || role === 'max' ? 30 : undefined)}
                                  className={`text-xs px-2 py-1 rounded border ${
                                    u.user_role === role ? 'opacity-50 cursor-default' : 'hover:bg-white/10'
                                  } ${ROLE_COLORS[role]}`}
                                  disabled={u.user_role === role}
                                >
                                  {role}
                                </button>
                              ))}
                              <button
                                onClick={() => setChangingRole(null)}
                                className="text-xs text-gray-500 hover:text-white mt-1"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border ${ROLE_COLORS[u.user_role]}`}>
                              {ROLE_ICONS[u.user_role]}
                              <span className="capitalize">{u.user_role}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden lg:table-cell text-xs text-gray-500">
                          {new Date(u.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => setChangingRole(changingRole === u.id ? null : u.id)}
                              className="p-1.5 hover:bg-white/10 rounded-lg transition text-gray-400 hover:text-white"
                              title="Change role"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(u.id)}
                              className={`p-1.5 hover:bg-white/10 rounded-lg transition ${
                                u.is_active ? 'text-gray-400 hover:text-red-400' : 'text-red-400 hover:text-emerald-400'
                              }`}
                              title={u.is_active ? 'Disable user' : 'Enable user'}
                            >
                              {u.is_active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
                  <span className="text-xs text-gray-500">{totalUsers} users total</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => fetchUsers(currentPage - 1)}
                      disabled={currentPage <= 1}
                      className="px-3 py-1 text-xs rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 transition"
                    >
                      Prev
                    </button>
                    <span className="px-3 py-1 text-xs text-gray-400">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      onClick={() => fetchUsers(currentPage + 1)}
                      disabled={currentPage >= totalPages}
                      className="px-3 py-1 text-xs rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-30 transition"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tiers Tab */}
        {activeTab === 'tiers' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold">Tier Configuration</h2>
              <button onClick={fetchTiers} className="p-2 hover:bg-white/10 rounded-lg transition">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            <div className="grid gap-4">
              {tiers.map(tier => (
                <div key={tier.tier_name} className={`rounded-xl p-5 border ${ROLE_COLORS[tier.tier_name] || 'border-white/10 bg-white/5'}`}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      {ROLE_ICONS[tier.tier_name]}
                      <h3 className="text-lg font-bold capitalize">{tier.tier_name}</h3>
                    </div>
                    {editingTier === tier.tier_name ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleTierSave(tier.tier_name)}
                          className="p-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 rounded-lg transition"
                        >
                          <Check className="w-4 h-4 text-emerald-400" />
                        </button>
                        <button
                          onClick={() => { setEditingTier(null); setTierEdits({}); }}
                          className="p-1.5 bg-red-500/20 hover:bg-red-500/30 rounded-lg transition"
                        >
                          <X className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingTier(tier.tier_name); setTierEdits({}); }}
                        className="p-1.5 hover:bg-white/10 rounded-lg transition"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <TierField
                      label="Questions/Day"
                      value={tier.max_questions_per_day}
                      editing={editingTier === tier.tier_name}
                      type="number"
                      onChange={v => setTierEdits(prev => ({ ...prev, max_questions_per_day: Number(v) }))}
                    />
                    <TierField
                      label="Projects"
                      value={tier.can_create_projects ? 'Yes' : 'No'}
                      editing={editingTier === tier.tier_name}
                      type="toggle"
                      checked={tierEdits.can_create_projects ?? tier.can_create_projects}
                      onChange={v => setTierEdits(prev => ({ ...prev, can_create_projects: v === 'true' }))}
                    />
                    <TierField
                      label="Tools"
                      value={tier.can_use_tools ? 'Yes' : 'No'}
                      editing={editingTier === tier.tier_name}
                      type="toggle"
                      checked={tierEdits.can_use_tools ?? tier.can_use_tools}
                      onChange={v => setTierEdits(prev => ({ ...prev, can_use_tools: v === 'true' }))}
                    />
                    <TierField
                      label="Sub Duration"
                      value={tier.subscription_duration_days ? `${tier.subscription_duration_days}d` : 'Unlimited'}
                      editing={editingTier === tier.tier_name}
                      type="number"
                      onChange={v => setTierEdits(prev => ({ ...prev, subscription_duration_days: Number(v) || undefined }))}
                    />
                  </div>

                  {tier.description && (
                    <p className="mt-3 text-xs text-gray-500">{tier.description}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Stat card component
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'from-blue-500/10 to-blue-500/5 border-blue-500/20 text-blue-400',
    emerald: 'from-emerald-500/10 to-emerald-500/5 border-emerald-500/20 text-emerald-400',
    purple: 'from-purple-500/10 to-purple-500/5 border-purple-500/20 text-purple-400',
    cyan: 'from-cyan-500/10 to-cyan-500/5 border-cyan-500/20 text-cyan-400',
    amber: 'from-amber-500/10 to-amber-500/5 border-amber-500/20 text-amber-400',
  };

  return (
    <div className={`rounded-xl p-4 bg-gradient-to-br border ${colorMap[color]}`}>
      <div className="text-xs font-medium text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold">{value.toLocaleString()}</div>
    </div>
  );
}

// Tier field component for inline editing
function TierField({
  label, value, editing, type, checked, onChange
}: {
  label: string;
  value: string | number;
  editing: boolean;
  type: 'number' | 'toggle';
  checked?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      {editing ? (
        type === 'toggle' ? (
          <button
            onClick={() => onChange(String(!checked))}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
              checked
                ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400'
                : 'bg-red-500/20 border-red-500/30 text-red-400'
            }`}
          >
            {checked ? 'Enabled' : 'Disabled'}
          </button>
        ) : (
          <input
            type="number"
            defaultValue={value}
            onChange={e => onChange(e.target.value)}
            className="w-full px-2 py-1 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
          />
        )
      ) : (
        <div className="text-white font-medium">{value}</div>
      )}
    </div>
  );
}
