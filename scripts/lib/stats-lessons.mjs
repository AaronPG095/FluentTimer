import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { isTestFile } from './invariants-lint.mjs';

export function loadLessons(dir) {
  const lessonsPath = join(dir, 'docs', 'lessons.md');
  if (!existsSync(lessonsPath)) return [];
  const raw = readFileSync(lessonsPath, 'utf8');
  const lines = raw.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('- ')) continue;
    const m = trimmed.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]*)\|\s*(.+)$/);
    if (m) {
      entries.push({
        date: m[1].trim(),
        meta: m[2].trim(),
        text: m[3].trim(),
        line: i + 1,
        raw: trimmed,
      });
    } else {
      entries.push({
        date: '',
        meta: 'general',
        text: trimmed.slice(2).trim(),
        line: i + 1,
        raw: trimmed,
      });
    }
  }
  return entries;
}

export function parsePlanTypeFromMeta(meta) {
  const title = (meta?.title || '').trim();
  const m = title.match(/^(?:Plan|Debug|Ask)\s*-\s*([^:]+):/i);
  if (m) return m[1].trim();
  if (/^Debug\b/i.test(title)) return 'Debug';
  return 'Unknown';
}

export function parseIsoDayOrMs(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const ms = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(ms) ? null : ms;
}

export function isNoiseFileForDefects(filePath, cfg = {}) {
  const normPath = String(filePath || '').replace(/\\/g, '/');
  const base = basename(normPath);
  if (
    ['README.md', 'CHANGELOG.md', 'AGENTS.md', 'CLAUDE.md'].includes(base) ||
    normPath.endsWith('.md') ||
    normPath.endsWith('.resw') ||
    isTestFile(normPath, cfg)
  ) {
    return true;
  }
  const ignoreList = cfg.stats?.ignoreFiles;
  if (Array.isArray(ignoreList) && ignoreList.length) {
    return ignoreList.some((pattern) => {
      if (pattern.startsWith('*.')) return base.endsWith(pattern.slice(1));
      return normPath === pattern || base === pattern || normPath.startsWith(`${pattern}/`);
    });
  }
  return false;
}

export function rangesOverlap(rangesA, rangesB) {
  if (!rangesA.length || !rangesB.length) return true;
  return rangesA.some(([a0, a1]) =>
    rangesB.some(([b0, b1]) => a0 <= b1 && b0 <= a1),
  );
}
