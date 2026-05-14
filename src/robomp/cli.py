"""Command-line interface."""

from __future__ import annotations

import asyncio
import json
import sys

import click
import uvicorn

from robomp.config import Settings, get_settings
from robomp.db import INACTIVE_EVENT_STATES, get_database
from robomp.github_backend import GitHubBackend
from robomp.logging_config import configure_logging
from robomp.manual_triage import InvalidIssueRef, ManualTriageError, enqueue_manual_triage, parse_issue_ref
from robomp.proxy_client import GitHubProxyClient, ProxyGitTransport
from robomp.queue import WorkerPool
from robomp.sandbox import SandboxManager
from robomp.server import create_app


def _settings_or_die() -> Settings:
    try:
        return get_settings()
    except Exception as exc:
        click.echo(f"configuration error: {exc}", err=True)
        sys.exit(2)


def _require_proxy_mode(cfg: Settings) -> tuple[str, bytes]:
    if cfg.github_token is not None:
        raise SystemExit(
            "robomp orchestrator refuses to start with GITHUB_TOKEN set in env. "
            "The PAT must live only in the gh-proxy container."
        )
    if cfg.gh_proxy_url is None or cfg.gh_proxy_hmac_key is None:
        raise SystemExit(
            "robomp orchestrator requires ROBOMP_GH_PROXY_URL and "
            "ROBOMP_GH_PROXY_HMAC_KEY (run gh-proxy in a sibling container)."
        )
    return cfg.gh_proxy_url, cfg.gh_proxy_hmac_key.get_secret_value().encode("utf-8")


def _build_orchestrator(cfg: Settings) -> tuple[GitHubBackend, ProxyGitTransport]:
    base_url, key = _require_proxy_mode(cfg)
    github = GitHubProxyClient(base_url=base_url, hmac_key=key)
    transport = ProxyGitTransport(base_url=base_url, hmac_key=key)
    return github, transport


@click.group()
def main() -> None:
    """robomp control surface."""


@main.command()
def serve() -> None:
    """Run the webhook receiver + worker pool."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    app = create_app(cfg)
    uvicorn.run(app, host=cfg.bind_host, port=cfg.bind_port, log_config=None)


@main.command()
@click.argument("issue_ref")
def triage(issue_ref: str) -> None:
    """Fetch a live issue and queue it as if a webhook arrived.

    ISSUE_REF is `owner/repo#NN`.
    """
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    try:
        repo_full, number = parse_issue_ref(issue_ref)
    except InvalidIssueRef as exc:
        click.echo(str(exc), err=True)
        sys.exit(2)
    if not cfg.allows(repo_full):
        click.echo(f"refusing: {repo_full} not in ROBOMP_REPO_ALLOWLIST", err=True)
        sys.exit(2)

    async def _go() -> None:
        github, git_transport = _build_orchestrator(cfg)
        db = get_database(cfg.sqlite_path)
        try:
            delivery = await enqueue_manual_triage(
                db=db,
                github=github,
                repo_full=repo_full,
                number=number,
            )
        except ManualTriageError as exc:
            click.echo(f"refusing: {exc}", err=True)
            sys.exit(2)
        sandbox = SandboxManager(cfg.workspace_root, transport=git_transport)
        pool = WorkerPool(settings=cfg, db=db, github=github, sandbox=sandbox, git_transport=git_transport)
        await pool.start()
        pool.wake()
        # Drain until the event finishes.
        while True:
            await asyncio.sleep(2.0)
            row = db.get_event(delivery)
            if row is None:
                break
            if row.state in ("done", "failed", "skipped"):
                click.echo(json.dumps({"delivery": delivery, "state": row.state, "error": row.last_error}, indent=2))
                break
        await pool.stop()

    asyncio.run(_go())


@main.command()
@click.argument("delivery_id")
def replay(delivery_id: str) -> None:
    """Force a stored event back into the queue and run a one-shot drain."""
    cfg = _settings_or_die()
    configure_logging(cfg.log_dir)
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_event(delivery_id)
    if row is None:
        click.echo(f"unknown delivery: {delivery_id}", err=True)
        sys.exit(2)
    if not db.requeue_event(delivery_id, from_states=INACTIVE_EVENT_STATES):
        click.echo(f"delivery {delivery_id} is {row.state}; only inactive events can be replayed", err=True)
        sys.exit(2)

    async def _drain() -> None:
        github, git_transport = _build_orchestrator(cfg)
        sandbox = SandboxManager(cfg.workspace_root, transport=git_transport)
        pool = WorkerPool(settings=cfg, db=db, github=github, sandbox=sandbox, git_transport=git_transport)
        await pool.start()
        pool.wake()
        while True:
            await asyncio.sleep(2.0)
            row = db.get_event(delivery_id)
            if row is None or row.state in ("done", "failed", "skipped"):
                break
        await pool.stop()
        if row is not None:
            click.echo(json.dumps({"delivery": delivery_id, "state": row.state, "error": row.last_error}, indent=2))

    asyncio.run(_drain())


@main.command()
def status() -> None:
    """Dump the issue table."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    rows = db.list_issues()
    for r in rows:
        click.echo(
            f"{r.key:<40} state={r.state:<12} pr={r.pr_number or '-'} branch={r.branch or '-'} updated={r.updated_at}"
        )


@main.command()
@click.argument("issue_key")
def cleanup(issue_key: str) -> None:
    """Force-remove the workspace for an issue (does not touch the remote)."""
    cfg = _settings_or_die()
    cfg.ensure_paths()
    db = get_database(cfg.sqlite_path)
    row = db.get_issue(issue_key)
    if row is None:
        click.echo(f"unknown issue: {issue_key}", err=True)
        sys.exit(2)
    sandbox = SandboxManager(cfg.workspace_root)
    sandbox.remove_workspace(repo=row.repo, number=row.number)
    db.set_issue_state(issue_key, "abandoned")
    click.echo(f"cleaned up {issue_key}")


if __name__ == "__main__":
    main()
