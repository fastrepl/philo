import { generateObject, } from "ai";
import { z, } from "zod";
import type { GitHubCommitLinkData, GitHubIssueLinkData, GitHubPrLinkData, LinkKind, PageNote, } from "../types/note";
import { getAiSdkModel, tauriStreamFetch, } from "./ai-sdk";
import { getPagePath, sanitizePageTitle, } from "./paths";
import { loadSettings, resolveActiveAiConfig, } from "./settings";
import { loadPage, savePage, } from "./storage";

const URL_SUMMARY_SCHEMA = z.object({
  title: z.string().trim().min(1,),
  summary: z.string().trim().min(1,),
  followUpQuestions: z.array(z.string().trim().min(1,),).min(3,).max(3,),
},);

const MAX_SOURCE_TEXT_LENGTH = 12000;
const MAX_TITLE_LENGTH = 120;
const MAX_FOLLOW_UP_QUESTIONS = 3;
const MAX_CHANGED_FILES = 10;
const URL_SUMMARY_SYSTEM_PROMPT = `You turn webpage content into concise Philo summary pages.

Rules:
- Use only the provided page content.
- title should be short and human-readable.
- summary should be 2-4 tight paragraphs in plain prose.
- followUpQuestions should be exactly 3 short, concrete prompts the user might ask next.
- Do not mention missing context or speculate beyond the source.
- Keep the tone direct and useful.`;

type GitHubLinkTarget =
  | { kind: "github_pr"; owner: string; repo: string; number: number; canonicalUrl: string; }
  | { kind: "github_issue"; owner: string; repo: string; number: number; canonicalUrl: string; }
  | { kind: "github_commit"; owner: string; repo: string; sha: string; canonicalUrl: string; };

function fnv1a(value: string,) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index,);
    hash = Math.imul(hash, 0x01000193,);
  }
  return (hash >>> 0).toString(36,).padStart(7, "0",).slice(0, 7,);
}

function cleanText(value: string,) {
  return value.replace(/\s+/g, " ",).trim();
}

function trimToLength(value: string, maxLength: number,) {
  const normalized = cleanText(value,);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3,).trim()}...`;
}

function stripHtml(value: string,) {
  if (!value) return "";

  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html",);
    return cleanText(doc.body.textContent ?? "",);
  }

  return cleanText(value.replace(/<[^>]+>/g, " ",),);
}

function sortSearchParams(url: URL,) {
  const entries = Array.from(url.searchParams.entries(),).sort(([leftKey, leftValue,], [rightKey, rightValue,],) => {
    if (leftKey !== rightKey) return leftKey.localeCompare(rightKey,);
    return leftValue.localeCompare(rightValue,);
  },);
  url.search = "";
  for (const [key, value,] of entries) {
    url.searchParams.append(key, value,);
  }
}

function parseGitHubLinkTarget(urlValue: string,): GitHubLinkTarget | null {
  try {
    const url = new URL(urlValue,);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "github.com" && hostname !== "www.github.com") return null;

    const [ownerSegment, repoSegment, resourceSegment, idSegment,] = url.pathname
      .split("/",)
      .filter(Boolean,);
    if (!ownerSegment || !repoSegment || !resourceSegment || !idSegment) return null;

    const owner = ownerSegment.toLowerCase();
    const repo = repoSegment.toLowerCase();

    if (resourceSegment === "pull" || resourceSegment === "issues") {
      const number = Number.parseInt(idSegment, 10,);
      if (!Number.isInteger(number,) || number <= 0) return null;
      if (resourceSegment === "pull") {
        return {
          kind: "github_pr" as const,
          owner,
          repo,
          number,
          canonicalUrl: `https://github.com/${owner}/${repo}/pull/${number}`,
        };
      }

      return {
        kind: "github_issue" as const,
        owner,
        repo,
        number,
        canonicalUrl: `https://github.com/${owner}/${repo}/issues/${number}`,
      };
    }

    if (resourceSegment !== "commit") return null;
    const sha = idSegment.toLowerCase();
    if (!/^[0-9a-f]{7,40}$/i.test(sha,)) return null;
    return {
      kind: "github_commit" as const,
      owner,
      repo,
      sha,
      canonicalUrl: `https://github.com/${owner}/${repo}/commit/${sha}`,
    };
  } catch {
    return null;
  }
}

