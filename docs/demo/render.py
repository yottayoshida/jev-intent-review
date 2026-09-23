"""Render docs/demo/demo.svg from a real run's output.

Run the command in COMMAND in a clone of yottayoshida/omamori checked out at e58c04f, with
bench/fixtures/omamori-468/stated-failure-handling.spec.json copied into it, and save stdout:

    python3 docs/demo/render.py out.txt docs/demo/demo.svg

Every line of the excerpt must appear verbatim in out.txt, or nothing is written.
Needs `rich` (pip install rich).
"""

import io
import sys

from rich.console import Console
from rich.text import Text

COMMAND = (
    "jev-intent-review --candidates-only --base 52a58fa --head e58c04f "
    "--intent-spec stated-failure-handling.spec.json"
)

GAP = "…"

EXCERPT = [
    "# jev-intent-review",
    "",
    "**Result: the set was built and nothing was asked.** 60 calls inside the budget, 1502 calls not checked, for the reasons under each requirement.",
    GAP,
    "## R1",
    GAP,
    "Functions reached: 23 the change touched, 20 calling one of those.",
    "Calls in them: 739, of which 56 could be asked about. Budget 20: 0 read, 0 mapped, 0 of those governed, 36 left over, 683 not applicable.",
    GAP,
    "### Inside the budget",
    GAP,
    "- src/atomic_file.rs · open_read_regular — `reject_non_regular(&file, path)` _(in a function the change touched)_",
    "- src/audit/mod.rs · append — `open_audit_rw(&self.path)` _(in a function that calls one the change touched)_",
    "- src/cli/config_cmd.rs · run_override_enable — `resolve_config_path_checked()` _(in a function that calls what the changed code calls, and nothing the change touched)_",
    GAP,
]


def main() -> None:
    out_path, svg_path = sys.argv[1], sys.argv[2]
    with open(out_path, encoding="utf-8") as f:
        real = set(f.read().splitlines())
    missing = [line for line in EXCERPT if line and line != GAP and line not in real]
    if missing:
        sys.exit("not in the output:\n" + "\n".join(missing))

    console = Console(record=True, file=io.StringIO(), width=100, force_terminal=True, color_system="truecolor")
    console.print(Text("$ ", style="bold green") + Text(COMMAND, style="bold"))
    for line in EXCERPT:
        if line == GAP:
            console.print(Text(line, style="dim"))
        elif line.startswith("#"):
            console.print(Text(line, style="bold cyan"))
        elif line.startswith("- "):
            console.print(Text(line, style="yellow"))
        else:
            console.print(Text(line))
    console.save_svg(svg_path, title="jev-intent-review --candidates-only")


if __name__ == "__main__":
    main()
