// Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026".
//
// One program answers all 5 instances of a set in a single run. The levels are
// generated as a one-cell-wide hallway with one to four small rooms (3-4 boxes
// each) opening onto it through a single door. A box pushed out of a room can
// never come back, so every room is independent and the level's push-optimal
// count is the sum of the rooms' optima. This solver exploits that: it finds
// the rooms, solves each one on its own with a push-optimal A* (minimum
// matching heuristic plus dead-square pruning), and stitches the room
// solutions together with walks along the hallway. No wall clock, no
// randomness: the search is bounded by expanded nodes only, so two runs
// write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dRow, dCol, letter]. 'u' moves the player one row up, and so on.
const DIRS = [[-1, 0, 'u'], [1, 0, 'd'], [0, -1, 'l'], [0, 1, 'r']];
// Per-room A* expansion budget. Rooms hold at most 4 boxes in at most 36
// cells; the budget is far above what the search needs, and it bounds the
// work by nodes, never by the clock, so the run stays deterministic.
const ROOM_NODE_BUDGET = 2000000;
// Greedy fallback budget when A* runs out (finds any solution, not optimal).
const GREEDY_NODE_BUDGET = 300000;

// ---------- small helpers ----------

// Binary min-heap of [f, h, seq, key]. Ties break by h, then insertion order,
// so the order is fully deterministic.
function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const a = heap[i], b = heap[p];
    if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
      heap[i] = b; heap[p] = a; i = p;
    } else break;
  }
}
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      const cmp = (x, y) => {
        const a = heap[x], b = heap[y];
        return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
      };
      if (l < heap.length && cmp(l, m)) m = l;
      if (r < heap.length && cmp(r, m)) m = r;
      if (m === i) break;
      const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
    }
  }
  return top;
}

// All permutations of [0..n-1], as arrays. n is at most 4 here.
function permutations(n) {
  const out = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k) => {
    if (k === n) { out.push(a.slice()); return; }
    for (let i = k; i < n; i++) {
      const t = a[k]; a[k] = a[i]; a[i] = t;
      gen(k + 1);
      a[i] = a[k]; a[k] = t;
    }
  };
  gen(0);
  return out;
}

// ---------- level parsing ----------

function parseLevel(text) {
  const rows = text.split('\n').filter((l) => l.length > 0);
  const H = rows.length;
  const W = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => r.padEnd(W, '#'));
  const wall = (r, c) => r < 0 || r >= H || c < 0 || c >= W || grid[r][c] === '#';
  const floor = (r, c) => !wall(r, c);
  let start = null;
  const boxes = [];
  const goals = new Set();
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const ch = grid[r][c];
      if (ch === '@' || ch === '+') start = [r, c];
      if (ch === '$' || ch === '*') boxes.push([r, c]);
      if (ch === '.' || ch === '*' || ch === '+') goals.add(r + ',' + c);
    }
  }
  if (!start) return null;
  const hall = start[0];
  // Rooms: connected components of floor cells with the hallway row removed.
  const seen = new Set();
  const rooms = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (r === hall || !floor(r, c) || seen.has(r + ',' + c)) continue;
      const comp = [];
      const stack = [[r, c]];
      seen.add(r + ',' + c);
      while (stack.length > 0) {
        const [a, b] = stack.pop();
        comp.push([a, b]);
        for (const [dr, dc] of DIRS) {
          const na = a + dr, nb = b + dc;
          if (na === hall || !floor(na, nb) || seen.has(na + ',' + nb)) continue;
          seen.add(na + ',' + nb);
          stack.push([na, nb]);
        }
      }
      rooms.push(comp);
    }
  }
  const out = [];
  for (const comp of rooms) {
    const set = new Set(comp.map(([r, c]) => r + ',' + c));
    // The door is the room cell adjacent to a hallway floor cell (exactly one).
    const doors = comp.filter(([r, c]) =>
      DIRS.some(([dr, dc]) => r + dr === hall && floor(r + dr, c + dc)));
    if (doors.length === 0) continue;
    doors.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const door = doors[0];
    const entry = [door[0] + (hall > door[0] ? 1 : -1), door[1]];
    const rBoxes = boxes.filter(([r, c]) => set.has(r + ',' + c));
    const rGoals = [...goals].filter((k) => set.has(k)).map((k) => k.split(',').map(Number));
    out.push({ cells: comp, door, entry, boxes: rBoxes, goals: rGoals, hall });
  }
  return { H, W, grid, start, hall, rooms: out, floor };
}

