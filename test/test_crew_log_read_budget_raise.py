"""The read budget's default ``raise`` mode, its ``allow`` reasons, and rows 6 and 1.

Real store, real readers: what raises is the read gateway code makes, on a unit written
through ``CrewLog``.
"""

from __future__ import annotations

import ast
import json
from collections import Counter
from pathlib import Path

import pytest

from kiro_crew import crew_log as lg
from kiro_crew.crew_log import CrewLog
from kiro_crew.crew_log import eager as crew_log_eager
from kiro_crew.crew_log import emit as crew_log_emit
from kiro_crew.crew_log import projection as crew_log
from kiro_crew.crew_log import read as crew_read
from kiro_crew.crew_log import read_budget, slot_prime
from kiro_crew.dashboard.handlers import work_ledger_board

SLOT = "chat-readbudget-raise"
BIG = 4 * read_budget.K
SRC = Path(__file__).resolve().parent.parent / "src" / "kiro_crew"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, _floor_monkeypatch):
    _floor_monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "home"))
    _floor_monkeypatch.setenv("KIROCREW_CREW_LOG", "1")
    _floor_monkeypatch.delenv(read_budget.MODE_ENV, raising=False)
    _floor_monkeypatch.setattr(crew_log_eager, "note_commit", lambda *a, **k: None)
    crew_log_emit.reset_caches()
    crew_log.forget_slot_folds()
    crew_log.forget_session_folds()
    read_budget.reset_for_tests()
    yield
    read_budget.reset_for_tests()
    crew_log.forget_slot_folds()
    crew_log.forget_session_folds()


def _unit(unit_id: str, records: int = BIG) -> None:
    handle = CrewLog.create(lg.KIND_SESSION, unit_id, owner="o", agent="a", slot=SLOT)
    for at in range(0, records, 1000):
        batch = range(at, min(records, at + 1000))
        handle.append_many(
            [{"type": "ledger/recorded", "data": {"slot": SLOT, "goal": f"g{i}"}} for i in batch],
            src="gateway",
        )
    handle.release_ownership()


def _walk(unit_id: str, seq: int = 1, **kwargs) -> int:
    handle = CrewLog.open(lg.KIND_SESSION, unit_id)
    try:
        return sum(1 for _ in handle.iter_from(seq, **kwargs))
    finally:
        handle.release_ownership()


def test_a_walk_from_the_top_raises_after_k_records_on_the_gateway(monkeypatch):
    _unit("acp-top")
    assert _walk("acp-top") == BIG  # not the gateway: nothing is counted or refused
    read_budget.mark_gateway_process()
    decoded: "list[int]" = []
    real = read_budget.check

    def spy(tally, **kwargs):
        decoded.append(tally.records)
        real(tally, **kwargs)

    monkeypatch.setattr(read_budget, "check", spy)
    with pytest.raises(read_budget.ReadOverBudget) as refused:
        _walk("acp-top")
    assert refused.value.code == read_budget.CODE_OVER_BUDGET
    assert decoded[-1] == read_budget.K + 1, "a refused read costs K + 1 records"
    assert read_budget.snapshot()["raised"] == 1 and read_budget.snapshot()["mode"] == "raise"


@pytest.mark.parametrize("value", ["", "report", "RAISE", "nonsense"])
def test_every_value_but_off_raises(value, monkeypatch):
    _unit("acp-mode")
    monkeypatch.setenv(read_budget.MODE_ENV, value)
    read_budget.mark_gateway_process()
    with pytest.raises(read_budget.ReadOverBudget):
        _walk("acp-mode")
    monkeypatch.setenv(read_budget.MODE_ENV, " Off ")
    assert _walk("acp-mode") == BIG


def test_an_allow_reason_lets_the_walk_through_and_is_counted():
    _unit("acp-allow")
    read_budget.mark_gateway_process()
    assert _walk("acp-allow", allow="first_fold") == BIG
    with read_budget.allowed("member_log"):
        assert _walk("acp-allow") == BIG
    counts = read_budget.snapshot()
    assert counts["allowed"] == 2 and counts["raised"] == 0
    with pytest.raises(ValueError):
        _walk("acp-allow", allow="because")
    with pytest.raises(ValueError), read_budget.allowed("because"):
        pass


def test_a_strict_prefix_walk_and_a_cold_fold_pass_only_report():
    _unit("acp-prefix")
    read_budget.mark_gateway_process()
    assert _walk("acp-prefix", BIG) == 1  # walks BIG - 1 records below its answer
    assert crew_log.read_slot_projection(SLOT, "ledger").seq == BIG  # cold fold pass
    counts = read_budget.snapshot()
    assert counts["raised"] == 0 and counts["over_budget"] == 2