export function normalizeUrlForSummary(raw: string,) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed,);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.username = "";
    url.password = "";
    url.hash = "";

    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }

    const githubTarget = parseGitHubLinkTarget(url.toString(),);
    if (githubTarget) return githubTarget.canonicalUrl;

    sortSearchParams(url,);

    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "",) || "/";
    }

    return url.toString();
  } catch {
    return null;
  }
}

function getUrlHostname(url: string,) {
  try {
    return new URL(url,).hostname.replace(/^www\./, "",);
  } catch {
    return url;
  }
}

function buildGitHubPageTitle(target: GitHubLinkTarget, normalizedUrl: string,) {
  if (target.kind === "github_commit") {
    return sanitizePageTitle(
      `GitHub commit ${target.owner} ${target.repo} ${target.sha.slice(0, 7,)} ${fnv1a(normalizedUrl,)}`,
    ) || `GitHub commit ${fnv1a(normalizedUrl,)}`;
  }

  const kindLabel = target.kind === "github_pr" ? "pull request" : "issue";
  return sanitizePageTitle(
    `GitHub ${kindLabel} ${target.owner} ${target.repo} ${target.number} ${fnv1a(normalizedUrl,)}`,
  ) || `GitHub ${kindLabel} ${fnv1a(normalizedUrl,)}`;
}

export function buildUrlSummaryPageTitle(rawUrl: string,) {
  const normalized = normalizeUrlForSummary(rawUrl,);
  if (!normalized) {
    throw new Error("URL must be a valid http(s) address.",);
  }

  const githubTarget = parseGitHubLinkTarget(normalized,);
  if (githubTarget) {
    return buildGitHubPageTitle(githubTarget, normalized,);
  }

  const hostname = sanitizePageTitle(getUrlHostname(normalized,).replace(/\./g, " ",),) || "Link";
  return sanitizePageTitle(`Link ${hostname} ${fnv1a(normalized,)}`,) || `Link ${fnv1a(normalized,)}`;
}

function getFallbackLabel(url: string,) {
  return trimToLength(getUrlHostname(url,), MAX_TITLE_LENGTH,);
}

function createSummaryContent(summary: string,) {
  const paragraphs = summary
    .split(/\n{2,}/,)
    .map((paragraph,) => cleanText(paragraph,))
    .filter(Boolean,)
    .map((paragraph,) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph, },],
    }));

  return JSON.stringify({
    type: "doc",
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", },],
  },);
}

function normalizeFollowUpQuestions(questions: string[],) {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const question of questions) {
    const normalized = trimToLength(question, 120,);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key,)) continue;
    seen.add(key,);
    cleaned.push(normalized,);
    if (cleaned.length >= MAX_FOLLOW_UP_QUESTIONS) break;
  }

  return cleaned;
}

function isHtmlResponse(contentType: string,) {
  return contentType.includes("text/html",) || contentType.includes("application/xhtml+xml",);
}

function extractMetaContent(doc: Document, selector: string,) {
  const value = doc.querySelector(selector,)?.getAttribute("content",);
  return value ? cleanText(value,) : "";
}

function stripIrrelevantElements(root: ParentNode,) {
  root.querySelectorAll("script, style, noscript, svg, canvas, iframe, nav, footer, header, form, aside",).forEach(
    (element,) => element.remove(),
  );
}

function extractReadableTextFromHtml(html: string,) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html",);
  stripIrrelevantElements(doc,);

  const title = trimToLength(
    extractMetaContent(doc, 'meta[property="og:title"]',)
      || extractMetaContent(doc, 'meta[name="twitter:title"]',)
      || cleanText(doc.title,),
    MAX_TITLE_LENGTH,
  );
  const description = trimToLength(
    extractMetaContent(doc, 'meta[name="description"]',)
      || extractMetaContent(doc, 'meta[property="og:description"]',)
      || extractMetaContent(doc, 'meta[name="twitter:description"]',),
    280,
  );

  const preferredRoot = doc.querySelector("article, main, [role='main']",) ?? doc.body;
  stripIrrelevantElements(preferredRoot,);
  const text = cleanText(preferredRoot.textContent ?? "",).slice(0, MAX_SOURCE_TEXT_LENGTH,);

  return {
    title,
    description,
    text,
  };
}

