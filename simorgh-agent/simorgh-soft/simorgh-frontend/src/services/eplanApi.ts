// src/services/eplanApi.ts
//
// Sending a project to the EPLAN server.
//
// The EPLAN machine speaks on one IP and one port. The browser does not talk
// to it directly — it posts to this app's own backend, which forwards the
// records on. That keeps the address out of the bundle (it is read from the
// backend's .env, so changing it is an edit and a restart, not a rebuild) and
// keeps the EPLAN host off the browser's cross-origin path.
//
// The address can still be overridden per request from the dialog, which is
// what the "Target" fields in the Eplanix tab do.
import { EplanData } from '../utils/eplanDataExport';

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

export interface EplanTarget {
  host: string;
  port: number;
  path: string;
  /** The full URL the backend would post to — what the dialog shows. */
  url: string;
  /** False when the backend has no address configured at all. */
  configured: boolean;
}

export interface EplanSendResult {
  success: boolean;
  status?: string;
  jobId?: string;
  message?: string;
  target?: string;
  records?: number;
  response?: any;
  error?: string;
}

export const eplanApi = {
  /** Where the backend is configured to send — host, port and endpoint. */
  async getTarget(): Promise<EplanTarget> {
    const response = await fetch(`${API_BASE_URL}/eplan/target`);
    if (!response.ok) throw new Error('Could not read the EPLAN target from the server');
    return response.json();
  },

  /** Is the EPLAN server answering on that address right now? */
  async ping(override?: { host?: string; port?: number }): Promise<{ reachable: boolean; target: string; error?: string }> {
    const response = await fetch(`${API_BASE_URL}/eplan/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(override ?? {}),
    });
    return response.json();
  },

  /** Post the records. `host`/`port` override the backend's configured ones. */
  async send(payload: {
    projectName: string;
    data: EplanData[];
    host?: string;
    port?: number;
    userName?: string;
  }): Promise<EplanSendResult> {
    const response = await fetch(`${API_BASE_URL}/eplan/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, error: body.error || `EPLAN server refused the request (${response.status})` };
    }
    return body;
  },
};
