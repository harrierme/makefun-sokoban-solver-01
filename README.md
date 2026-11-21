[![Build the best Sokoban solver, 21 November 2026](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Rank](https://make.fun/badge/sokoban-solver-01-run-20261121/harrierme/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Reward](https://make.fun/badge/sokoban-solver-01-run-20261121/harrierme/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban Solver

A push-optimal Sokoban solver that answers a whole set of 5 levels in one
run, in well under the 60-second budget. It scores the maximum 1,000,000 on
the practice set and on 20 freshly drawn sets from the competition's own
generator (100 instances, every one solved in exactly its push-optimal
count).

## How it works

The generated levels are a one-cell-wide hallway with one to four small
rooms (3-4 boxes each) opening onto it through a single door. A box pushed
out of a room can never come back, so every room is independent and a
level's push-optimal count is the sum of the rooms' optima. The solver
exploits that structure:

- It splits each level into its rooms by flood fill, with the hallway row
  (the row the player starts on) removed.
- It solves each room on its own with a push-optimal A* over pushes:
  states are (box positions, player reachable region), the heuristic is
  the cheapest assignment of boxes to goals by shortest-path distance,
  and dead squares (found by a reverse pull-BFS from the goals) prune
  lost states.
- It requires the player to be able to walk back out of every room but
  the last one solved, so the room solutions stitch together with plain
  walks along the hallway and the total push count stays optimal.
- If A* ever ran out of its node budget, a greedy best-first search
  falls back to any solution rather than none.

The search is bounded by expanded nodes, never by the wall clock, and it
uses no randomness, so two runs write identical bytes.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads `level.txt` for every
instance under the input directory and writes `solution.txt` (the player's
moves in `u`/`d`/`l`/`r`) for each one under the output directory.

## Verification

Scored with the kit's own scorer on the practice set:

```text
score 1,000,000 — passed 1, answered 5 of 5
i001: solved in 13 pushes (P* 13)
i002: solved in 16 pushes (P* 16)
i003: solved in 29 pushes (P* 29)
i004: solved in 47 pushes (P* 47)
i005: solved in 60 pushes (P* 60)
```

Then stress-tested on 20 further sets drawn with the kit's generator from
fresh seeds (100 instances): every set scored 1,000,000, every instance
solved in exactly its push-optimal count, worst run 1.5 seconds for a whole
set. Two runs on the practice set write byte-identical outputs.

Built for [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121) on make.fun.
