/**
 * CreateProjectWizard
 * ===================
 * New project-creation flow (replaces CreateProjectModal / CreateAgentProjectModal
 * for both legacy and modern users in the new container-backed world).
 *
 * Steps:
 *  1. Name + description
 *  2. (Optional) Pick GitLab repo from the user's own GitLab account
 *  3. (Optional) Pick a branch from that repo
 *  4. Source ticks:
 *       - tpms          (legacy users only; requires tpms auth, see step 5)
 *       - techserver    (legacy users only; requires tpms auth + OE number)
 *       - ekc-knowledge (always available; read-only clone)
 *       - upload        (always on; the catch-all working dir)
 *  5. If tpms/techserver ticked → prompt for the technical OE number +
 *     TPMS credentials (only here, not at project-creation entry).
 *
 * On submit the wizard POSTs to /api/v2/agent/projects (project-agent-service)
 * with the new `sources_enabled` + gitlab fields, then waits for project-init
 * to finish via /api/v2/agent/projects/{id}/init-status.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Loader, CheckCircle, AlertCircle, GitBranch, FolderGit2, Database, BookOpen, Upload, Server, KeyRound } from 'lucide-react';
import axios from 'axios';
import { useAuth, isLegacyUser } from '../context/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (projectId: string, sessionToken: string, deepLink: string) => void;
}

interface GitlabRepo {
  id: number;
  path: string;
  name: string;
  default_branch: string | null;
  web_url: string;
  ssh_url: string | null;
  http_url: string | null;
}

interface GitlabBranch {
  name: string;
  default: boolean;
  protected: boolean;
}

interface Sources {
  gitlab: boolean;
  tpms: boolean;
  techserver: boolean;
  techserver_oenum: string;
  ekc: boolean;
  upload: boolean;
}

const emptySources = (): Sources => ({
  gitlab: false,
  tpms: false,
  techserver: false,
  techserver_oenum: '',
  ekc: false,
  upload: true,
});

/** Map a raw backend / network error to a friendly Persian message.
 *  Falls back to a generic line so we never surface backend jargon
 *  (e.g. `role_category 'None' is not permitted ...`) to the user. */
function humanizeProjectError(e: any): string {
  const detail: string =
    (e?.response?.data?.detail && String(e.response.data.detail)) ||
    (e?.message && String(e.message)) ||
    '';
  const status: number | undefined = e?.response?.status;
  const lower = detail.toLowerCase();

  // Permission / role gate (the exact case shown to the operator).
  if (
    lower.includes('role_category') ||
    lower.includes('not permitted') ||
    lower.includes('expert_technical') ||
    status === 403
  ) {
    return 'حساب شما اجازه ساخت پروژه را ندارد. ساخت پروژه فقط برای کارشناسان فنی فعال است — لطفاً با مدیر سیستم تماس بگیرید.';
  }
  if (status === 401) {
    return 'نشست شما منقضی شده است. لطفاً دوباره وارد شوید.';
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('duplicate')) {
    return 'پروژه‌ای با همین نام از قبل وجود دارد. لطفاً نام دیگری انتخاب کنید.';
  }
  if (status === 400 || lower.includes('invalid') || lower.includes('required')) {
    return 'اطلاعات وارد شده کامل یا معتبر نیست. لطفاً فیلدها را بررسی و دوباره تلاش کنید.';
  }
  if (status === 404 || lower.includes('not found')) {
    return 'منبع درخواست‌شده پیدا نشد. اگر مخزن گیت‌لب انتخاب کرده‌اید، توکن و دسترسی را بررسی کنید.';
  }
  if (status === 502 || status === 503 || status === 504 || lower.includes('timeout') || lower.includes('network')) {
    return 'ارتباط با سرور برقرار نشد. لطفاً چند لحظه دیگر دوباره تلاش کنید.';
  }
  return 'متأسفانه ساخت پروژه با خطا مواجه شد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.';
}