def test_a_listed_row_resumes_from_the_status_fold_and_matches_the_walk(monkeypatch):
    for unit_id in ("acp-list-a", "acp-list-b"):
        _unit(unit_id)
    walked = crew_read.list_session_units(limit=10)
    with monkeypatch.context() as patch:
        patch.setattr(crew_read, "segment_first_seqs", lambda *_a: [])  # force the walk
        expected = crew_read.list_session_units(limit=10)
    assert json.dumps(walked, sort_keys=True) == json.dumps(expected, sort_keys=True)
    read_budget.mark_gateway_process()
    decoded: "list[int]" = []
    real = read_budget._settle

    def spy(tally):
        decoded.append(tally.records)
        real(tally)

    monkeypatch.setattr(read_budget, "_settle", spy)
    again = crew_read.list_session_units(limit=10)
    assert json.dumps(again, sort_keys=True) == json.dumps(expected, sort_keys=True)
    assert decoded and max(decoded) <= read_budget.K + 1, decoded
    assert read_budget.snapshot()["raised"] == 0


def test_conductor_asks_on_a_cold_slot_answers_empty_and_primes(monkeypatch):
    handle = CrewLog.create(lg.KIND_SESSION, "acp-asks", owner="o", agent="a", slot=SLOT)
    handle.append_many(
        [{"type": "ledger/recorded", "data": {"slot": SLOT, "goal": f"g{i}"}} for i in range(BIG)],
        src="gateway",
    )
    handle.release_ownership()
    primed: "list[tuple[str, str]]" = []
    monkeypatch.setattr(
        slot_prime, "schedule", lambda slot, name, **_k: primed.append((slot, name))
    )
    read_budget.mark_gateway_process()
    assert work_ledger_board._conductor_asks(SLOT, {"it_1"}) == {}
    assert primed == [(SLOT, "agentic")]
    assert read_budget.snapshot()["over_budget"] == 0, "the request read nothing cold"
    crew_log.read_slot_projection(SLOT, "agentic")  # what the prime folds
    del primed[:]
    assert work_ledger_board._conductor_asks(SLOT, {"it_1"}) == {} and primed == []


#: Every read allowed past the budget, per file and reason. Shrink only; a new one needs
#: a reason in ``read_budget.ALLOW_REASONS`` and review.
PINNED_ALLOWS: "dict[tuple[str, str], int]" = {
    ("crew_log/emit_crew.py", "dispatch_anchor"): 1,
    ("crew_log/emit_session.py", "writer_seed"): 1,
    ("crew_log/projection_work.py", "operator_rebuild"): 1,
    ("crew_log/read.py", "operator_listing"): 1,
    ("crew_log/session_tree_projection_seed.py", "first_fold"): 1,
    ("crew_log/store_handle.py", "cited_span"): 1,
    ("dashboard/handlers/crew_log.py", "crew_log_page"): 1,
    ("dashboard_templates/instance.py", "savepoint_repair"): 1,
    ("taskq/timeline.py", "crew_log_page"): 1,
    ("eventlog/log.py", "member_log"): 4,
}


def _allows() -> "Counter[tuple[str, str]]":
    found: "Counter[tuple[str, str]]" = Counter()
    for path in sorted(SRC.rglob("*.py")):
        rel = path.relative_to(SRC).as_posix()
        source = path.read_text(encoding="utf-8")
        if "allow" not in source or rel == "crew_log/read_budget.py":
            continue
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            reasons = [
                kw.value for kw in node.keywords if kw.arg == "allow" and name == "iter_from"
            ]
            if name == "allowed" and node.args:
                reasons.append(node.args[0])
            for reason in reasons:
                for value in ast.walk(reason):
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        found[(rel, value.value)] += 1
    return found


def test_allowed_reads_only_go_down():
    found = _allows()
    assert set(found) <= set(PINNED_ALLOWS), f"new allowed reads: {set(found) - set(PINNED_ALLOWS)}"
    assert all(reason in read_budget.ALLOW_REASONS for _rel, reason in found)
    grown = {key: n for key, n in found.items() if n > PINNED_ALLOWS[key]}
    stale = {key: n for key, n in PINNED_ALLOWS.items() if found.get(key, 0) < n}
    assert not grown and not stale, (grown, stale)


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (1, 500),  # the crew-log route, from=1&to=500
        (1, 5000),  # taskq/timeline.py with seq_spawned 0
        (BIG - 399, BIG),  # diagnose_probes.py, the newest 400 entries
    ],
)
def test_read_page_shapes_from_its_callers_do_not_raise(start, end):
    _unit("acp-page")
    read_budget.mark_gateway_process()
    page = crew_read.read_page("acp-page", start, end)
    assert page["entries"][0]["seq"] == start and page["last_seq"] == BIG
    assert read_budget.snapshot()["raised"] == 0


