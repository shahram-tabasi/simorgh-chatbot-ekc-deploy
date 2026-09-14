"""
EPLAN file service
==================
Hands back what the EPLAN add-in produced: the exported PDF, or the whole
project as a zip.

Where the files are
-------------------
When the Eplanix add-in finishes a drawing it writes the project onto the
techserver SMB host and exports a PDF beside it (ProjectService.ProcessDataAsync
-> PageBuilder.ExportProjectToPdf), then answers the caller with the path:

    $(MD_Projects)\\OE12112\\Drawing\\MV\\Single line\\Auto-<scope>\\Rev6-Draft\\Rev<name>\\ASLD.elk

$(MD_Projects) is the techserver root, so the first segment is the OE share and
the rest is a path inside it — which is exactly the (oenum, path) pair these
endpoints take. An EPLAN project on disk is that .elk plus a sibling .edb
directory of the same stem; the PDF is the same stem with .pdf.

No share enumeration happens here, and none is needed: the share name comes
out of the path EPLAN itself wrote, so it is known to exist and known to be
spelled correctly. That is why this can use a plain SMB library rather than
the smbclient CLI (which is the only thing that can enumerate shares, and is
an apt package this network cannot install — see the Dockerfile).
"""

import errno as _errno
import logging
import os
import re
import shutil
import tempfile
import zipfile
from typing import Optional

import smbclient
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("eplan-files")
# smbprotocol logs a line per SMB request at INFO — four or five for a single
# file, thousands for one .edb walk. Its warnings are still worth having.
logging.getLogger("smbprotocol").setLevel(
    os.getenv("SMB_LOG_LEVEL", "WARNING")
)

# The same host and credentials techserver-mcp uses — one set of techserver
# credentials for the stack, not two.
TECHSERVER_HOST = os.getenv("TECHSERVER_HOST", "192.168.1.3")
TECHSERVER_USER = os.getenv("TECHSERVER_USER", "")
TECHSERVER_PASSWORD = os.getenv("TECHSERVER_PASSWORD", "")

# A project archive is routinely hundreds of megabytes, so it gets a ceiling
# of its own rather than one borrowed from anything document-sized.
ZIP_MAX_BYTES = int(os.getenv("EPLAN_ZIP_MAX_BYTES", str(1024 * 1024 * 1024)))
CONNECT_TIMEOUT = int(os.getenv("EPLAN_SMB_TIMEOUT", "60"))
API_KEY = os.getenv("EPLAN_FILES_API_KEY", "")

app = FastAPI(title="eplan-files-service", version="1.0.0")

_session_ready = False


def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key")


def _session() -> None:
    """Register the SMB session once; smbclient keeps a connection pool."""
    global _session_ready
    if _session_ready:
        return
    user, password = TECHSERVER_USER, TECHSERVER_PASSWORD
    # techserver-mcp writes the account as EKC\tech; smbclient wants the
    # domain kept on the username, so this is passed through as-is and only
    # normalised for the empty case.
    smbclient.register_session(
        TECHSERVER_HOST,
        username=user or None,
        password=password or None,
        connection_timeout=CONNECT_TIMEOUT,
    )
    _session_ready = True


def _unc(share: str, rel: str = "") -> str:
    path = f"\\\\{TECHSERVER_HOST}\\{share}"
    if rel:
        path += "\\" + rel.replace("/", "\\")
    return path


def _eplan_rel(path: str) -> str:
    """Normalise a caller-supplied in-share path to an .elk, or refuse it.

    The path reaches here from a browser by way of simorgh-soft, so it is
    treated as input rather than as something EPLAN said. Anything that could
    climb out of the share is refused, and the .elk suffix is required so this
    cannot be turned into a general read of the techserver.
    """
    norm = (path or "").strip().lstrip("/\\").replace("\\", "/")
    norm = re.sub(r"/+", "/", norm)
    if not norm:
        raise HTTPException(status_code=400, detail="path is required")
    if any(seg in ("..", ".", "") for seg in norm.split("/")):
        raise HTTPException(status_code=400, detail=f"path must not be relative: {path!r}")
    if not norm.lower().endswith(".elk"):
        raise HTTPException(
            status_code=400,
            detail=f"path must be the .elk project file, got {norm!r}",
        )
    return norm


def _share(oenum: str) -> str:
    """The OE share, as it appeared in EPLAN's own path."""
    share = (oenum or "").strip().strip("\\/")
    if not share or "/" in share or "\\" in share:
        raise HTTPException(status_code=400, detail=f"invalid oenum: {oenum!r}")
    return share


def _copy_down(remote: str, local: str) -> int:
    os.makedirs(os.path.dirname(local), exist_ok=True)
    with smbclient.open_file(remote, mode="rb") as src, open(local, "wb") as dst:
        return shutil.copyfileobj(src, dst, length=1024 * 1024) or os.path.getsize(local)