async function fetchHtmlPage(url: string,) {
  const response = await tauriStreamFetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    },
  },);

  if (!response.ok) {
    throw new Error(`Could not read URL (${response.status}).`,);
  }

  const contentType = response.headers.get("content-type",)?.toLowerCase() ?? "";
  const html = await response.text();
  if (!html.trim()) {
    throw new Error("URL content was empty.",);
  }

  const doc = typeof DOMParser !== "undefined" && isHtmlResponse(contentType,)
    ? new DOMParser().parseFromString(html, "text/html",)
    : null;
  return { html, doc, };
}

async function fetchUrlContent(url: string,) {
  const { html, doc, } = await fetchHtmlPage(url,);
  if (doc) {
    return extractReadableTextFromHtml(html,);
  }

  return {
    title: "",
    description: "",
    text: cleanText(html,).slice(0, MAX_SOURCE_TEXT_LENGTH,),
  };
}

async function summarizeUrlContent(input: {
  normalizedUrl: string;
  linkKind: LinkKind;
  title: string;
  description: string;
  text: string;
},) {
  const settings = await loadSettings();
  const config = resolveActiveAiConfig(settings,);
  if (!config) {
    throw new Error("AI is not configured.",);
  }

  const result = await generateObject({
    model: getAiSdkModel(config, "assistant",),
    schema: URL_SUMMARY_SCHEMA,
    system: URL_SUMMARY_SYSTEM_PROMPT,
    prompt: JSON.stringify(
      {
        page: {
          url: input.normalizedUrl,
          linkKind: input.linkKind,
          extractedTitle: input.title || null,
          description: input.description || null,
        },
        content: input.text,
      },
      null,
      2,
    ),
  },);

  return {
    title: trimToLength(result.object.title, MAX_TITLE_LENGTH,) || getFallbackLabel(input.normalizedUrl,),
    summary: result.object.summary.trim(),
    followUpQuestions: normalizeFollowUpQuestions(result.object.followUpQuestions,),
  };
}

function getEmbeddedReactPayload(html: string,) {
  const match = html.match(
    /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/,
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1],) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractSidebarSection(doc: Document | null, heading: string,) {
  if (!doc) return null;

  return Array.from(doc.querySelectorAll("h3.discussion-sidebar-heading",),).find(
    (element,) => cleanText(element.textContent ?? "",) === heading,
  )?.closest(".discussion-sidebar-item, form, div",) ?? null;
}

function uniqueTexts(values: string[],) {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const value of values.map((entry,) => cleanText(entry,)).filter(Boolean,)) {
    const key = value.toLowerCase();
    if (seen.has(key,)) continue;
    seen.add(key,);
    cleaned.push(value,);
  }

  return cleaned;
}

function extractSidebarPeople(doc: Document | null, heading: string,) {
  const section = extractSidebarSection(doc, heading,);
  if (!section) return [];

  return uniqueTexts(
    Array.from(section.querySelectorAll("a.assignee, a.Link--primary.width-fit",),).map(
      (element,) => element.textContent ?? "",
    ),
  );
}

function extractSidebarLabels(doc: Document | null,) {
  const section = extractSidebarSection(doc, "Labels",);
  if (!section) return [];

  return uniqueTexts(
    Array.from(section.querySelectorAll(".js-issue-labels a, .js-issue-labels span",),)
      .map((element,) => element.textContent ?? "")
      .filter((value,) => cleanText(value,) !== "None yet"),
  );
}

function parseSignedInteger(value: string | null | undefined,) {
  if (!value) return null;
  const match = value.replace(/,/g, "",).match(/[-+]?\d+/,);
  return match ? Number.parseInt(match[0], 10,) : null;
}

function extractChangedFilesFromDoc(doc: Document | null,) {
  if (!doc) return [];

  const files = Array.from(doc.querySelectorAll("[data-path]",),)
    .map((element,) => element.getAttribute("data-path",) ?? "")
    .map((value,) => cleanText(value,))
    .filter((value,) => value && !value.includes("{",));

  return uniqueTexts(files,);
}

async function fetchPullRequestFiles(target: Extract<GitHubLinkTarget, { kind: "github_pr"; }>,) {
  try {
    const { doc, } = await fetchHtmlPage(`${target.canonicalUrl}/files`,);
    const changedFiles = extractChangedFilesFromDoc(doc,);
    return {
      additions: parseSignedInteger(doc?.querySelector("#diffstat .color-fg-success",)?.textContent,),
      deletions: parseSignedInteger(doc?.querySelector("#diffstat .color-fg-danger",)?.textContent,),
      changedFilesCount: changedFiles.length > 0 ? changedFiles.length : null,
      changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES,),
    };
  } catch {
    return {
      additions: null,
      deletions: null,
      changedFilesCount: null,
      changedFiles: [],
    };
  }
}

