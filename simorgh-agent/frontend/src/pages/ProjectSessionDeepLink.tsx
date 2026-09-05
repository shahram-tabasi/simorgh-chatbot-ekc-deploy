/**
 * ProjectSessionDeepLink
 * ======================
 * Resolves /chatbot/project/session_<token> URLs.
 *
 * Hits GET /api/v2/chatbot/project/sessions/{token} to fetch the session +
 * its project, then navigates to the main chat view with that project +
 * session preloaded. If the session does not exist or the user lacks
 * access we redirect to "/".
 */
import React, { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import axios from 'axios';
import { Loader } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SessionResponse {
  id: string;
  project_id: string;
  session_token: string;
  title: string | null;
  stage: string;
  is_active: boolean;
  deep_link: string;
}

export default function ProjectSessionDeepLink() {
  const { sessionToken } = useParams<{ sessionToken: string }>();
  const [state, setState] = useState<'loading' | 'ready' | 'not_found'>('loading');
  const [session, setSession] = useState<SessionResponse | null>(null);

  useEffect(() => {
    if (!sessionToken) {
      setState('not_found');
      return;
    }
    (async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        const r = await axios.get(`${API_BASE}/v2/chatbot/project/sessions/${sessionToken}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setSession(r.data);
        // Stash for the main chat to pick up.
        sessionStorage.setItem('simorgh_pending_session', JSON.stringify(r.data));
        setState('ready');
      } catch {
        setState('not_found');
      }
    })();
  }, [sessionToken]);

  if (state === 'loading') {
    return (
      <div className="w-full h-screen flex items-center justify-center bg-black text-white">
        <div className="flex items-center gap-3">
          <Loader className="w-6 h-6 animate-spin" />
          <span>Opening project session...</span>
        </div>
      </div>
    );
  }

  if (state === 'not_found' || !session) {
    return <Navigate to="/" replace />;
  }

  // Hand off to the main chat view; it reads simorgh_pending_session.
  return <Navigate to={`/?project=${session.project_id}&session=${session.session_token}`} replace />;
}