// ---------- per-room push-optimal A* ----------

// Solves one room. The search region is the room's cells plus the entry cell
// (the hallway cell just outside the door). The player starts on the entry
// cell; boxes never leave the room. Returns { moves, pushes, nodes } or null.
// needExit: the player must be able to walk back out to the door afterwards
// (true for every room but the last one solved in the level).
function solveRoom(room, needExit, nodeBudget) {
  const { cells, door, entry, boxes, goals } = room;
  const m = cells.length;
  if (boxes.length === 0) return { moves: '', pushes: 0, nodes: 0 };
  if (boxes.length !== goals.length) return null;
  // Region cells: room cells (index 0..m-1) then the entry cell (index m).
  const region = cells.concat([entry]);
  const n = region.length;
  const idxOf = new Map(region.map(([r, c], i) => [r + ',' + c, i]));
  const cellOf = region;
  const isRoom = (i) => i < m;
  const goalSet = new Set(goals.map(([r, c]) => idxOf.get(r + ',' + c)));
  const doorIdx = idxOf.get(door[0] + ',' + door[1]);
  const entryIdx = m;
  // Neighbours inside the region: [neighbour index, move letter].
  const nbrs = region.map(([r, c]) => {
    const out = [];
    for (const [dr, dc, ch] of DIRS) {
      const j = idxOf.get((r + dr) + ',' + (c + dc));
      if (j !== undefined) out.push([j, ch]);
    }
    return out;
  });
  // All-pairs shortest paths over room cells only (for the heuristic).
  const INF = 1e9;
  const dist = Array.from({ length: m }, () => new Array(m).fill(INF));
  for (let s = 0; s < m; s++) {
    const d = dist[s];
    d[s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const [v] of nbrs[u]) {
        if (v < m && d[v] === INF) { d[v] = d[u] + 1; q.push(v); }
      }
    }
  }
  // Dead squares: a room cell is live when a box on it can still reach a
  // goal by pushes. Reverse pull-BFS from the goals: a cell b is live when
  // a neighbouring live cell a can be reached by pushing b to a, which needs
  // the player to stand on the cell beyond b (2b - a), a region cell.
  const live = new Array(m).fill(false);
  const liveQ = [];
  for (const g of goalSet) { live[g] = true; liveQ.push(g); }
  for (let h = 0; h < liveQ.length; h++) {
    const a = liveQ[h];
    const [ar, ac] = cellOf[a];
    for (const [dr, dc] of DIRS) {
      const br = ar - dr, bc = ac - dc; // b = a - dir
      const bi = idxOf.get(br + ',' + bc);
      if (bi === undefined || !isRoom(bi) || live[bi]) continue;
      // The player stands at 2b - a to push b onto a.
      const pr = 2 * br - ar, pc = 2 * bc - ac;
      if (idxOf.get(pr + ',' + pc) === undefined) continue;
      live[bi] = true;
      liveQ.push(bi);
    }
  }
  const goalList = [...goalSet];
  const perms = permutations(goalList.length);
  const startBoxes = boxes.map(([r, c]) => idxOf.get(r + ',' + c)).sort((a, b) => a - b);
  // Minimum matching heuristic: cheapest assignment of boxes to goals.
  const heuristic = (bx) => {
    let best = INF;
    for (const p of perms) {
      let s = 0;
      for (let k = 0; k < bx.length; k++) {
        const d = dist[bx[k]][goalList[p[k]]];
        if (d >= INF) { s = INF; break; }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };
  // Pack sorted box indices (each < 64) into one number; 63 = no box.
  const pack = (bx) => {
    let v = 0;
    for (let k = 0; k < 4; k++) v |= (k < bx.length ? bx[k] : 63) << (6 * k);
    return v;
  };
  const unpack = (v) => {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const b = (v >> (6 * k)) & 63;
      if (b !== 63) out.push(b);
    }
    return out;
  };
  // Reachable region for the player from `from`, avoiding `boxSet`.
  const reach = (from, boxSet) => {
    const seenR = new Set([from]);
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const [v] of nbrs[u]) {
        if (!boxSet.has(v) && !seenR.has(v)) { seenR.add(v); q.push(v); }
      }
    }
    return seenR;
  };
  // Shortest walk from `from` to `to` avoiding `boxSet`, as a move string.
  const walk = (from, to, boxSet) => {
    if (from === to) return '';
    const parent = new Map([[from, null]]);
    const q = [from];
    for (let h = 0; h < q.length && !parent.has(to); h++) {
      const u = q[h];
      for (const [v, ch] of nbrs[u]) {
        if (!boxSet.has(v) && !parent.has(v)) { parent.set(v, [u, ch]); q.push(v); }
      }
    }
    if (!parent.has(to)) return null;
    let s = '';
    let cur = to;
    while (cur !== from) {
      const [p, ch] = parent.get(cur);
      s = ch + s;
      cur = p;
    }
    return s;
  };
  const isGoalBoxes = (bx) => bx.every((b) => goalSet.has(b));
  // A* (greedy when greedy=true: f = h, for the fallback).
  const search = (greedy, budget) => {
    const startRegion = reach(entryIdx, new Set(startBoxes));
    let regionKey = n;
    for (const c of startRegion) if (c < regionKey) regionKey = c;
    const startKey = (pack(startBoxes) << 6) | regionKey;
    const gScore = new Map([[startKey, 0]]);
    const came = new Map([[startKey, { pk: -1, moves: '', pos: entryIdx }]]);
    const h0 = heuristic(startBoxes);
    if (h0 >= INF) return null;
    const heap = [];
    let seq = 0;
    heapPush(heap, [greedy ? h0 : h0, h0, seq++, startKey]);
    let expanded = 0;
    while (heap.length > 0) {
      const [, , , key] = heapPop(heap);
      const g = gScore.get(key);
      const rec = came.get(key);
      const bx = unpack(key >> 6);
      const boxSet = new Set(bx);
      const region = reach(rec.pos, boxSet);
      if (expanded++ >= budget) return { over: true, nodes: expanded };
      // Goal: every box on a goal, and (unless the last room) the player can
      // walk back out to the door cell.
      if (isGoalBoxes(bx) && (!needExit || region.has(doorIdx))) {
        let moves = '';
        let cur = key;
        const parts = [];
        while (cur !== startKey) {
          const r2 = came.get(cur);
          parts.push(r2.moves);
          cur = r2.pk;
        }
        parts.reverse();
        moves = parts.join('');
        if (needExit) {
          const exitWalk = walk(rec.pos, doorIdx, boxSet);
          if (exitWalk === null) return null;
          const [dr2, dc2] = [cellOf[entryIdx][0] - cellOf[doorIdx][0], cellOf[entryIdx][1] - cellOf[doorIdx][1]];
          const step = DIRS.find(([a, b]) => a === dr2 && b === dc2);
          moves += exitWalk + (step ? step[2] : '');
        }
        return { moves, pushes: g, nodes: expanded };
      }
      for (const b of bx) {
        const [br, bc] = cellOf[b];
        for (const [dr, dc, ch] of DIRS) {
          const behind = idxOf.get((br - dr) + ',' + (bc - dc));
          const target = idxOf.get((br + dr) + ',' + (bc + dc));
          if (behind === undefined || target === undefined) continue;
          if (!region.has(behind)) continue; // player cannot get behind it
          if (!isRoom(target) || boxSet.has(target)) continue; // boxes stay in the room
          const nb = bx.map((x) => (x === b ? target : x)).sort((a, b2) => a - b2);
          const nBoxSet = new Set(nb);
          // Dead-square prune (a box on a non-live, non-goal cell is lost).
          if (nb.some((x) => !live[x] && !goalSet.has(x))) continue;
          const h = heuristic(nb);
          if (h >= INF) continue;
          const w = walk(rec.pos, behind, boxSet);
          if (w === null) continue;
          const nRegion = reach(b, nBoxSet);
          let nRegionKey = n;
          for (const c of nRegion) if (c < nRegionKey) nRegionKey = c;
          const nKey = (pack(nb) << 6) | nRegionKey;
          const ng = g + 1;
          if (ng < (gScore.has(nKey) ? gScore.get(nKey) : INF)) {
            gScore.set(nKey, ng);
            came.set(nKey, { pk: key, moves: w + ch, pos: b });
            heapPush(heap, [greedy ? h : ng + h, h, seq++, nKey]);
          }
        }
      }
    }
    return null;
  };
  const a = search(false, nodeBudget);
  if (a && !a.over) return { moves: a.moves, pushes: a.pushes, nodes: a.nodes };
  const gr = search(true, GREEDY_NODE_BUDGET);
  if (gr && !gr.over) return { moves: gr.moves, pushes: gr.pushes, nodes: (a ? a.nodes : 0) + gr.nodes };
  return null;
}