# The NTSTATUS values that mean "it is not there", as against "the share
# refused us" or "the network broke". smbprotocol raises one SMBOSError type
# for all of them, and its errno is not dependable — a missing file comes back
# as errno 0 with the real answer only in the NTSTATUS — so the status is what
# is matched, with errno kept as a fallback for anything that does set it.
_NOT_FOUND_NTSTATUS = {
    0xC0000034,  # STATUS_OBJECT_NAME_NOT_FOUND
    0xC000003A,  # STATUS_OBJECT_PATH_NOT_FOUND
    0xC000000F,  # STATUS_NO_SUCH_FILE
    0xC00000CC,  # STATUS_BAD_NETWORK_NAME — no such share
}


def _not_found(exc: Exception) -> bool:
    status = getattr(exc, "ntstatus", None)
    if status is not None and status in _NOT_FOUND_NTSTATUS:
        return True
    return getattr(exc, "errno", None) == _errno.ENOENT


@app.get("/health")
def health() -> dict:
    return {
        "status": "healthy",
        "service": "eplan-files",
        "techserver_host": TECHSERVER_HOST,
        "authenticated": bool(TECHSERVER_USER),
    }


@app.get("/eplan/pdf", dependencies=[Depends(require_api_key)])
def eplan_pdf(oenum: str = Query(...), path: str = Query(...)):
    """The PDF EPLAN exported beside the project."""
    rel = _eplan_rel(path)
    share = _share(oenum)
    pdf_rel = rel[: -len(".elk")] + ".pdf"

    _session()
    tmpdir = tempfile.mkdtemp(prefix="eplanpdf_")
    local = os.path.join(tmpdir, os.path.basename(pdf_rel))
    try:
        _copy_down(_unc(share, pdf_rel), local)
    except Exception as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        if _not_found(exc):
            raise HTTPException(
                status_code=404,
                detail=(f"no PDF beside the project yet: {pdf_rel}. EPLAN writes it at "
                        "the end of a run, so a drawing still in progress has none."),
            )
        logger.warning("pdf fetch failed for %s: %s", pdf_rel, exc)
        raise HTTPException(status_code=502, detail=f"techserver read failed: {exc}")

    return FileResponse(
        local,
        media_type="application/pdf",
        filename=os.path.basename(pdf_rel),
        background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
    )


@app.get("/eplan/zip", dependencies=[Depends(require_api_key)])
def eplan_zip(oenum: str = Query(...), path: str = Query(...)):
    """The whole EPLAN project — the .elk and its .edb directory — as one zip."""
    rel = _eplan_rel(path)
    share = _share(oenum)
    stem = rel[: -len(".elk")]
    name = os.path.basename(stem)

    _session()
    tmpdir = tempfile.mkdtemp(prefix="eplanzip_")
    staged = os.path.join(tmpdir, "project")
    os.makedirs(staged, exist_ok=True)
    try:
        try:
            _copy_down(_unc(share, rel), os.path.join(staged, f"{name}.elk"))
        except Exception as exc:
            if _not_found(exc):
                raise HTTPException(
                    status_code=404,
                    detail=f"project not found: {oenum}/{rel}",
                )
            raise HTTPException(status_code=502, detail=f"techserver read failed: {exc}")

        # The .edb may legitimately be absent — that is a thinner zip, not an
        # error — so a failure to walk it is logged and passed over rather than
        # failing a download whose .elk is already in hand.
        total = os.path.getsize(os.path.join(staged, f"{name}.elk"))
        edb_unc = _unc(share, stem + ".edb")
        try:
            for base, _dirs, files in smbclient.walk(edb_unc):
                for fname in files:
                    remote = f"{base}\\{fname}"
                    inner = os.path.relpath(
                        remote.replace(edb_unc, "").lstrip("\\").replace("\\", os.sep) or fname
                    )
                    local = os.path.join(staged, f"{name}.edb", inner)
                    _copy_down(remote, local)
                    total += os.path.getsize(local)
                    if total > ZIP_MAX_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=(f"project exceeds EPLAN_ZIP_MAX_BYTES ({ZIP_MAX_BYTES}). "
                                    "Raise it, or copy the project off the share directly."),
                        )
        except HTTPException:
            raise
        except Exception as exc:
            logger.info("no .edb alongside %s (%s) — zipping the .elk alone", rel, exc)

        archive = os.path.join(tmpdir, f"{name}.zip")
        # DEFLATE, not STORE: an .edb is mostly small XML-ish files that
        # compress well, and this crosses the network again on its way out.
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for base, _dirs, files in os.walk(staged):
                for fname in files:
                    full = os.path.join(base, fname)
                    z.write(full, os.path.relpath(full, staged))
    except Exception:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise

    return FileResponse(
        archive,
        media_type="application/zip",
        filename=f"{name}.zip",
        background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
    )
