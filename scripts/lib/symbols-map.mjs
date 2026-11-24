import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFilesRel, isTestFile } from './invariants-lint.mjs';

export function parseDependsOn(plan) {
  const raw = (plan?.meta?.dependsOn || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function collectRepoSymbolMap(dir, { filter = '', maxFiles = 40 } = {}) {
  const filterNorm = String(filter || '').replace(/\\/g, '/').trim().toLowerCase();
  const includeTests = /test|spec/.test(filterNorm);
  let trackedRaw = '';
  try {
    trackedRaw = execFileSync('git', ['ls-files', '-z'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  const rawFiles = trackedRaw
    ? trackedRaw.split('\0').filter(Boolean)
    : listFilesRel(dir);
  const extRe = /\.(?:mjs|js|ts|tsx|cs|py|go|rs)$/i;
  const skipDirRe = /^(?:node_modules|dist|build|coverage|\.worktrees|\.git)\//i;

  const candidates = [];
  for (const f of rawFiles) {
    const norm = f.replace(/\\/g, '/');
    if (!extRe.test(norm) || skipDirRe.test(norm)) continue;
    if (!includeTests && isTestFile(norm)) continue;
    if (filterNorm && !norm.toLowerCase().includes(filterNorm)) continue;
    candidates.push(norm);
  }
  candidates.sort();
  const selected = candidates.slice(0, Math.max(1, maxFiles));

  const files = [];
  for (const rel of selected) {
    const full = join(dir, rel);
    if (!existsSync(full)) continue;
    let content = '';
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const symbols = [];
    let inCommandsObj = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (/^(?:export\s+)?const\s+commands\s*=\s*\{/.test(line)) {
        inCommandsObj = true;
        symbols.push({ kind: 'const', name: 'commands', line: lineNum });
        continue;
      }
      if (inCommandsObj) {
        if (/^\};/.test(line)) {
          inCommandsObj = false;
          continue;
        }
        const cmdMatch = line.match(
          /^\s{2}(?:async\s+)?(?:'([a-zA-Z0-9_-]+)'|"([a-zA-Z0-9_-]+)"|([a-zA-Z0-9_-]+))\s*\(\)\s*\{/,
        );
        if (cmdMatch) {
          const cmdName = cmdMatch[1] || cmdMatch[2] || cmdMatch[3];
          symbols.push({ kind: 'command', name: `commands.${cmdName}`, line: lineNum });
          continue;
        }
      }

      let m =
        line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/) ||
        line.match(/^export\s+class\s+([A-Za-z0-9_$]+)/) ||
        line.match(/^export\s+const\s+([A-Za-z0-9_$]+)/);
      if (m) {
        const kind = line.includes('class ')
          ? 'class'
          : line.includes('function ')
            ? 'function'
            : 'const';
        symbols.push({ kind, name: m[1], line: lineNum });
        continue;
      }

      m = line.match(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
      if (m) {
        symbols.push({ kind: 'function', name: m[1], line: lineNum });
        continue;
      }

      m = line.match(
        /^\s*public\s+(?:sealed\s+|abstract\s+|partial\s+|static\s+)*(class|interface|record|struct|enum)\s+([A-Za-z0-9_]+)/,
      );
      if (m) {
        symbols.push({ kind: m[1], name: m[2], line: lineNum });
        continue;
      }

      m =
        line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/) ||
        line.match(/^class\s+([A-Za-z0-9_]+)/) ||
        line.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)\s*\(/) ||
        line.match(/^pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/) ||
        line.match(/^pub\s+(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/);
      if (m) {
        const kind = /^(?:class|pub\s+(?:struct|enum|trait))/.test(line)
          ? 'type'
          : 'function';
        symbols.push({ kind, name: m[1], line: lineNum });
      }
    }

    files.push({
      file: rel,
      lines: lines.length,
      symbols: symbols.slice(0, 200),
    });
  }

  return {
    repo: basename(dir),
    totalMatchedFiles: candidates.length,
    shownFiles: files.length,
    files,
  };
}
