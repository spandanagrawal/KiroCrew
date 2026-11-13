"""Whether Task Runner may start a new run: the ``taskrunner.enabled`` switch.

An install that still holds a ``projects`` app record (the built-in app Task Runner
was) has that record's off state carried into the setting once by the dashboard's
boot cleanup (:mod:`kiro_crew.apps.builtin_fold`) before the record is retired. Until
then the record itself is read too: a gateway started without the dashboard never
runs that cleanup, and a cleanup whose write failed keeps the record, so an off
record still refuses the start.

The operator's ``apps`` governance allowlist decides it under the name ``projects``,
so a policy that does not list ``projects`` keeps Task Runner off whatever the local
setting says.

Only new starts read it: a run already going keeps going, and its page stays open.
"""

from __future__ import annotations

#: The built-in app Task Runner was, and the name the ``apps`` allowlist knows it by.
TASK_RUNNER_FORMER_APP = "projects"

#: The answer every start path gives while the setting is off.
TASK_RUNNER_OFF_MESSAGE = (
    "Task Runner is turned off. Turn it on in Settings > Display > View to start tasks."
)


def task_runner_off() -> str | None:
    """Why a new Task Runner start is refused, or ``None`` when it may go ahead.

    Blocking (it reads the config files and the governance policy), so an async
    caller runs it in a worker thread.
    """
    # Call-time imports: the config loader and the activation gate are heavy, and
    # every caller already runs this off the event loop.
    from kiro_crew.apps.manager import _app_activation_denied, _read_installed
    from kiro_crew.config.loader import KiroCrewConfig

    if not KiroCrewConfig.load().taskrunner.enabled:
        return TASK_RUNNER_OFF_MESSAGE
    record = _read_installed(TASK_RUNNER_FORMER_APP)
    if record is not None and not record.enabled:
        return TASK_RUNNER_OFF_MESSAGE
    denied = _app_activation_denied(TASK_RUNNER_FORMER_APP)
    return f"Task Runner is turned off by policy: {denied}" if denied else None
