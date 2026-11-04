"""Keep the voice GPU warm for demo/judging windows, or let it scale to zero.

    python3 scale.py warm      # min_containers=1 (first sound never waits for a cold start, ~25-40 s)
    python3 scale.py warm 2    # keep two warm (busy judging window: a burst never waits for a second cold start)
    python3 scale.py cold      # min_containers=0 (idle container stops after scaledown_window = 5 min)
    python3 scale.py status

A redeploy (`modal deploy voice_app.py`) resets this to the decorator value (min_containers=0), so run
`warm` again after deploying. Use your Modal-enabled Python environment (macOS has `python3`, not `python`): python3 scale.py warm
"""
import os, sys

import modal

APP = os.environ.get("VOICE_APP", "genita-voice")


def set_min(obj, n: int) -> None:
    """modal >= 1.6.2: `.autoscaler.update()`; `.update_autoscaler()` is deprecated there but is the only API before."""
    auto = getattr(obj, "autoscaler", None)
    if auto is not None and callable(getattr(auto, "update", None)):
        auto.update(min_containers=n)
    else:
        obj.update_autoscaler(min_containers=n)


def main(cmd: str, n: int = 1) -> None:
    obj = modal.Cls.from_name(APP, "Voice")()
    if cmd == "warm":
        if not 1 <= n <= 4:
            sys.exit("warm takes 1..4 (max_containers is 4)")
        set_min(obj, n)
    elif cmd == "cold":
        set_min(obj, 0)
    elif cmd != "status":
        sys.exit(__doc__)
    print(f"{APP}: {cmd} done")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "status", int(sys.argv[2]) if len(sys.argv) > 2 else 1)
