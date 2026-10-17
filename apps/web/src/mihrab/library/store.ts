// Reading progress, last position and bookmarks: per-reader conveniences kept
// in this browser. A change event keeps every open view in step.
import { useEffect, useState } from "react";
import { readStorage, writeStorage } from "../../kit/util";

const EVENT = "mihrab-library-store";
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(readStorage(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  writeStorage(key, JSON.stringify(value));
  window.dispatchEvent(new Event(EVENT));
}
export function useStore<T>(get: () => T): T {
  const [value, setValue] = useState(get);
  useEffect(() => {
    const on = () => setValue(get());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  return value;
}

// What has been on screen, per chapter, as merged [first, last] item ranges,
// so jumping to a passage does not count everything before it as read.
type Seen = Record<string, Record<string, { total: number; seen: [number, number][] }>>;
const readSeen = () => read<Seen>("mihrab.reading", {});
export function mergeRanges(ranges: [number, number][]) {
  const out: [number, number][] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
// Share of each chapter read, 0..1, keyed by book then chapter.
export type Progress = Record<string, Record<string, number>>;
export function readProgress(): Progress {
  const out: Progress = {};
  for (const [book, chapters] of Object.entries(readSeen()))
    out[book] = Object.fromEntries(
      Object.entries(chapters).map(([c, v]) => [c, v.seen.reduce((n, [a, b]) => n + b - a + 1, 0) / Math.max(1, v.total)]),
    );
  return out;
}
export function recordSeen(book: string, chapter: string, from: number, to: number, total: number) {
  const all = readSeen();
  const was = all[book]?.[chapter];
  const seen = mergeRanges([...(was?.seen || []), [from, to]]);
  if (was && JSON.stringify(was.seen) === JSON.stringify(seen)) return;
  write("mihrab.reading", { ...all, [book]: { ...all[book], [chapter]: { total, seen } } });
}

export type LastRead = Record<string, { chapter: string; node?: string; at: number }>;
export const readLastRead = () => read<LastRead>("mihrab.lastRead", {});
export function recordLastRead(book: string, chapter: string, node?: string) {
  const all = readLastRead();
  const was = all[book];
  if (was && was.chapter === chapter && was.node === node) return;
  write("mihrab.lastRead", { ...all, [book]: { chapter, node, at: Date.now() } });
}

export type Bookmark = { id: string; book: string; chapter: string; title: string; at: number };
export const readBookmarks = () => read<Bookmark[]>("mihrab.bookmarks", []);
export function toggleBookmark(b: Omit<Bookmark, "at">) {
  const all = readBookmarks();
  write(
    "mihrab.bookmarks",
    all.some((x) => x.id === b.id) ? all.filter((x) => x.id !== b.id) : [{ ...b, at: Date.now() }, ...all],
  );
}
