#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '../../README.md');

const START_MARKER = '<!-- START_OSS_PRS -->';
const END_MARKER = '<!-- END_OSS_PRS -->';

// 1. Resolve GitHub Token
let token = process.env.GITHUB_TOKEN;
if (!token) {
  try {
    token = execSync('gh auth token', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // fallback attempt if local gh CLI is unauthenticated or missing
  }
}

if (!token) {
  console.error('Error: GITHUB_TOKEN environment variable is not set and gh CLI auth token could not be retrieved.');
  process.exit(1);
}

// 2. Query GitHub GraphQL API for MERGED pull requests only
const query = `
query {
  search(query: "is:pr is:merged author:Aryan9891 is:public -user:Aryan9891", type: ISSUE, first: 100) {
    issueCount
    nodes {
      ... on PullRequest {
        number
        title
        url
        state
        mergedAt
        createdAt
        repository {
          nameWithOwner
          url
          stargazerCount
          primaryLanguage {
            name
          }
        }
      }
    }
  }
}
`;

console.log('Querying GitHub GraphQL API for merged open-source PRs authored by Aryan9891...');
let result = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Aryan9891-OSS-PR-Sync'
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API responded with status ${response.status}: ${errorText}`);
      process.exit(1);
    }

    result = await response.json();
    if (result.errors && result.errors.length > 0) {
      console.error('GraphQL Query Errors:', JSON.stringify(result.errors, null, 2));
      process.exit(1);
    }
    break;
  } catch (err) {
    if (attempt === 4) {
      console.error('All 4 fetch attempts failed:', err.message);
      process.exit(1);
    }
    console.log(`Fetch attempt ${attempt} failed (${err.message}). Retrying in 1.5s...`);
    await new Promise(r => setTimeout(r, 1500));
  }
}

const rawNodes = result?.data?.search?.nodes || [];
console.log(`Found ${rawNodes.length} public Pull Requests.`);

// 3. Keep ONLY MERGED PRs in repositories with strictly > 10,000 stars
const prs = rawNodes.filter(pr => {
  if (!pr || pr.state !== 'MERGED') return false;
  const stars = pr.repository?.stargazerCount ?? 0;
  return stars > 10000;
});
console.log(`Retained ${prs.length} MERGED Pull Requests in repositories with >10,000 stars.`);

// 4. Sort: Repositories by star count descending, then by PR number descending
prs.sort((a, b) => {
  const starsA = a.repository?.stargazerCount ?? 0;
  const starsB = b.repository?.stargazerCount ?? 0;
  if (starsB !== starsA) return starsB - starsA;

  const repoA = (a.repository?.nameWithOwner || '').toLowerCase();
  const repoB = (b.repository?.nameWithOwner || '').toLowerCase();
  const repoCompare = repoA.localeCompare(repoB);
  if (repoCompare !== 0) return repoCompare;

  return b.number - a.number;
});

// 5. Star formatting utility (e.g. 458.2k ★, 143.2k ★)
function formatStars(count) {
  if (typeof count !== 'number' || isNaN(count)) return '0 ★';
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M ★`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k ★`;
  }
  return `${count} ★`;
}

// 6. Status badge formatting utility
function getStatusBadge(state) {
  if (state === 'MERGED') {
    return '![Merged](https://img.shields.io/badge/Merged-8957e5?style=flat-square&logo=github)';
  }
  return `![${state}](https://img.shields.io/badge/${state}-gray?style=flat-square)`;
}

// 7. Generate Clean Markdown Table
const tableLines = [
  '| Repository | Stars | Pull Request | Language | Status |',
  '|:---|:---:|:---|:---:|:---:|'
];

for (const pr of prs) {
  const repoName = pr.repository?.nameWithOwner || 'Unknown Repo';
  const repoUrl = pr.repository?.url || pr.url;
  const repoLink = `[${repoName}](${repoUrl})`;

  const stars = formatStars(pr.repository?.stargazerCount ?? 0);

  const cleanTitle = (pr.title || 'Untitled PR').replace(/\|/g, '\\|').trim();
  const prLink = `[#${pr.number}](${pr.url}): ${cleanTitle}`;

  const lang = pr.repository?.primaryLanguage?.name || 'Markdown';
  const badge = getStatusBadge(pr.state);

  tableLines.push(`| ${repoLink} | ${stars} | ${prLink} | ${lang} | ${badge} |`);
}

const tableMarkdown = tableLines.join('\n');

// 8. Read README.md and replace content between markers
const readmeContent = readFileSync(README_PATH, 'utf-8');

const startIndex = readmeContent.indexOf(START_MARKER);
const endIndex = readmeContent.indexOf(END_MARKER);

if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
  console.error(`Error: Could not locate markers ${START_MARKER} and ${END_MARKER} in ${README_PATH}`);
  process.exit(1);
}

// Extract existing content inside markers
const existingBetween = readmeContent.substring(startIndex + START_MARKER.length, endIndex).trim();

// Strip timestamp for content comparison to avoid spurious commits
function stripTimestamp(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.toLowerCase().includes('last auto-updated via github actions'))
    .join('\n');
}

const cleanExisting = stripTimestamp(existingBetween);
const cleanNew = stripTimestamp(tableMarkdown);

if (cleanExisting === cleanNew) {
  console.log('No PR status, star, or table content changes detected. README.md is already up to date.');
  process.exit(0);
}

const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const newReplacement = `\n${tableMarkdown}\n\n*Last auto-updated via GitHub Actions: ${timestamp}*\n`;

const updatedReadme =
  readmeContent.substring(0, startIndex + START_MARKER.length) +
  newReplacement +
  readmeContent.substring(endIndex);

writeFileSync(README_PATH, updatedReadme, 'utf-8');
console.log('Successfully updated README.md with live merged >10k star PRs.');
