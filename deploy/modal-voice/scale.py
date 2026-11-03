"""Keep the voice GPU warm for demo/judging windows, or let it scale to zero.

    python scale.py warm      # min_containers=1 (first sound never waits for a cold start, ~25-40 s)
    python scale.py warm 2    # keep two warm (busy judging window: a burst never waits for a second cold start)
    python scale.py cold      # min_containers=0 (idle container stops after scaledown_window = 5 min)
    python scale.py status

A redeploy (`modal deploy voice_app.py`) resets this to the decorator value (min_containers=0), so run
`warm` again after deploying. Use your Modal-enabled Python environment: python scale.py warm
"""
import os, sys

import modal

APP = os.environ.get("VOICE_APP", "genita-voice")


def main(cmd: str, n: int = 1) -> None:
    obj = modal.Cls.from_name(APP, "Voice")()
    if cmd == "warm":
        if not 1 <= n <= 4:
            sys.exit("warm takes 1..4 (max_containers is 4)")
        obj.update_autoscaler(min_containers=n)
    elif cmd == "cold":
        obj.update_autoscaler(min_containers=0)
    elif cmd != "status":
        sys.exit(__doc__)
    print(f"{APP}: {cmd} done")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "status", int(sys.argv[2]) if len(sys.argv) > 2 else 1)