def test_a_member_history_page_past_the_retained_window_does_not_raise():
    from kiro_crew.crew_log.schema import KIND_MEMBER
    from kiro_crew.eventlog.log import MAX_RETAINED_EVENTS, MemberLog

    total = MAX_RETAINED_EVENTS + 1000
    handle = CrewLog.create(KIND_MEMBER, "ivy", name="Ivy")
    for at in range(0, total, 1000):
        handle.append_many(
            [{"type": "slot/opened", "data": {"slot_key": f"s{i}"}} for i in range(at, at + 1000)],
            src="gateway",
        )
    handle.release_ownership()
    read_budget.mark_gateway_process()
    page = MemberLog("ivy").history(total - 10, 500)
    assert len(page) == 500 and page[0]["seq"] == total - 11
    assert read_budget.snapshot()["raised"] == 0


def _eight_segments(unit_id: str) -> None:
    """*unit_id* as 8 segments, the shape a rotating writer would leave (none does yet)."""
    head = lg.crew_log_path(lg.KIND_SESSION, unit_id)
    lines = head.read_bytes().splitlines(keepends=True)
    header, entries = lines[0], lines[1:]
    step = len(entries) // 8
    head.write_bytes(header + b"".join(entries[:step]))
    for k in range(1, 8):
        part = entries[k * step : (k + 1) * step if k < 7 else None]
        first = json.loads(part[0])["seq"]
        (head.parent / f"log.{first}.jsonl").write_bytes(header + b"".join(part))


def test_the_crew_log_page_route_reads_a_mid_range_of_a_multi_segment_unit():
    from kiro_crew.dashboard.handlers import crew_log as crew_log_route

    _unit("acp-segs")
    _eight_segments("acp-segs")
    read_budget.mark_gateway_process()
    page = crew_log_route._read_page("acp-segs", BIG - 600, BIG - 100)
    assert len(page["entries"]) == 501 and page["last_seq"] == BIG
    assert read_budget.snapshot()["raised"] == 0


def test_the_task_timeline_reads_a_child_on_a_multi_segment_unit(monkeypatch):
    from types import SimpleNamespace

    from kiro_crew.crew_log import resolve
    from kiro_crew.taskq import timeline

    _unit("acp-segs")
    _eight_segments("acp-segs")
    record = SimpleNamespace(unit="acp-segs", seq_spawned=BIG - 600, omitted=False)
    monkeypatch.setattr(resolve, "child_record", lambda *_a, **_k: record)
    read_budget.mark_gateway_process()
    timeline.read_child_entries([SLOT], "agent-1")
    assert read_budget.snapshot()["raised"] == 0


def test_an_allowed_page_or_get_is_counted_allowed_and_not_warned(caplog):
    import logging

    _unit("acp-allowed-page")
    _eight_segments("acp-allowed-page")
    read_budget.mark_gateway_process()
    handle = CrewLog.open(lg.KIND_SESSION, "acp-allowed-page")
    with caplog.at_level(logging.WARNING, logger=read_budget.__name__):
        with read_budget.allowed("crew_log_page"):
            assert len(handle.page(None, 50).entries) == 50
            assert handle.get(BIG - 1).seq == BIG - 1
    handle.release_ownership()
    counts = read_budget.snapshot()
    assert counts["allowed"] == 2 and counts["over_budget"] == 0 and counts["raised"] == 0
    assert not [r for r in caplog.records if "over budget" in r.getMessage()]


def test_a_listed_row_counts_an_unfamiliar_entry_type_as_the_walk_does():
    _unit("acp-list-new")
    handle = CrewLog.open(lg.KIND_SESSION, "acp-list-new")
    handle.append("message/from-a-newer-writer", {"n": 1}, src="gateway", ignorable=True)
    handle.append("ledger/recorded", {"slot": SLOT, "goal": "after"}, src="gateway")
    handle.release_ownership()
    crew_read.list_session_units(limit=10)  # first listing: writes the status savepoint
    listed = crew_read.list_session_units(limit=10)
    row = next(r for r in listed["units"] if r["unit"] == "acp-list-new")
    assert row["entries"] == BIG + 2 and row["last_seq"] == BIG + 2