function formatList(values: string[], fallback = "none",) {
  return values.length > 0 ? values.join(", ",) : fallback;
}

function formatCount(value: number | null,) {
  return value === null ? "unknown" : String(value,);
}

function buildGitHubPrSummaryText(data: GitHubPrLinkData,) {
  return trimToLength(
    [
      "GitHub pull request",
      `Repository: ${data.owner}/${data.repo}`,
      `Number: #${data.number}`,
      `Title: ${data.title}`,
      `State: ${data.state}`,
      `Draft: ${data.isDraft ? "yes" : "no"}`,
      `Merged: ${data.isMerged ? "yes" : "no"}`,
      `Author: ${data.author ?? "unknown"}`,
      `Base branch: ${data.baseBranch ?? "unknown"}`,
      `Head branch: ${data.headBranch ?? "unknown"}`,
      `Labels: ${formatList(data.labels,)}`,
      `Assignees: ${formatList(data.assignees,)}`,
      `Reviewers: ${formatList(data.reviewers,)}`,
      `Commits: ${formatCount(data.commitsCount,)}`,
      `Changed files: ${formatCount(data.changedFilesCount,)}`,
      `Additions: ${formatCount(data.additions,)}`,
      `Deletions: ${formatCount(data.deletions,)}`,
      data.changedFiles.length > 0 ? `Files:\n- ${data.changedFiles.join("\n- ",)}` : "",
    ].filter(Boolean,).join("\n",),
    MAX_SOURCE_TEXT_LENGTH,
  );
}

function buildGitHubIssueSummaryText(data: GitHubIssueLinkData,) {
  return trimToLength(
    [
      "GitHub issue",
      `Repository: ${data.owner}/${data.repo}`,
      `Number: #${data.number}`,
      `Title: ${data.title}`,
      `State: ${data.state}`,
      `Author: ${data.author ?? "unknown"}`,
      `Labels: ${formatList(data.labels,)}`,
      `Assignees: ${formatList(data.assignees,)}`,
      `Opened at: ${data.openedAt ?? "unknown"}`,
      `Closed at: ${data.closedAt ?? "not closed or unavailable"}`,
    ].join("\n",),
    MAX_SOURCE_TEXT_LENGTH,
  );
}

function buildGitHubCommitSummaryText(data: GitHubCommitLinkData,) {
  return trimToLength(
    [
      "GitHub commit",
      `Repository: ${data.owner}/${data.repo}`,
      `SHA: ${data.sha}`,
      `Title: ${data.title}`,
      `Author: ${data.author ?? "unknown"}`,
      `Committed at: ${data.committedAt ?? "unknown"}`,
      `Changed files: ${formatCount(data.changedFilesCount,)}`,
      `Additions: ${formatCount(data.additions,)}`,
      `Deletions: ${formatCount(data.deletions,)}`,
      data.changedFiles.length > 0 ? `Files:\n- ${data.changedFiles.join("\n- ",)}` : "",
    ].filter(Boolean,).join("\n",),
    MAX_SOURCE_TEXT_LENGTH,
  );
}

function getIssueClosedAt(issue: Record<string, unknown>,) {
  const edges = [
    ...(((issue.frontTimelineItems as { edges?: Array<{ node?: Record<string, unknown>; }>; } | undefined)?.edges)
      ?? []),
    ...(((issue.backTimelineItems as { edges?: Array<{ node?: Record<string, unknown>; }>; } | undefined)?.edges)
      ?? []),
  ];

  const closedEvent = edges
    .map((edge,) => edge.node)
    .find((node,) => typeof node?.__typename === "string" && node.__typename.toLowerCase() === "closedevent");

  return typeof closedEvent?.createdAt === "string" ? closedEvent.createdAt : null;
}

