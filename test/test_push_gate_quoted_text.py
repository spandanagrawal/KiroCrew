"""The push floor reads quoted text the way bash does.

Two false positives from recorded blocks: a ``"$(...)"`` in an EARLIER command, and a
newline inside a quoted commit message before the push. Each was refused as an
unverifiable push target although the push itself names a plain feature branch.
"""

from __future__ import annotations

import pytest

from kiro_crew.security import is_denied

ALLOWED = [
    # quoted substitution before the push (17 recorded blocks)
    'B="$(pwd)"; git push -q -u origin feat/x',
    'B="$(git rev-parse --absolute-git-dir)/body.md" && git push -q -u origin feat/x',
    'X="$(echo ")")"; git push origin feat/x',
    # newline inside a quoted commit message (17 recorded blocks)
    'git commit -q -m "fix: a\n\nbody line" && git push origin feat/x',
    "git commit -q -m 'fix: a\nb' && git push -q origin feat/x",
]

DENIED = [
    'B="$(pwd)"; git push origin main',
    'X="$(git push origin main)"',
    'git push origin "$(echo main)"',
    'git push origin feat/x "$(echo main)"',
    'git commit -m "a\nb" && git push origin main',
    'git commit -m "a\nb" && git push origin "$BR"',
    'git commit -m "a\nb" && git push',
    # a quote the state machine sees but bash does not: comment and heredoc body
    "echo hi # don't\ngit push origin main",
    "git push origin feat # it's\ngit push origin main # it's",
    "cat <<'EOF' > f\nit's\nEOF\ngit push origin feat 'x\ngit push origin main",
    "cat <<'EOF' > f\ndon't\nEOF\ngit push origin main",
    "cat <<EOF > f\nit's \"\nEOF\ngit push origin main",
]


@pytest.mark.parametrize("command", ALLOWED)
def test_plain_feature_push_after_quoted_text_is_allowed(command: str) -> None:
    assert is_denied(command) is None


@pytest.mark.parametrize("command", DENIED)
def test_protected_or_unverifiable_push_stays_denied(command: str) -> None:
    assert is_denied(command) is not None
