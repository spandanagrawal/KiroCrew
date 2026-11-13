"""Carry a folded built-in's on/off state into the core setting that replaced it.

A built-in whose feature moved into core is listed in
``builtins._MIGRATED_BUILTINS``, and the boot cleanup
(``manager_builtins.cleanup_migrated_builtin``) retires its record. When the app's
enabled state WAS the feature's switch, retiring the record would lose the user's
choice, so ``builtins._FOLDED_BUILTIN_SWITCHES`` names the dotted ``config.json``
path that holds the switch now, and :func:`carry_folded_switch` writes the record's
off state there before the record goes.

Every such setting defaults on, as the app did, so only an opt-out is written: a
record that had the feature on needs no key, and an upgrade writes nothing to
``config.json`` for it. An off record overwrites a ``true`` already in the file:
a gateway that writes its whole document (first-run setup, a migration) stores
every default, so a ``true`` there says nothing about the user, and nobody could
have chosen it in Settings while the record still stood, since the cleanup runs at
the first start of the build that shows the setting.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kiro_crew.apps.manager import InstalledApp


def folded_switch_path(name: str) -> str | None:
    """The dotted config path that replaced app *name*'s enabled state, if any."""
    from kiro_crew.apps.builtins import _FOLDED_BUILTIN_SWITCHES

    return _FOLDED_BUILTIN_SWITCHES.get(name)


def carry_folded_switch(name: str, meta: InstalledApp) -> bool:
    """Write *meta*'s off state to the setting that replaced app *name*.

    Returns whether ``config.json`` was written. Writes nothing for an app with no
    switch row or whose record had it on. ``meta.enabled`` already reads false while
    the owner's protected disable stands (``_read_installed``), so that disable is
    carried too. Raises when the write fails, so the caller keeps the record and the
    next start tries again rather than dropping the user's opt-out.
    """
    path = folded_switch_path(name)
    if path is None or meta.enabled:
        return False
    *parents, key = path.split(".")
    # Call-time import: the config loader is heavy and this runs once per folded app.
    from kiro_crew.config.loader import update_config_locked

    wrote = False

    def _mutate(data: dict) -> dict | None:
        nonlocal wrote
        section = data
        for part in parents:
            child = section.get(part)
            if not isinstance(child, dict):
                # A missing or malformed section carries no setting, the same
                # recovery the dashboard's own config write makes.
                child = section[part] = {}
            section = child
        if section.get(key) is False:
            return None
        section[key] = False
        wrote = True
        return data

    update_config_locked(mutate=_mutate)
    return wrote
