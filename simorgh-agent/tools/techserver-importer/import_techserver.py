#!/usr/bin/env python3
"""
techserver → GitLab one-time importer
=====================================
For each oenum directory found under //techserver/<share>/, create (if
needed) a GitLab project at <PROJECTS_GROUP>/<oenum>, smbclient-mget the
contents into a temp dir, and `git push` the snapshot to the project's
default branch.

Idempotent at the oenum level: if the project already exists and the SMB
content hashes match the last imported manifest, the project is skipped.

Usage (one-shot, run from the .68 host):

  docker run --rm --network simorgh_app_net \\
    -e TECHSERVER_IP=192.168.1.3 \\
    -e TECHSERVER_USER='EKC\\tech' \\
    -e TECHSERVER_PASSWORD='...' \\
    -e GITLAB_URL=http://gitlab \\
    -e GITLAB_TOKEN=glpat-... \\
    -e PROJECTS_GROUP=simorgh-projects \\
    simorgh-techserver-importer:local \\
      import-all --share tech

  # Or import a single oenum:
  ... import-one --oenum 12345 --share tech
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import click
import gitlab
from gitlab.exceptions import GitlabCreateError, GitlabGetError


TECHSERVER_IP   = os.getenv("TECHSERVER_IP",   "192.168.1.3")
TECHSERVER_USER = os.getenv("TECHSERVER_USER", "EKC\\tech")
TECHSERVER_PWD  = os.environ["TECHSERVER_PASSWORD"]
GITLAB_URL      = os.environ["GITLAB_URL"]
GITLAB_TOKEN    = os.environ["GITLAB_TOKEN"]
PROJECTS_GROUP  = os.getenv("PROJECTS_GROUP", "simorgh-projects")


def _smbclient(share: str, command: str, timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["smbclient", f"//{TECHSERVER_IP}/{share}",
         "-U", TECHSERVER_USER, "--password", TECHSERVER_PWD,
         "-c", command],
        capture_output=True, text=True, timeout=timeout, check=False,
    )


def _list_oenums(share: str) -> list[str]:
    """Parse smbclient `ls` output, return only directory entries that look
    like an OE number."""
    p = _smbclient(share, "ls")
    if p.returncode != 0:
        raise click.ClickException(f"smbclient ls failed: {p.stderr.strip()[:300]}")
    oenums = []
    for line in p.stdout.splitlines():
        # smbclient ls format:  "  <name>          D  <size>  <mtime>"
        m = re.match(r"^\s+(\S.*?)\s+D[A-Z]*\s+\d+\s+", line)
        if not m:
            continue
        name = m.group(1).strip()
        if name in (".", ".."):
            continue
        # Heuristic: oenums are numeric or alphanumeric short codes.
        if re.fullmatch(r"[A-Za-z0-9_\-]{2,40}", name):
            oenums.append(name)
    return sorted(set(oenums))


def _stage_oenum(share: str, oenum: str, workdir: Path) -> Path:
    """smbclient mget the oenum into workdir/<oenum>/. Returns that path."""
    target = workdir / oenum
    target.mkdir(parents=True, exist_ok=True)
    cmd = (f'cd "{oenum}"; lcd "{target}"; recurse ON; prompt OFF; mget *')
    p = _smbclient(share, cmd, timeout=1800)
    if p.returncode != 0:
        raise click.ClickException(f"smb mget {oenum} failed: {p.stderr.strip()[:300]}")
    return target


def _content_hash(staged: Path) -> str:
    """Sha256 over (relpath, bytes) for every file under staged/. Used to
    decide whether to re-push."""
    h = hashlib.sha256()
    for f in sorted(staged.rglob("*")):
        if f.is_file():
            rel = f.relative_to(staged).as_posix().encode()
            h.update(rel)
            h.update(b"\0")
            h.update(f.read_bytes())
            h.update(b"\0")
    return h.hexdigest()


def _ensure_project(gl: gitlab.Gitlab, oenum: str):
    full = f"{PROJECTS_GROUP}/{oenum.lower()}"
    try:
        return gl.projects.get(full)
    except GitlabGetError:
        pass
    grp = gl.groups.get(PROJECTS_GROUP)
    try:
        return gl.projects.create({
            "name": oenum,
            "path": oenum.lower(),
            "namespace_id": grp.id,
            "description": f"Imported from //techserver/<share>/{oenum}/",
            "visibility": "private",
            "initialize_with_readme": True,
            "default_branch": "main",
        })
    except GitlabCreateError as e:
        raise click.ClickException(f"create project {full!r} failed: {e}")


def _push_snapshot(staged: Path, project, message: str) -> str:
    """git init in staged/, commit everything, push to project.http_url_to_repo."""
    repo_url_with_token = project.http_url_to_repo.replace(
        "://", f"://oauth2:{GITLAB_TOKEN}@", 1
    )
    env = {**os.environ,
           "GIT_AUTHOR_NAME": "techserver-importer",
           "GIT_AUTHOR_EMAIL": "importer@simorgh.local",
           "GIT_COMMITTER_NAME": "techserver-importer",
           "GIT_COMMITTER_EMAIL": "importer@simorgh.local"}

    def _run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=staged, env=env,
                              capture_output=True, text=True, check=False, timeout=600)

    if not (staged / ".git").exists():
        _run("git", "init", "-b", "main")

    # Configure LFS for binary files > 5MB to keep repo size reasonable.
    _run("git", "lfs", "install")
    _run("git", "lfs", "track", "*.pdf", "*.dwg", "*.zip", "*.rar", "*.7z",
         "*.iso", "*.cad", "*.step", "*.stp", "*.pnr")

    _run("git", "add", "-A")
    status = _run("git", "status", "--porcelain")
    if not status.stdout.strip():
        return "no-changes"

    p = _run("git", "commit", "-m", message)
    if p.returncode != 0 and "nothing to commit" not in p.stdout + p.stderr:
        raise click.ClickException(f"git commit failed: {p.stderr.strip()[:300]}")

    _run("git", "remote", "remove", "origin")
    _run("git", "remote", "add", "origin", repo_url_with_token)
    push = _run("git", "push", "-u", "origin", "main", "--force-with-lease")
    if push.returncode != 0:
        # First push to a brand-new repo: lease check has no base, fall back.
        push = _run("git", "push", "-u", "origin", "main", "--force")
    if push.returncode != 0:
        raise click.ClickException(f"git push failed: {push.stderr.strip()[:300]}")
    return "pushed"


def _read_manifest(project) -> str | None:
    try:
        f = project.files.get(file_path=".simorgh-import-manifest", ref="main")
        import base64
        return base64.b64decode(f.content).decode("utf-8").strip()
    except GitlabGetError:
        return None


def _write_manifest(staged: Path, content_hash: str) -> None:
    (staged / ".simorgh-import-manifest").write_text(content_hash + "\n")


@click.group()
def cli():
    pass


@cli.command("import-one")
@click.option("--share", default="tech", help="SMB share name on techserver")
@click.option("--oenum", required=True)
@click.option("--force", is_flag=True, help="Re-push even if hash matches")
def import_one(share: str, oenum: str, force: bool):
    """Import a single oenum directory into GitLab."""
    gl = gitlab.Gitlab(GITLAB_URL, private_token=GITLAB_TOKEN, timeout=60)
    gl.auth()
    project = _ensure_project(gl, oenum)
    click.echo(f"[{oenum}] project = {project.path_with_namespace}")

    with tempfile.TemporaryDirectory(prefix="techsrv-") as wd:
        staged = _stage_oenum(share, oenum, Path(wd))
        h = _content_hash(staged)

        prev = _read_manifest(project)
        if prev == h and not force:
            click.echo(f"[{oenum}] unchanged (hash {h[:12]}…), skip")
            return

        _write_manifest(staged, h)
        msg = f"chore(import): techserver//{share}/{oenum} snapshot ({h[:12]})"
        result = _push_snapshot(staged, project, msg)
        click.echo(f"[{oenum}] {result}")


@cli.command("import-all")
@click.option("--share", default="tech")
@click.option("--limit", type=int, default=0, help="Stop after N oenums (0 = all)")
@click.option("--force", is_flag=True)
def import_all(share: str, limit: int, force: bool):
    """Discover every oenum on the share and import each. Failures don't
    abort the run."""
    oenums = _list_oenums(share)
    click.echo(f"discovered {len(oenums)} oenums")
    if limit:
        oenums = oenums[:limit]
    failed: list[tuple[str, str]] = []
    for i, oenum in enumerate(oenums, 1):
        click.echo(f"[{i}/{len(oenums)}] {oenum}")
        try:
            ctx = click.get_current_context()
            ctx.invoke(import_one, share=share, oenum=oenum, force=force)
        except click.ClickException as e:
            failed.append((oenum, e.message))
            click.echo(f"  ! FAILED: {e.message}", err=True)
    click.echo(f"done — {len(oenums)-len(failed)} ok, {len(failed)} failed")
    if failed:
        click.echo("failures:", err=True)
        for oe, msg in failed:
            click.echo(f"  - {oe}: {msg}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    cli()
