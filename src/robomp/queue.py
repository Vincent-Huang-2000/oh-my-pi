"""Async worker pool draining the durable sqlite event queue."""

from __future__ import annotations

import asyncio
import logging
import traceback
from collections.abc import Callable
from contextlib import suppress

from robomp import tasks
from robomp.cancellation import clear_current_event, set_current_event
from robomp.config import Settings
from robomp.db import Database, EventRow
from robomp.github_backend import GitHubBackend
from robomp.sandbox import GitTransport, SandboxManager

log = logging.getLogger(__name__)


class WorkerPool:
    """Long-lived dispatcher: drains queued events into per-task coroutines."""

    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        github: GitHubBackend,
        sandbox: SandboxManager,
        git_transport: GitTransport,
    ) -> None:
        self.settings = settings
        self.db = db
        self.github = github
        self.sandbox = sandbox
        self.git_transport = git_transport
        self._workers: list[asyncio.Task[None]] = []
        self._wakeup = asyncio.Event()
        self._stop = asyncio.Event()
        self._semaphore = asyncio.Semaphore(settings.max_concurrency)
        self._inflight: set[str] = set()
        self._inflight_lock = asyncio.Lock()
        # Cancellation: workers register a stop hook via the contextvar helpers
        # in this module; the API surface fires them on demand. Plain dict/set
        # are GIL-safe for single-key ops, which is all we do.
        self._cancel_hooks: dict[str, Callable[[], None]] = {}
        self._cancelled: set[str] = set()
        # Phase B (graceful shutdown): track each spawned `_run_event` task so
        # `stop()` can drain in-flight work, and a flag the exception path
        # checks to avoid marking shutdown-interrupted rows as `failed` (we
        # want them to stay `running` so `reset_stuck_running()` requeues
        # them on next start; the agent then resumes via `--continue`).
        self._inflight_tasks: dict[asyncio.Task[None], str] = {}
        self._shutting_down: bool = False

    def wake(self) -> None:
        """Signal that new work is available."""
        self._wakeup.set()

    async def inflight_snapshot(self) -> list[str]:
        """Return a stable, sorted snapshot of currently in-flight issue keys."""
        async with self._inflight_lock:
            return sorted(self._inflight)

    async def start(self) -> None:
        recovered = self.db.reset_stuck_running()
        if recovered:
            log.info("recovered stuck events", extra={"count": recovered})
        # Single dispatcher loop is simpler than N workers; concurrency is gated by the semaphore.
        self._workers.append(asyncio.create_task(self._dispatch_loop(), name="robomp-dispatch"))

    async def stop(self, *, drain_timeout: float = 25.0, kill_timeout: float = 5.0) -> None:
        """Halt the dispatcher, then drain (or kill) in-flight `_run_event` tasks.

        Cleanly interrupted tasks intentionally leave their DB row in
        `running` so the next `WorkerPool.start()` re-queues them via
        `reset_stuck_running()`. The resumed omp session then picks up via
        `--continue` from the persisted JSONL transcript.
        """
        self._shutting_down = True
        self._stop.set()
        self._wakeup.set()
        # 1. Halt the dispatcher (no new claims).
        for worker in self._workers:
            worker.cancel()
        for worker in self._workers:
            with suppress(asyncio.CancelledError):
                await worker
        self._workers.clear()
        # 2. Give in-flight tasks a chance to drain.
        pending = list(self._inflight_tasks)
        if not pending:
            return
        log.info("draining in-flight tasks", extra={"count": len(pending), "timeout": drain_timeout})
        _, still_running = await asyncio.wait(pending, timeout=drain_timeout)
        if not still_running:
            return
        # 3. Time's up — fire each cancel hook to kill omp; tasks will hit
        #    the shutting_down branch in _run_event and exit without
        #    marking the row failed.
        log.warning("shutdown timeout; killing omp subprocesses", extra={"count": len(still_running)})
        for task in still_running:
            delivery_id = self._inflight_tasks.get(task)
            if delivery_id is None:
                continue
            hook = self._cancel_hooks.pop(delivery_id, None)
            if hook is None:
                continue
            try:
                await asyncio.to_thread(hook)
            except Exception:
                log.exception("shutdown hook raised", extra={"delivery": delivery_id})
        # 4. Brief wait for the exception path to settle.
        with suppress(TimeoutError):
            await asyncio.wait(still_running, timeout=kill_timeout)

    async def _dispatch_loop(self) -> None:
        log.info("dispatch loop online")
        try:
            while not self._stop.is_set():
                row = await self._claim_next_unique()
                if row is None:
                    self._wakeup.clear()
                    try:
                        await asyncio.wait_for(self._wakeup.wait(), timeout=10.0)
                    except TimeoutError:
                        pass
                    continue
                # Schedule the task; the semaphore caps concurrent execution.
                task = asyncio.create_task(self._run_event(row), name=f"robomp-event-{row.delivery_id[:8]}")
                self._inflight_tasks[task] = row.delivery_id
                task.add_done_callback(lambda t: self._inflight_tasks.pop(t, None))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("dispatch loop crashed")

    async def _claim_next_unique(self) -> EventRow | None:
        """Claim the next event whose issue isn't already inflight."""
        # The DB layer doesn't filter by issue_key; we peek then guard with a set.
        async with self._inflight_lock:
            # Naive but fine for v1 (small queue).
            row = await asyncio.to_thread(self.db.claim_next_event)
            if row is None:
                return None
            key = row.issue_key or row.delivery_id
            if key in self._inflight:
                # Put it back; another in-flight task is touching the same issue.
                await asyncio.to_thread(self.db.requeue_event, row.delivery_id, from_states=("running",))
                # Sleep briefly so we don't spin.
                await asyncio.sleep(0.5)
                return None
            self._inflight.add(key)
        return row

    async def _release(self, row: EventRow) -> None:
        key = row.issue_key or row.delivery_id
        async with self._inflight_lock:
            self._inflight.discard(key)

    def _arm_cancel(self, delivery_id: str, hook: Callable[[], None]) -> None:
        """Worker-side: install the cancel hook.

        If cancellation was already requested before the worker reached this
        point, fire the hook immediately so we don't lose the signal.
        """
        if delivery_id in self._cancelled:
            try:
                hook()
            except Exception:
                log.exception("late cancel fire failed", extra={"delivery": delivery_id})
            return
        self._cancel_hooks[delivery_id] = hook

    def _disarm_cancel(self, delivery_id: str) -> None:
        """Worker-side: clear the cancel hook (the resource is gone)."""
        self._cancel_hooks.pop(delivery_id, None)

    async def cancel_event(self, delivery_id: str) -> bool:
        """Request cancellation of a running event. Returns whether a hook fired.

        Marks the delivery as cancelled regardless of whether a worker is
        currently armed, so a late-armed hook still observes the request. The
        worker thread's exception path is what eventually transitions the row
        to `failed` with a cancellation marker.
        """
        self._cancelled.add(delivery_id)
        hook = self._cancel_hooks.pop(delivery_id, None)
        if hook is None:
            return False
        # `hook` typically kills a subprocess; run it off the loop so its wait()
        # doesn't stall the event loop for up to the omp shutdown grace period.
        try:
            await asyncio.to_thread(hook)
        except Exception:
            log.exception("cancel hook raised", extra={"delivery": delivery_id})
        return True

    async def _run_event(self, row: EventRow) -> None:
        token = set_current_event(self, row.delivery_id)
        async with self._semaphore:
            try:
                await self._dispatch(row)
                if row.delivery_id in self._cancelled:
                    self.db.mark_event(row.delivery_id, "failed", error="cancelled by operator")
                else:
                    self.db.mark_event(row.delivery_id, "done")
            except Exception as exc:
                if self._shutting_down:
                    # Phase B: leave the row in `running` so
                    # `reset_stuck_running()` flips it back to `queued` on
                    # the next start and the resumed omp session picks up
                    # via `--continue`. Marking failed here would strand
                    # work that we know is recoverable.
                    log.info(
                        "event interrupted by shutdown",
                        extra={"delivery": row.delivery_id, "key": row.issue_key},
                    )
                elif row.delivery_id in self._cancelled:
                    log.info("event cancelled", extra={"delivery": row.delivery_id})
                    self.db.mark_event(row.delivery_id, "failed", error="cancelled by operator")
                else:
                    tb = traceback.format_exc(limit=20)
                    log.exception("event handler failed", extra={"delivery": row.delivery_id})
                    self.db.mark_event(row.delivery_id, "failed", error=f"{exc}\n{tb}")
            finally:
                self._cancelled.discard(row.delivery_id)
                self._cancel_hooks.pop(row.delivery_id, None)
                await self._release(row)
                clear_current_event(token)

    async def _dispatch(self, row: EventRow) -> None:
        event = row.event_type
        action = str(row.payload.get("action") or "")
        log.info(
            "dispatch",
            extra={
                "event": event,
                "action": action,
                "delivery": row.delivery_id,
                "key": row.issue_key,
                "attempts": row.attempts,
                "recovered": row.attempts >= 2,
            },
        )
        if event == "issues" and action == "opened":
            await tasks.triage_issue(
                settings=self.settings,
                db=self.db,
                github=self.github,
                sandbox=self.sandbox,
                git_transport=self.git_transport,
                payload=row.payload,
                delivery_id=row.delivery_id,
                attempts=row.attempts,
            )
        elif event == "issue_comment" and action == "created":
            issue = row.payload.get("issue") or {}
            if "pull_request" in issue:
                await tasks.handle_pr_conversation(
                    settings=self.settings,
                    db=self.db,
                    github=self.github,
                    sandbox=self.sandbox,
                    git_transport=self.git_transport,
                    payload=row.payload,
                    delivery_id=row.delivery_id,
                    attempts=row.attempts,
                )
            else:
                await tasks.handle_comment(
                    settings=self.settings,
                    db=self.db,
                    github=self.github,
                    sandbox=self.sandbox,
                    git_transport=self.git_transport,
                    payload=row.payload,
                    delivery_id=row.delivery_id,
                    attempts=row.attempts,
                )
        elif event == "pull_request_review_comment" and action == "created":
            await tasks.handle_review(
                settings=self.settings,
                db=self.db,
                github=self.github,
                sandbox=self.sandbox,
                git_transport=self.git_transport,
                payload=row.payload,
                delivery_id=row.delivery_id,
                attempts=row.attempts,
            )
        elif event == "issues" and action == "closed":
            await tasks.cleanup_workspace(
                settings=self.settings,
                db=self.db,
                sandbox=self.sandbox,
                payload=row.payload,
                target_state="closed",
            )
        elif event == "pull_request" and action == "closed":
            await tasks.cleanup_workspace(
                settings=self.settings,
                db=self.db,
                sandbox=self.sandbox,
                payload=row.payload,
                target_state="merged",
            )
        else:
            log.info("no-op dispatch", extra={"event": event, "action": action})


__all__ = ["WorkerPool"]
