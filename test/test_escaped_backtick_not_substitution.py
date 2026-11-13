"""An escaped backtick is a literal character, not a command substitution.

Recorded false positive: a ``sed -i "s|...\\`kirocrew-dashboard\\`...|"`` edit was
refused by the self-kill floor, because ``\\``` in double quotes opened a fake
substitution whose body read as a command.
"""

from __future__ import annotations

import pytest

from kiro_crew.security import is_denied

ALLOWED = [
    'sed -i "s|x|fire \\`kirocrew-dashboard\\`, which|" a.ts && git diff a.ts',
    # recorded block, verbatim (sed edits of two test files)
    "sed -i \"s| \\* does is replace the field bag and post a message, which the page's existing"
    " script| * does is replace the field bag and fire \\`kirocrew-dashboard\\`, which the page's"
    ' script|" src/test/projectReportPage.test.ts && sed -i "s|/\\*\\* A host push: the page\'s own'
    " message listener re-renders on the next tick. \\*/|/** A host push: the page's"
    ' \\`kirocrew-dashboard\\` listener re-renders on the next tick. */|"'
    " src/test/orgChartFoldPage.test.ts && git diff src/test",
]

DENIED = [
    'echo "`pkill -f kirocrew`"',
    "echo `pkill -f kirocrew`",
    'bash -c "echo \\`pkill -f kirocrew\\`"',
    "echo pkill -f kirocrew | sh",
    "echo pkill -f 'kirocrew;' | sh",
    "{ echo pkill -f kirocrew; } | sh",
]


@pytest.mark.parametrize("command", ALLOWED)
def test_escaped_backtick_is_literal(command: str) -> None:
    assert is_denied(command) is None


@pytest.mark.parametrize("command", DENIED)
def test_real_substitution_or_evaluator_stays_denied(command: str) -> None:
    assert is_denied(command) is not None
