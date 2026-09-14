// src/services/eplanApi.ts
//
// Sending a project to EPLAN.
//
// The browser never talks to EPLAN, or even to the bridge, directly: it
// posts to this app's own backend, which forwards to eplan-bridge-service —
// the piece that actually holds the TCP connection to EPLAN's listener and
// picks a port from the pool. There is no host/port for the user to type in
// any more: which EPLAN instance a send lands on is entirely the bridge's
// concern, the same way an interactive Eplanix user never sees it either.
import { EplanData } from '../utils/eplanDataExport';

const API_BASE_URL = `${import.meta.env.VITE_API_URL || ''}/api`;

export interface EplanTarget {
  /** The bridge's own address, for display only — nothing here is editable. */
  url: string;
  authenticated: boolean;
}

/** One project EPLAN wrote, ready to be downloaded. */
export interface EplanProject {
  /** 'sld' (single line) or 'old' (outline) — a send can produce both. */
  type: 'sld' | 'old';
  displayName: string;
  /** The OE share it landed on, e.g. "OE12112". */
  oenum: string;
  /** Path to the .elk inside that share. */
  path: string;
  fileName: string;
}

export interface EplanSendResult {
  success: boolean;
  status?: string;
  jobId?: string;
  message?: string;
  records?: number;
  error?: string;
  /** What EPLAN produced. Empty when the send failed, or when EPLAN
   *  answered with a path this app could not make sense of. */
  projects?: EplanProject[];
}

export const eplanApi = {
  /** Where the backend is configured to send. */
  async getTarget(): Promise<EplanTarget> {
    const response = await fetch(`${API_BASE_URL}/eplan/target`);
    if (!response.ok) throw new Error('Could not read the EPLAN target from the server');
    return response.json();
  },

  /** Is an EPLAN instance currently available to draw with? */
  async ping(userName?: string): Promise<{ reachable: boolean; target?: string; error?: string }> {
    const response = await fetch(`${API_BASE_URL}/eplan/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userName ? { userName } : {}),
    });
    return response.json();
  },

  /** Post the records. */
  async send(payload: {
    projectName: string;
    data: EplanData[];
    userName?: string;
  }): Promise<EplanSendResult> {
    const response = await fetch(`${API_BASE_URL}/eplan/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { success: false, error: body.error || `EPLAN bridge refused the request (${response.status})` };
    }
    return body;
  },

  /** A download URL for one of the files EPLAN produced.
   *
   *  Given to the browser as a plain link rather than fetched here: these are
   *  large (a project archive runs to hundreds of megabytes), and letting the
   *  browser stream one to disk keeps it out of this tab's memory entirely
   *  and gives the user the normal download UI, progress and all.
   */
  downloadUrl(project: EplanProject, kind: 'pdf' | 'zip'): string {
    const query = new URLSearchParams({ oenum: project.oenum, path: project.path });
    return `${API_BASE_URL}/eplan/${kind}?${query.toString()}`;
  },
};