async function extractGitHubPrSummary(target: Extract<GitHubLinkTarget, { kind: "github_pr"; }>,) {
  const { html, doc, } = await fetchHtmlPage(target.canonicalUrl,);
  const payload = getEmbeddedReactPayload(html,);
  const route = payload?.payload as {
    pullRequestsLayoutRoute?: {
      pullRequest?: {
        author?: { login?: string | null; };
        baseBranch?: string | null;
        commitsCount?: number | null;
        headBranch?: string | null;
        mergedTime?: string | null;
        number?: number;
        state?: string | null;
        title?: string | null;
      };
      repository?: {
        name?: string | null;
        ownerLogin?: string | null;
      };
    };
  } | undefined;

  const pullRequest = route?.pullRequestsLayoutRoute?.pullRequest;
  const repository = route?.pullRequestsLayoutRoute?.repository;
  if (!pullRequest || !repository) {
    throw new Error("Could not extract GitHub pull request metadata.",);
  }

  const files = await fetchPullRequestFiles(target,);
  const stateLabel = cleanText(doc?.querySelector("[data-status]",)?.textContent ?? pullRequest.state ?? "Open",);
  const data: GitHubPrLinkData = {
    owner: cleanText(repository.ownerLogin ?? target.owner,),
    repo: cleanText(repository.name ?? target.repo,),
    number: pullRequest.number ?? target.number,
    title: cleanText(pullRequest.title ?? "",) || `Pull Request #${target.number}`,
    state: stateLabel || cleanText(pullRequest.state ?? "",) || "Open",
    isDraft: /draft/i.test(stateLabel,),
    isMerged: /merged/i.test(stateLabel,) || !!pullRequest.mergedTime,
    author: cleanText(pullRequest.author?.login ?? "",) || null,
    baseBranch: cleanText(pullRequest.baseBranch ?? "",) || null,
    headBranch: cleanText(pullRequest.headBranch ?? "",) || null,
    labels: extractSidebarLabels(doc,),
    assignees: extractSidebarPeople(doc, "Assignees",),
    reviewers: extractSidebarPeople(doc, "Reviewers",),
    changedFilesCount: files.changedFilesCount,
    commitsCount: typeof pullRequest.commitsCount === "number" ? pullRequest.commitsCount : null,
    additions: files.additions,
    deletions: files.deletions,
    changedFiles: files.changedFiles,
  };

  return {
    linkKind: target.kind,
    linkTitle: data.title,
    description: `GitHub pull request in ${data.owner}/${data.repo}`,
    text: buildGitHubPrSummaryText(data,),
    linkData: data,
  };
}

async function extractGitHubIssueSummary(target: Extract<GitHubLinkTarget, { kind: "github_issue"; }>,) {
  const { html, } = await fetchHtmlPage(target.canonicalUrl,);
  const payload = getEmbeddedReactPayload(html,);
  const issue = (payload?.payload as {
    preloadedQueries?: Array<{
      result?: {
        data?: {
          repository?: {
            issue?: Record<string, unknown>;
          };
        };
      };
    }>;
  } | undefined)?.preloadedQueries?.[0]?.result?.data?.repository?.issue;

  if (!issue) {
    throw new Error("Could not extract GitHub issue metadata.",);
  }

  const repository = issue.repository as { owner?: { login?: string; }; name?: string; } | undefined;
  const labels = ((issue.labels as { edges?: Array<{ node?: { name?: string | null; }; }>; } | undefined)?.edges ?? [])
    .map((edge,) => cleanText(edge.node?.name ?? "",))
    .filter(Boolean,);
  const assignees =
    ((issue.assignedActors as { nodes?: Array<{ login?: string | null; name?: string | null; }>; } | undefined)
      ?.nodes ?? [])
      .map((entry,) => cleanText(entry.login ?? entry.name ?? "",))
      .filter(Boolean,);

  const data: GitHubIssueLinkData = {
    owner: cleanText(repository?.owner?.login ?? target.owner,),
    repo: cleanText(repository?.name ?? target.repo,),
    number: typeof issue.number === "number" ? issue.number : target.number,
    title: cleanText(String(issue.title ?? "",),) || `Issue #${target.number}`,
    state: cleanText(String(issue.state ?? "",),) || "Open",
    author: cleanText(String((issue.author as { login?: string | null; } | undefined)?.login ?? "",),) || null,
    labels: uniqueTexts(labels,),
    assignees: uniqueTexts(assignees,),
    openedAt: typeof issue.createdAt === "string" ? issue.createdAt : null,
    closedAt: getIssueClosedAt(issue,),
  };

  return {
    linkKind: target.kind,
    linkTitle: data.title,
    description: `GitHub issue in ${data.owner}/${data.repo}`,
    text: buildGitHubIssueSummaryText(data,),
    linkData: data,
  };
}

