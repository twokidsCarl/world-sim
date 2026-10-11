# world-sim

[中文](README.md) | **English**

Simulating upward from physical law, level by level, all the way to civilisation.

This repository holds a set of independent simulation projects. Each began as a very short idea and hangs on one rung of the same ladder of scales; together they answer one question: how does a crowd on one level become a single thing on the next.

## The ladder and the projects

| Level | Unit | What first appears here | Project |
|---|---|---|---|
| L1 Matter | particles | temperature, pressure, phase transitions | [`strata/`](strata) — from microscopic rules to emergence |
| L2 Molecules and cells | molecules | structure, catalysis, order within crowding | [`limn/`](limn) — Goodsell-style scientific illustration |
| L3 Tissues and organs | cells | form, rhythm, defence | — |
| L4 The body | organs | a living whole, pain | [`soma/`](soma) — 3D human anatomy |
| L5 One person | thoughts, habits | self, desire, choice | — |
| L6 Two people | people | mutual guessing, trust, bargaining | [`mindloop/`](mindloop) — I know that you know that I know |
| L7 A small group | people | alliances, secrets, teaching and learning | — |
| L8 Society | crowds | markets, rumours, money, cities | [`polis/`](polis) — a parallel society |
| L9 Civilisation | societies | language, institutions, the lifespan of ideas | — |
| L10 Life and the planet | species, spheres | succession, co-evolution, climate | — |

Each project directory is self-contained, with its own stack, tests and README.

Off the ladder there is also [`idea-loom/`](idea-loom): not a simulation but the UI of the idea pool, and the single entry point to all the simulations.

## The idea pool

[`IDEAS.en.md`](IDEAS.en.md) (Chinese original: [`IDEAS.md`](IDEAS.md)) contains:

- what the existing projects share and how they differ
- the general structure of a simulation
- one trunk (the ladder above) and five threads (propagation, criticality and collapse, depth of mutual guessing, memory, interfaces between levels)
- several verticals (one event through every level) and two branches (made things, worlds of pure rules)
- the ideas ordered by level, each a brief that can be handed straight to Claude
- a clustering by computational kernel: which ideas share the same underlying computation
- coverage: how many ideas sit in each cell of the ladder, and where it is thin
- a sketch of how these simulations might one day connect in structure, engine and UI

The pool is managed by [`idea-loom/`](idea-loom): browse the map, filter, generate, rewrite, merge and discard ideas in its UI, then sync back to these two files. The pool, kernel table and coverage table inside them are generated; do not edit them by hand.

## Shared practice

These are not rules but what several projects turned out to have in common once built:

- **Contract first**: write the data contract first; the engine writes it, the UI reads it.
- **Content apart from mechanism**: cases, scenarios and data are one thing, rules another.
- **Numbers from a deterministic kernel**: the same parameters and seed must give the same result; a language model only narrates.
- **A real anchor**: every simulation must reproduce something real — a conservation law, measured data, the ending of a story with a source.
- **Test invariants**: tests target the kernel and check laws, not snapshots.

## Contributing

Every change goes through a pull request; `main` takes no direct pushes. PRs opened by the repository owner from a branch of this repository are squash-merged automatically.

```sh
tools/pr.sh "<project>: 中文 / English" <path>...

# example
tools/pr.sh "strata: 加入三维盒子 / add a 3D box" strata
```

The script commits only the listed paths, switches no branch and touches nothing else in the working tree, so several sessions can work in the same directory at once.

Everything that goes into git is written in both Chinese and English: documentation, PRs, commit messages, code comments. See [`CLAUDE.md`](CLAUDE.md) for the details.

## License

The code and documentation are released under the [MIT License](LICENSE). Third-party data and assets used by the subprojects are not covered by it and keep their own licences; sources and licences are listed in each subproject's README.