// ---------- whole level ----------

function solveLevel(text) {
  const level = parseLevel(text);
  if (!level) return { moves: '', rooms: 0, pushes: 0, nodes: 0, ok: false };
  const { start, hall, rooms, floor } = level;
  // Rooms left to right by door column; the last one solved needs no exit.
  const order = rooms.map((r, i) => i).sort((a, b) =>
    (rooms[a].door[1] - rooms[b].door[1]) || (rooms[a].door[0] - rooms[b].door[0]));
  let moves = '';
  let cur = start;
  let totalPushes = 0;
  let totalNodes = 0;
  for (let oi = 0; oi < order.length; oi++) {
    const room = rooms[order[oi]];
    const needExit = oi < order.length - 1;
    // Walk along the hallway row to this room's entry cell.
    const entry = room.entry;
    const path = hallwayWalk(cur, entry, hall, level);
    if (path === null) return { moves: '', rooms: 0, pushes: 0, nodes: totalNodes, ok: false };
    moves += path;
    cur = entry;
    const solved = solveRoom(room, needExit, ROOM_NODE_BUDGET);
    if (!solved) return { moves: '', rooms: order.length, pushes: 0, nodes: totalNodes, ok: false };
    moves += solved.moves;
    totalPushes += solved.pushes;
    totalNodes += solved.nodes;
    cur = entry; // the room solution ends back on the entry cell (or inside it)
    if (!needExit) cur = null; // last room: the player stays inside it
  }
  return { moves, rooms: order.length, pushes: totalPushes, nodes: totalNodes, ok: true };
}