async function extractGitHubCommitSummary(target: Extract<GitHubLinkTarget, { kind: "github_commit"; }>,) {
  const { html, } = await fetchHtmlPage(target.canonicalUrl,);
  const payload = getEmbeddedReactPayload(html,);
  const commitPayload = payload?.payload as {
    commit?: {
      authoredDate?: string | null;
      authors?: Array<{ displayName?: string | null; login?: string | null; }>;
      committedDate?: string | null;
      oid?: string;
      shortMessage?: string | null;
      shortMessageMarkdown?: string | null;
    };
    diffEntryData?: Array<{
      additions?: number | null;
      deletions?: number | null;
      linesAdded?: number | null;
      linesDeleted?: number | null;
      path?: string | null;
    }>;
    repo?: {
      name?: string | null;
      ownerLogin?: string | null;
    };
  } | undefined;

  if (!commitPayload?.commit || !commitPayload.repo) {
    throw new Error("Could not extract GitHub commit metadata.",);
  }

  const changedFiles = uniqueTexts(
    (commitPayload.diffEntryData ?? []).map((entry,) => cleanText(entry.path ?? "",)).filter(Boolean,),
  );
  const additions = (commitPayload.diffEntryData ?? []).reduce(
    (sum, entry,) => sum + (entry.linesAdded ?? entry.additions ?? 0),
    0,
  );
  const deletions = (commitPayload.diffEntryData ?? []).reduce(
    (sum, entry,) => sum + (entry.linesDeleted ?? entry.deletions ?? 0),
    0,
  );
  const commit = commitPayload.commit;
  const data: GitHubCommitLinkData = {
    owner: cleanText(commitPayload.repo.ownerLogin ?? target.owner,),
    repo: cleanText(commitPayload.repo.name ?? target.repo,),
    sha: cleanText(commit.oid ?? target.sha,),
    shortSha: cleanText(commit.oid ?? target.sha,).slice(0, 7,),
    title: stripHtml(commit.shortMessageMarkdown ?? commit.shortMessage ?? "",) || `Commit ${target.sha.slice(0, 7,)}`,
    author: cleanText(commit.authors?.[0]?.login ?? commit.authors?.[0]?.displayName ?? "",) || null,
    committedAt: commit.committedDate ?? commit.authoredDate ?? null,
    changedFilesCount: changedFiles.length,
    additions,
    deletions,
    changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES,),
  };

  return {
    linkKind: target.kind,
    linkTitle: data.title,
    description: `GitHub commit in ${data.owner}/${data.repo}`,
    text: buildGitHubCommitSummaryText(data,),
    linkData: data,
  };
}

async function extractTypedSummary(normalizedUrl: string,) {
  const githubTarget = parseGitHubLinkTarget(normalizedUrl,);
  if (!githubTarget) return null;

  switch (githubTarget.kind) {
    case "github_pr":
      return await extractGitHubPrSummary(githubTarget,);
    case "github_issue":
      return await extractGitHubIssueSummary(githubTarget,);
    case "github_commit":
      return await extractGitHubCommitSummary(githubTarget,);
  }
}

function isTypedGitHubKind(kind: LinkKind | null | undefined,) {
  return kind === "github_pr" || kind === "github_issue" || kind === "github_commit";
}

function shouldReuseExistingPage(page: PageNote, target: GitHubLinkTarget | null,) {
  if (!hasUrlSummaryContent(page,)) return false;
  if (!target) return true;
  return page.linkKind === target.kind && !!page.linkData;
}

export function isUrlSummaryPage(
  page: Pick<PageNote, "source" | "linkTitle" | "summaryUpdatedAt" | "followUpQuestions" | "linkKind" | "linkData">,
) {
  const normalized = page.source ? normalizeUrlForSummary(page.source,) : null;
  return !!normalized && (
    !!page.linkTitle
    || !!page.summaryUpdatedAt
    || page.followUpQuestions.length > 0
    || !!page.linkKind
    || !!page.linkData
  );
}

function hasUrlSummaryContent(page: PageNote,) {
  return !!page.linkTitle
    && !!page.summaryUpdatedAt
    && page.followUpQuestions.length > 0
    && (!isTypedGitHubKind(page.linkKind,) || !!page.linkData);
}

