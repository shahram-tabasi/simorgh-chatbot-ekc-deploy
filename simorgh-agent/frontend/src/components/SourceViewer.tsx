/**
 * SourceViewer — modal that shows the source document page a proposal value
 * was extracted from, with a rectangle drawn around the extracted region.
 *
 * Fetches GET /soft/proposals/{id}/source which returns a rendered PNG of the
 * page plus bounding rectangles (in image-pixel coordinates). We render the
 * image responsively and overlay the rectangles as percentage-positioned
 * boxes so they track the image at any display size.
 *
 * When the backend can't box the value (image-only / scanned page, or the
 * evidence span was paraphrased) it still returns the page image with
 * `matched=false` — we show the page and a small "couldn't pinpoint" note
 * instead of an empty modal.
 */
import React from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, FileWarning, Crosshair, Quote } from "lucide-react";

export interface SourceTarget {
  proposalId: string;
  field:      string;
  label?:     string;   // human field label for the header
}

interface SourceResp {
  ok:         boolean;
  reason?:    string;
  matched?:   boolean;
  page?:      number;
  page_count?: number;
  image_b64?: string;
  image_w?:   number;
  image_h?:   number;
  rects?:     number[][];   // [[x0,y0,x1,y1], ...] in image pixels
  filename?:  string;
  section?:   string;
  evidence?:  string;
}

interface Props {
  open:       boolean;
  target:     SourceTarget | null;
  projectId:  string;
  apiBase:    string;
  getToken:   () => string;
  onClose:    () => void;
}

export default function SourceViewer({
  open, target, projectId, apiBase, getToken, onClose,
}: Props) {
  const [loading, setLoading] = React.useState(false);
  const [data, setData]       = React.useState<SourceResp | null>(null);
  const [err, setErr]         = React.useState("");

  React.useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setLoading(true); setErr(""); setData(null);
    axios.get<SourceResp>(
      `${apiBase}/v2/agent/projects/${projectId}/soft/proposals/${target.proposalId}/source`,
      { headers: { Authorization: `Bearer ${getToken()}` } },
    )
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => {
        if (cancelled) return;
        setErr(e?.response?.data?.detail || e?.message || "Could not load source.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, target, projectId, apiBase, getToken]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const w = data?.image_w || 1;
  const h = data?.image_h || 1;

  return (
    <AnimatePresence>
      {open && target && (
        <>
          <motion.div
            key="sv-bd"
            className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            key="sv-pn"
            className="fixed inset-0 z-[91] flex items-center justify-center p-4 pointer-events-none"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
          >
            <div className="pointer-events-auto w-full max-w-4xl max-h-[90vh] flex flex-col
                            rounded-2xl border border-white/10 bg-[#0f172a]/95 backdrop-blur-xl
                            shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="px-5 py-3 border-b border-white/10 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500
                                flex items-center justify-center flex-shrink-0">
                  <Crosshair className="w-4 h-4 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold text-sm truncate">
                    Source for {target.label || target.field}
                  </div>
                  <div className="text-[11px] text-gray-400 truncate">
                    {data?.filename || "source document"}
                    {data?.page ? ` · page ${data.page}${data.page_count ? ` / ${data.page_count}` : ""}` : ""}
                    {data?.section ? ` · § ${data.section}` : ""}
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-auto p-4 bg-black/20">
                {loading && (
                  <div className="h-64 flex items-center justify-center text-gray-400 text-sm gap-2">
                    <Loader2 className="w-5 h-5 animate-spin" /> Loading source page…
                  </div>
                )}

                {!loading && (err || (data && !data.ok)) && (
                  <div className="h-48 flex flex-col items-center justify-center text-center gap-2 px-6">
                    <FileWarning className="w-8 h-8 text-amber-300" />
                    <div className="text-sm text-gray-200 max-w-md">
                      {err || data?.reason || "Source not available."}
                    </div>
                    {data?.evidence && (
                      <div className="mt-2 text-[11px] text-gray-400 border-l-2 border-violet-400/40 pl-2 italic max-w-md">
                        “{data.evidence}”
                      </div>
                    )}
                  </div>
                )}

                {!loading && data?.ok && data.image_b64 && (
                  <div className="space-y-2">
                    {!data.matched && (
                      <div className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-400/20
                                      rounded px-2 py-1 inline-flex items-center gap-1">
                        <FileWarning className="w-3 h-3" />
                        Couldn't pinpoint the exact region on this page — showing the source page.
                      </div>
                    )}
                    {/* Image + overlay. The wrapper is position:relative and the
                        boxes are percentage-positioned so they scale with the
                        responsive image. */}
                    <div className="relative inline-block max-w-full mx-auto rounded-lg overflow-hidden
                                    border border-white/10 bg-white">
                      <img
                        src={`data:image/png;base64,${data.image_b64}`}
                        alt="source page"
                        className="block max-w-full h-auto select-none"
                        draggable={false}
                      />
                      {(data.rects || []).map((r, i) => {
                        const [x0, y0, x1, y1] = r;
                        const style: React.CSSProperties = {
                          left:   `${(x0 / w) * 100}%`,
                          top:    `${(y0 / h) * 100}%`,
                          width:  `${((x1 - x0) / w) * 100}%`,
                          height: `${((y1 - y0) / h) * 100}%`,
                        };
                        return (
                          <div
                            key={i}
                            className="absolute border-2 border-amber-400 bg-amber-300/20
                                       rounded-sm shadow-[0_0_0_2px_rgba(0,0,0,0.25)] pointer-events-none
                                       animate-pulse"
                            style={style}
                          />
                        );
                      })}
                    </div>

                    {data.evidence && (
                      <div className="flex gap-2 text-[12px] text-gray-300 border-l-2 border-violet-400/40 pl-2 py-0.5 mt-2">
                        <Quote className="w-3.5 h-3.5 text-violet-300 flex-shrink-0 mt-0.5" />
                        <span className="italic leading-relaxed">{data.evidence}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