// Shortest walk along the hallway row (row `hall`) from `from` to `to`.
function hallwayWalk(from, to, hall, level) {
  const { floor } = level;
  if (from[0] === to[0] && from[1] === to[1]) return '';
  const key = (r, c) => r + ',' + c;
  const parent = new Map([[key(from[0], from[1]), null]]);
  const q = [from];
  for (let h = 0; h < q.length && !parent.has(key(to[0], to[1])); h++) {
    const [r, c] = q[h];
    for (const [dr, dc, ch] of DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr !== hall || !floor(nr, nc) || parent.has(key(nr, nc))) continue;
      parent.set(key(nr, nc), [[r, c], ch]);
      q.push([nr, nc]);
    }
  }
  if (!parent.has(key(to[0], to[1]))) return null;
  let s = '';
  let cur = key(to[0], to[1]);
  while (cur !== key(from[0], from[1])) {
    const [p, ch] = parent.get(cur);
    s = ch + s;
    cur = key(p[0], p[1]);
  }
  return s;
}

// ---------- driver ----------

for (const id of readdirSync(INPUT).sort()) {
  const level = readFileSync(join(INPUT, id, 'level.txt'), 'utf8');
  const r = solveLevel(level);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${r.moves}\n`);
  console.error(`${id}: ok=${r.ok} rooms=${r.rooms} pushes=${r.pushes} nodes=${r.nodes}`);
}