function getGitHubChipLabel(page: Pick<PageNote, "source" | "linkKind" | "linkData">,) {
  if (page.linkKind === "github_pr" && page.linkData) {
    const data = page.linkData as GitHubPrLinkData;
    return `${data.owner}/${data.repo} PR #${data.number}`;
  }

  if (page.linkKind === "github_issue" && page.linkData) {
    const data = page.linkData as GitHubIssueLinkData;
    return `${data.owner}/${data.repo} Issue #${data.number}`;
  }

  if (page.linkKind === "github_commit" && page.linkData) {
    const data = page.linkData as GitHubCommitLinkData;
    return `${data.owner}/${data.repo} @ ${data.shortSha}`;
  }

  const target = page.source ? parseGitHubLinkTarget(page.source,) : null;
  if (!target) return "";
  if (target.kind === "github_commit") {
    return `${target.owner}/${target.repo} @ ${target.sha.slice(0, 7,)}`;
  }
  return `${target.owner}/${target.repo} ${target.kind === "github_pr" ? "PR" : "Issue"} #${target.number}`;
}

export function getUrlSummaryPageChipLabel(
  page: Pick<PageNote, "source" | "linkTitle" | "linkKind" | "linkData">,
) {
  const normalized = page.source ? normalizeUrlForSummary(page.source,) : null;
  if (!normalized) return page.linkTitle ?? "";

  if (isTypedGitHubKind(page.linkKind,) || parseGitHubLinkTarget(normalized,)) {
    const label = getGitHubChipLabel(page,);
    if (label) return trimToLength(label, MAX_TITLE_LENGTH,);
  }

  return trimToLength(page.linkTitle ?? getFallbackLabel(normalized,), MAX_TITLE_LENGTH,);
}

export async function ensureUrlSummaryPage(rawUrl: string,) {
  const normalizedUrl = normalizeUrlForSummary(rawUrl,);
  if (!normalizedUrl) {
    throw new Error("Only bare http(s) URLs can be summarized.",);
  }

  const pageTitle = buildUrlSummaryPageTitle(normalizedUrl,);
  const githubTarget = parseGitHubLinkTarget(normalizedUrl,);
  const existing = await loadPage(pageTitle,);
  if (existing) {
    if (!isUrlSummaryPage(existing,)) {
      throw new Error(`Page title conflict for ${pageTitle}.`,);
    }

    if (shouldReuseExistingPage(existing, githubTarget,)) {
      return {
        page: existing,
        pageTitle,
        normalizedUrl,
        chipLabel: getUrlSummaryPageChipLabel(existing,),
      };
    }
  }

  const typedSummary = await extractTypedSummary(normalizedUrl,).catch(() => null);
  const extracted = typedSummary ?? await (async () => {
    const generic = await fetchUrlContent(normalizedUrl,);
    if (!generic.text) {
      throw new Error("Could not extract readable content from the URL.",);
    }

    return {
      linkKind: "generic" as const,
      linkTitle: generic.title,
      description: generic.description,
      text: generic.text,
      linkData: null,
    };
  })();

  const summarized = await summarizeUrlContent({
    normalizedUrl,
    linkKind: extracted.linkKind,
    title: extracted.linkTitle,
    description: extracted.description,
    text: extracted.text,
  },);

  const now = new Date().toISOString();
  const nextPage: PageNote = existing
    ? {
      ...existing,
      content: createSummaryContent(summarized.summary,),
      source: normalizedUrl,
      linkTitle: extracted.linkTitle || summarized.title,
      summaryUpdatedAt: now,
      followUpQuestions: summarized.followUpQuestions,
      linkKind: extracted.linkKind,
      linkData: extracted.linkData,
    }
    : {
      title: pageTitle,
      path: await getPagePath(pageTitle,),
      content: createSummaryContent(summarized.summary,),
      type: "page",
      attachedTo: null,
      eventId: null,
      startedAt: null,
      endedAt: null,
      participants: [],
      location: null,
      executiveSummary: null,
      sessionKind: null,
      agenda: [],
      actionItems: [],
      source: normalizedUrl,
      linkTitle: extracted.linkTitle || summarized.title,
      summaryUpdatedAt: now,
      followUpQuestions: summarized.followUpQuestions,
      linkKind: extracted.linkKind,
      linkData: extracted.linkData,
      frontmatter: {},
      hasFrontmatter: true,
    };

  await savePage(nextPage,);

  return {
    page: nextPage,
    pageTitle,
    normalizedUrl,
    chipLabel: getUrlSummaryPageChipLabel(nextPage,),
  };
}