export default function CreateProjectWizard({ isOpen, onClose, onCreated }: Props) {
  const { user } = useAuth();
  const isLegacy = user ? isLegacyUser(user) : false;

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [userGitlabToken, setUserGitlabToken] = useState('');
  const [repos, setRepos] = useState<GitlabRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState('');
  const [accessInstructions, setAccessInstructions] = useState<{title: string; steps: string[]; public_key: string} | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<GitlabRepo | null>(null);
  const [branches, setBranches] = useState<GitlabBranch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [sources, setSources] = useState<Sources>(emptySources());
  const [tpmsCreds, setTpmsCreds] = useState({ user: '', pass: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const needsTpmsAuth = sources.tpms || sources.techserver;

  const reset = useCallback(() => {
    setName('');
    setDescription('');
    setUserGitlabToken('');
    setRepos([]);
    setReposError('');
    setAccessInstructions(null);
    setSelectedRepo(null);
    setBranches([]);
    setSelectedBranch('');
    setSources(emptySources());
    setTpmsCreds({ user: '', pass: '' });
    setSubmitting(false);
    setError('');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Load the user's GitLab repos once they provide a token.
  const loadRepos = useCallback(async () => {
    if (!userGitlabToken) return;
    setReposLoading(true);
    setReposError('');
    try {
      const token = localStorage.getItem('simorgh_token');
      const r = await axios.get(`${API_BASE}/gitlab/user-projects`, {
        params: { per_page: 100 },
        headers: {
          Authorization: `Bearer ${token}`,
          'X-User-Gitlab-Token': userGitlabToken,
        },
      });
      const list = r.data || [];
      setRepos(list);
      if (list.length === 0) {
        setReposError('هیچ مخزنی برای این توکن گیت‌لب پیدا نشد.');
      } else {
        // Default to the first real repo (not "No repository") when the
        // user has repos — they clicked "List repos" because they want one.
        setSelectedRepo((prev) => prev || list[0]);
      }
    } catch (e: any) {
      setReposError(humanizeProjectError(e));
      // Pull access instructions to show the user how to grant access.
      try {
        const r2 = await axios.get(`${API_BASE}/gitlab/access-instructions`);
        setAccessInstructions(r2.data);
      } catch {}
    } finally {
      setReposLoading(false);
    }
  }, [userGitlabToken]);

  // Load branches when a repo is selected.
  useEffect(() => {
    if (!selectedRepo) {
      setBranches([]);
      setSelectedBranch('');
      return;
    }
    let cancelled = false;
    (async () => {
      setBranchesLoading(true);
      try {
        const token = localStorage.getItem('simorgh_token');
        const r = await axios.get(`${API_BASE}/gitlab/branches`, {
          params: { project: selectedRepo.path, per_page: 100 },
          headers: {
            Authorization: `Bearer ${token}`,
            // The repos are the user's PRIVATE projects; the branches
            // endpoint needs the user's GitLab token to see them.
            ...(userGitlabToken ? { 'X-User-Gitlab-Token': userGitlabToken } : {}),
          },
        });
        if (cancelled) return;
        setBranches(r.data || []);
        const def = (r.data || []).find((b: GitlabBranch) => b.default);
        setSelectedBranch(def?.name || selectedRepo.default_branch || (r.data?.[0]?.name) || 'main');
      } catch {
        if (!cancelled) setBranches([]);
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedRepo, userGitlabToken]);

  const handleSubmit = useCallback(async () => {
    setError('');
    if (!name.trim()) {
      setError('Project name is required.');
      return;
    }
    if (needsTpmsAuth && (!tpmsCreds.user || !tpmsCreds.pass)) {
      setError('TPMS credentials are required because you ticked TPMS or techserver.');
      return;
    }
    // Both `tpms` and `techserver` need an OE number — the backend
    // rejects with a 400 otherwise, which surfaces in the UI as the
    // generic "invalid data" Farsi error and confuses the user.
    if ((sources.tpms || sources.techserver) && !sources.techserver_oenum.trim()) {
      setError('OE number is required for the TPMS / techserver sources.');
      return;
    }

    setSubmitting(true);
    try {
      const token = localStorage.getItem('simorgh_token');
      // Build the payload. Backend should accept these new fields on
      // /api/v2/agent/projects; until it's updated, the unknown fields
      // are simply ignored.
      const payload: any = {
        name: name.trim(),
        description: description.trim() || null,
        gitlab_repo_path: selectedRepo?.path || null,
        gitlab_repo_url: selectedRepo?.http_url || selectedRepo?.ssh_url || null,
        gitlab_base_branch: selectedRepo ? selectedBranch : null,
        // The user's GitLab token, forwarded ONLY so the container can clone
        // a PRIVATE repo (used once at clone time; not stored on the project).
        gitlab_user_token: selectedRepo ? (userGitlabToken || null) : null,
        sources: {
          gitlab: !!selectedRepo,
          tpms: sources.tpms,
          techserver: sources.techserver,
          techserver_oenum: sources.techserver_oenum.trim() || null,
          ekc: sources.ekc,
          upload: true,
        },
      };
      if (needsTpmsAuth) {
        payload.tpms_auth = { user: tpmsCreds.user, pass: tpmsCreds.pass };
      }

      const r = await axios.post(`${API_BASE}/v2/agent/projects`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const projectId = r.data.project_id || r.data.id;

      // Create the chat session immediately so we can deep-link.
      const sess = await axios.post(`${API_BASE}/v2/chatbot/project/sessions`, {
        project_id: projectId,
        title: name.trim(),
        stage: 'general',
      }, { headers: { Authorization: `Bearer ${token}` } });

      onCreated(projectId, sess.data.session_token, sess.data.deep_link);
      handleClose();
    } catch (e: any) {
      setError(humanizeProjectError(e));
    } finally {
      setSubmitting(false);
    }
  }, [name, description, selectedRepo, selectedBranch, sources, needsTpmsAuth, tpmsCreds, onCreated, handleClose]);

  if (!isOpen) return null;

  return (
    <>
      <motion.div initial={{opacity: 0}} animate={{opacity: 1}} exit={{opacity: 0}}
        onClick={handleClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50" />
      <motion.div initial={{scale: 0.95, opacity: 0}} animate={{scale: 1, opacity: 1}}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-2xl p-8 pointer-events-auto max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Plus className="w-7 h-7 text-emerald-400" />
              New Project
            </h2>
            <button onClick={handleClose} className="p-2 hover:bg-white/10 rounded-lg transition">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>

          <div className="space-y-5">
            {/* Name + description */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Project name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Compressor station retrofit"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Description (optional)</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition" />
            </div>

            {/* GitLab repo picker */}
            <div className="rounded-xl border border-white/10 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <FolderGit2 className="w-5 h-5 text-blue-300" />
                <h3 className="text-white font-semibold">Pick a GitLab repository (optional)</h3>
              </div>
              <p className="text-xs text-gray-400">
                If you select your own repository the chatbot will clone it into the project
                container, create a working branch <code className="text-emerald-300">simorgh/&lt;hex&gt;</code>,
                and push changes back. If you skip this, you can still upload documents directly.
              </p>

              <div className="flex gap-2">
                <input type="password" value={userGitlabToken} onChange={(e) => setUserGitlabToken(e.target.value)}
                  placeholder="Your GitLab personal access token (read_api)"
                  className="flex-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:border-emerald-500" />
                <button onClick={loadRepos} disabled={!userGitlabToken || reposLoading}
                  className="px-4 py-2 bg-blue-500/20 border border-blue-400/30 rounded-lg text-blue-200 text-sm hover:bg-blue-500/30 transition disabled:opacity-50">
                  {reposLoading ? <Loader className="w-4 h-4 animate-spin" /> : 'List repos'}
                </button>
              </div>

              {reposError && (
                <div className="text-sm text-red-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{reposError}</span>
                </div>
              )}

              {accessInstructions && (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-yellow-200 font-semibold">{accessInstructions.title}</p>
                  <ol className="list-decimal pl-4 text-yellow-100/80 space-y-0.5">
                    {accessInstructions.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                  <pre className="bg-black/40 text-emerald-200 p-2 rounded mt-2 whitespace-pre-wrap break-all">{accessInstructions.public_key}</pre>
                </div>
              )}

              {repos.length > 0 && (
                <div className="space-y-2">
                  <select value={selectedRepo?.path || ''}
                    onChange={(e) => setSelectedRepo(repos.find(r => r.path === e.target.value) || null)}
                    className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500 [&>option]:bg-gray-900 [&>option]:text-white">
                    <option value="" className="bg-gray-900 text-gray-300">— No repository (continue without) —</option>
                    {repos.map(r => (
                      <option key={r.id} value={r.path} className="bg-gray-900 text-white">{r.path}</option>
                    ))}
                  </select>

                  {selectedRepo && (
                    <div className="flex items-center gap-2">
                      <GitBranch className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <select value={selectedBranch} onChange={(e) => setSelectedBranch(e.target.value)}
                        disabled={branchesLoading}
                        className="flex-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm focus:outline-none focus:border-emerald-500 [&>option]:bg-gray-900 [&>option]:text-white">
                        {branches.length === 0 && (
                          <option value="" className="bg-gray-900 text-gray-300">
                            {branchesLoading ? 'Loading branches...' : 'No branches found'}
                          </option>
                        )}
                        {branches.map(b => (
                          <option key={b.name} value={b.name} className="bg-gray-900 text-white">
                            {b.name}{b.default ? ' (default)' : ''}{b.protected ? ' (protected)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Source ticks */}
            <div className="rounded-xl border border-white/10 p-4 space-y-3">
              <h3 className="text-white font-semibold">Sources to include</h3>
              <p className="text-xs text-gray-400">
                These determine what the project container is seeded with on creation.
              </p>

              {/* Legacy-only: TPMS + Techserver */}
              {isLegacy && (
                <>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={sources.tpms}
                      onChange={(e) => setSources({...sources, tpms: e.target.checked})}
                      className="mt-1" />
                    <span className="flex-1">
                      <span className="text-white text-sm flex items-center gap-2"><Database className="w-4 h-4" /> TPMS project data</span>
                      <span className="block text-xs text-gray-400">Stage rendered TPMS context into the container's /work/tpms/ dir.</span>
                    </span>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={sources.techserver}
                      onChange={(e) => setSources({...sources, techserver: e.target.checked})}
                      className="mt-1" />
                    <span className="flex-1">
                      <span className="text-white text-sm flex items-center gap-2"><Server className="w-4 h-4" /> Techserver per-OE copy</span>
                      <span className="block text-xs text-gray-400">SMB-copy <code>//192.168.1.3/techser/&lt;oe&gt;</code> into /work/techserver/.</span>
                    </span>
                  </label>

                  {/* OE-number input — required by BOTH the TPMS and
                      techserver pulls. The field name `techserver_oenum`
                      is historical; the backend treats it as the project's
                      OE for any per-OE source. */}
                  {(sources.tpms || sources.techserver) && (
                    <input type="text" value={sources.techserver_oenum}
                      onChange={(e) => setSources({...sources, techserver_oenum: e.target.value})}
                      placeholder="OE number (e.g. 12345) — used for TPMS and/or techserver"
                      className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm" />
                  )}
                </>
              )}

              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={sources.ekc}
                  onChange={(e) => setSources({...sources, ekc: e.target.checked})}
                  className="mt-1" />
                <span className="flex-1">
                  <span className="text-white text-sm flex items-center gap-2"><BookOpen className="w-4 h-4" /> ekc-technical-knowledge</span>
                  <span className="block text-xs text-gray-400">Clone the read-only company technical-knowledge repo into /work/ekc-knowledge/. Without this, the chatbot is grounded only by your selected repo.</span>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-not-allowed opacity-90">
                <input type="checkbox" checked={true} disabled className="mt-1" />
                <span className="flex-1">
                  <span className="text-white text-sm flex items-center gap-2"><Upload className="w-4 h-4" /> Document uploads</span>
                  <span className="block text-xs text-gray-400">Always on. Files you upload during the chat land in /work/uploads/.</span>
                </span>
              </label>
            </div>

            {/* TPMS credentials (only when needed) */}
            {needsTpmsAuth && (
              <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-5 h-5 text-yellow-300" />
                  <h3 className="text-yellow-100 font-semibold">TPMS authentication</h3>
                </div>
                <p className="text-xs text-yellow-200/80">
                  Required because you selected a TPMS-backed source. These credentials are
                  used by the project-init service to pull data and are not stored long-term.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" value={tpmsCreds.user}
                    onChange={(e) => setTpmsCreds({...tpmsCreds, user: e.target.value})}
                    placeholder="TPMS user"
                    className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm" />
                  <input type="password" value={tpmsCreds.pass}
                    onChange={(e) => setTpmsCreds({...tpmsCreds, pass: e.target.value})}
                    placeholder="TPMS password"
                    className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white text-sm" />
                </div>
              </div>
            )}

            {error && (
              <div
                className="flex items-start gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl"
                dir="rtl"
              >
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-200 leading-6">{error}</p>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={handleSubmit} disabled={submitting || !name.trim()}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                {submitting ? <><Loader className="w-5 h-5 animate-spin" /> Creating...</> : <><CheckCircle className="w-5 h-5" /> Create Project</>}
              </button>
              <button onClick={handleClose} disabled={submitting}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}
