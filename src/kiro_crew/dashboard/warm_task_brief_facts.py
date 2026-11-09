"""What the warm welcome reads before it posts (RFC section 3.9.1): which pull
requests to read live, and the digest that stops a re-send when nothing changed.
The gateway renders every fact (section 3.11).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from kiro_crew.dashboard import warm_task_brief_inputs as inputs


def live_refs(
    work_items: Sequence[Mapping[str, Any]],
    terminal: Callable[[object], bool],
) -> list[inputs.PrRef]:
    """The pull requests to read before the welcome shows their state (M3): each
    open ask item's ledger PR, then every other open item's, at most
    :data:`inputs.MAX_LIVE_PRS`. Only a ledger PR is read: the welcome shows PR
    state only on its item's line, so a URL in an item's text is never read."""
    asks = [item for item in work_items if inputs.is_open_ask(item, terminal)]
    rest = [item for item in work_items if not terminal(item.get("state")) and item not in asks]
    return inputs.pr_refs((), [r for i in (*asks, *rest) if (r := inputs.ledger_ref(i))])


def facts_digest(ledger_digest: str, waiting: object, live: Sequence[Mapping[str, Any]]) -> str:
    """What a brief stood on: the stored ledgers, what waited and each PR
    read, minus read times. Equal digests mean nothing changed since."""
    reads = [
        {k: v for k, v in entry.items() if k not in ("read_at", "not_checked_since", "_read_epoch")}
        for entry in live
    ]
    blob = json.dumps(
        [ledger_digest, waiting, reads], ensure_ascii=False, sort_keys=True, default=str
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


FACTS_DIGEST_KEY = "facts_digest"


def previous_facts_digest(
    rows: Sequence[Mapping[str, Any]], result_kind: str, miss_key: str
) -> str:
    """The facts digest of the newest delivered brief, or ""."""
    for row in reversed(rows):
        meta = row.get("meta")
        if isinstance(meta, Mapping) and meta.get("kind") == result_kind:
            digest = meta.get(FACTS_DIGEST_KEY)
            return digest if isinstance(digest, str) and not meta.get(miss_key) else ""
    return ""
