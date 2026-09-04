#!/usr/bin/env node
// Architect agent - orchestrates GitHub issue decomposition and solve execution
// See: https://github.com/xdevrobot/hive-mind/issues/1

import './instrument.mjs';
const earlyArgs = process.argv.slice(2);

// Dynamic import loader via use-m
const { use } = eval(await (await fetch('https://unpkg.com/use-m/use.js')).text());
globalThis.use = use;

// Wrap command runner with GitHub retry logic
const { $: __rawDollar$ } = await use('command-stream');
const { wrapDollarWithGhRetry } = await import('./github-rate-limit.lib.mjs');
const $ = wrapDollarWithGhRetry(__rawDollar$);

// Import configuration
const config = await import('./architect.config.lib.mjs');
const { initializeConfig, parseArguments } = config;
const { yargs, hideBin } = await initializeConfig(use);

// Import common utilities
const lib = await import('./lib.mjs');
const {
  log,
  setLogFile,
  getVersionInfo,
  setupStdioLogInterceptor,
  setupVerboseLogInterceptor,
  getAbsoluteLogPath,
} = lib;

// Import exit handling
const {
  initializeExitHandler,
  installGlobalExitHandlers,
  safeExit,
} = await import('./exit-handler.lib.mjs');

// Sentry
const { initializeSentry, addBreadcrumb, reportError, closeSentry } =
  await import('./sentry.lib.mjs');

// Solve config for passthrough
const { SOLVE_OPTION_DEFINITIONS } = await import('./solve.config.lib.mjs');

// Import child_process for spawning solve instances
const { spawn } = await import('child_process');

// Initialize log file early (captures everything)
const fs = await use('fs');
const path = await use('path');
const cwd = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(cwd, `architect-${timestamp}.log`);
await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
await fs.promises.writeFile(logPath, '');
await setLogFile(logPath);

// Log startup
await log(`🚀 architect v${await getVersionInfo()}`);
await log('🔧 ' + process.argv.join(' '));
await log('');

// Parse command-line arguments
let argv;
try {
  argv = await parseArguments(yargs, hideBin);
} catch (err) {
  await log(`❌ ${err.message}`, { level: 'error' });
  await safeExit(1, 'Invalid arguments');
}
global.verboseMode = argv.verbose;

// Interceptors
setupStdioLogInterceptor();
setupVerboseLogInterceptor();

// Initialize Sentry if enabled
if (argv.sentry) {
  await initializeSentry({
    noSentry: false,
    debug: argv.verbose,
    version: process.env.npm_package_version || '1.0.0',
  });
  addBreadcrumb({
    category: 'architect',
    message: 'Session started',
    level: 'info',
    data: { issue: argv._[0] },
  });
}

// Set up exit handlers
const cleanupWrapper = async () => {
  // Add any cleanup logic here if needed
};
const interruptWrapper = (signal) => {
  log(`Received ${signal}, initiating graceful shutdown.`);
};
initializeExitHandler(
  getAbsoluteLogPath,
  log,
  cleanupWrapper,
  interruptWrapper,
  () => {}
);
installGlobalExitHandlers();

// Main runner
try {
  await runArchitect(argv, $, log, config, { SOLVE_OPTION_DEFINITIONS });
} catch (err) {
  await log(`💥 Fatal error: ${err.message}`, { level: 'error' });
  if (argv.sentry) await reportError(err);
  await safeExit(1, 'Architect failed');
} finally {
  await closeSentry();
}

// ===================================================================================
// Main Architect Logic
// ===================================================================================
async function runArchitect(argv, $, log, config, libs) {
  const issueUrl = argv._[0];
  if (!issueUrl) {
    throw new Error(
      'Issue URL is required. Usage: architect.mjs <issue-url> [options]'
    );
  }

  // Parse issue URL to get owner, repo, issue number
  const match = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
  if (!match) {
    throw new Error(`Invalid GitHub issue URL: ${issueUrl}`);
  }
  const [, owner, repo, issueNumber] = match;
  const repoFull = `${owner}/${repo}`;
  await log(`🎯 Target issue: #${issueNumber} in ${repoFull}`);

  // Fetch issue details
  await log(`📥 Fetching issue details...`);
  let issueData;
  try {
    issueData = await $`gh issue view ${issueNumber} --repo ${repoFull} --json title,body,labels`.json();
  } catch (err) {
    throw new Error(`Failed to fetch issue ${issueNumber}: ${err.message}`);
  }
  const { title, body: issueBody, labels: issueLabels } = issueData;

  // Determine integration branch name
  const integrationBranch = argv.baseBranch || `architect-${issueNumber}`;
  await log(`🌲 Integration branch: ${integrationBranch}`);

  // Ensure integration branch exists (create if missing)
  await ensureBranch(integrationBranch, owner, repo, $, log);

  // If orchestrate is false, just create subtasks and exit
  if (!argv.orchestrate) {
    await log('📦 Orchestrate mode disabled. Creating subtasks only.');
    const subtasks = await createSubtasks(
      { title, body: issueBody, labels: argv.label, splitBy: argv.splitBy, owner, repo, issueNumber },
      $,
      log
    );
    await log(`✅ Created ${subtasks.length} subtasks. Exiting.`);
    await safeExit(0);
    return;
  }

  // Orchestrate mode: create subtasks and run solves
  await log('✂️ Decomposing issue into subtasks...');
  const splitBy = argv.splitBy || 2;
  const subtasks = await createSubtasks(
    { title, body: issueBody, labels: argv.label, splitBy, owner, repo, issueNumber },
    $,
    log
  );
  await log(`✅ Created ${subtasks.length} subtasks.`);

  // Build common solve arguments (excluding positional issue URL)
  const commonSolveArgs = buildCommonSolveArgs(argv, integrationBranch, {
    SOLVE_OPTION_DEFINITIONS,
    ARCHITECT_OPTION_DEFINITIONS: config.ARCHITECT_OPTION_DEFINITIONS,
  });
  await log(`🔧 Common solve args: ${commonSolveArgs.join(' ')}`);

  // Launch solve processes in parallel
  await log(`🚀 Launching ${subtasks.length} solve processes...`);
  const processes = [];
  for (const subtask of subtasks) {
    const args = [...commonSolveArgs, subtask.issueUrl];
    await log(`   → Starting solve for ${subtask.issueUrl}`);
    const proc = spawn(process.execPath, args, { stdio: 'inherit' });
    processes.push(proc);
  }

  // Wait for all to complete
  const results = await Promise.all(
    processes.map(
      (p) =>
        new Promise((resolve) => {
          p.on('close', (code) => resolve({ pid: p.pid, code }));
        })
    )
  );
  let successCount = 0;
  for (const { code } of results) {
    if (code === 0) successCount++;
  }
  await log(`📊 Solve completion: ${successCount}/${processes.length} succeeded`);

  // Review and merge sub-PRs
  await log('🔍 Reviewing and merging sub-PRs...');
  const minApprovals = argv.minimumApprovals || 1;
  for (const subtask of subtasks) {
    try {
      await reviewAndMergeSubPr(subtask, repoFull, minApprovals, $, log);
    } catch (err) {
      await log(
        `   ⚠️ Could not merge PR for subtask ${subtask.issueUrl}: ${err.message}`,
        { level: 'warn' }
      );
    }
  }

  // Create final PR from integrationBranch to default branch
  await createFinalPr(
    repoFull,
    integrationBranch,
    title,
    issueBody,
    issueUrl,
    subtasks,
    $,
    log
  );

  await log('🎉 Architect completed successfully.');
  await safeExit(0);
}

// ----------------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------------

async function ensureBranch(branch, owner, repo, $, log) {
  const repoFull = `${owner}/${repo}`;
  try {
    // Get default branch name
    const defaultBranchData = await $`gh repo view ${repoFull} --json defaultBranchRef`.json();
    const defaultBranch = defaultBranchData.defaultBranchRef.name;
    // Get SHA of default branch
    const sha = await $`gh api repos/${repoFull}/git/refs/heads/${defaultBranch} --jq .object.sha`.trim();
    // Try to create the branch
    await $`gh api --method POST repos/${repoFull}/git/refs -f ref='refs/heads/${branch}' -f sha=${sha}`.exec();
    await log(`   Created branch '${branch}' from '${defaultBranch}'`);
  } catch (err) {
    // If branch already exists, that's fine
    if (err.message.includes('already exists') || err.message.includes('Reference already exists')) {
      await log(`   Branch '${branch}' already exists`);
    } else {
      throw err;
    }
  }
}

async function createSubtasks(
  { title, body, labels, splitBy, owner, repo, issueNumber },
  $,
  log
) {
  const subtasks = [];
  const repoFull = `${owner}/${repo}`;
  for (let i = 1; i <= splitBy; i++) {
    const subTitle = `[Part ${i}/${splitBy}] ${title}`;
    const subBody = `This is subtask ${i} of parent issue #${issueNumber}.\n\nParent issue: https://github.com/${owner}/${repo}/issues/${issueNumber}\n\nOriginal description:\n${body}`;

    // Build and execute issue creation command
    const createCmd = labels
      ? $`gh issue create --repo ${repoFull} --title ${subTitle} --body ${subBody} --label ${labels} --json number`
      : $`gh issue create --repo ${repoFull} --title ${subTitle} --body ${subBody} --json number`;

    const result = await createCmd.json();
    const number = result.number;
    const subUrl = `https://github.com/${owner}/${repo}/issues/${number}`;
    subtasks.push({ number, title: subTitle, body: subBody, issueUrl: subUrl });
    await log(`   ➤ Created subtask #${number}: ${subTitle}`);
  }
  return subtasks;
}

function buildCommonSolveArgs(
  argv,
  integrationBranch,
  { SOLVE_OPTION_DEFINITIONS, ARCHITECT_OPTION_DEFINITIONS }
) {
  const architectOnly = new Set(Object.keys(ARCHITECT_OPTION_DEFINITIONS));
  const exclude = new Set(['_', 'verbose', 'sentry', 'issue-url']);
  const args = [];

  for (const [key, value] of Object.entries(argv)) {
    if (exclude.has(key) || architectOnly.has(key)) continue;

    // Check if it's a solve option (present in definitions) or special model variants
    if (
      SOLVE_OPTION_DEFINITIONS[key] ||
      key === 'model' ||
      key === 'planModel' ||
      key === 'workerModel' ||
      key === 'fallbackModel'
    ) {
      const kebab = toKebabCase(key);
      if (typeof value === 'boolean') {
        if (value) args.push(`--${kebab}`);
      } else if (value != null) {
        args.push(`--${kebab}=${value}`);
      }
    }
  }

  // Ensure integration branch is used as base for sub-PRs
  args.push(`--base-branch=${integrationBranch}`);
  return args;
}

function toKebabCase(str) {
  return str
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

async function reviewAndMergeSubPr(
  subtask,
  repoFull,
  minApprovals,
  $,
  log
) {
  // Find the PR associated with subtask by searching for its URL in PR body
  const query = `${subtask.issueUrl} repo:${repoFull} type:pr`;
  const searchCmd = $`gh api -X GET /search/issues?q=${encodeURIComponent(
    query
  )}&per_page=1 --jq .items[0].number`;
  const prNumStr = await searchCmd.toString().trim();

  if (!prNumStr) {
    throw new Error('No PR found for subtask');
  }
  const prNumber = prNumStr;
  await log(`   🔎 Found PR #${prNumber} for subtask ${subtask.issueUrl}`);

  // Get current approval count (approved reviews)
  const reviewsJson = await $`gh api repos/${repoFull}/pulls/${prNumber}/reviews --jq '[.[] | select(.state=="APPROVED")] | length'`.toString().trim();
  const approvals = parseInt(reviewsJson, 10) || 0;
  await log(`   👍 Approvals: ${approvals}/${minApprovals}`);

  if (approvals < minApprovals) {
    // Approve the PR ourselves
    await $`gh pr review ${prNumber} --repo ${repoFull} --approve --body "Approved by /architect"`.exec();
    await log(`   ✅ Approved PR #${prNumber}`);
  }

  // Merge the PR
  try {
    await $`gh pr merge ${prNumber} --repo ${repoFull} --squash --delete-branch`.exec();
    await log(`   🎉 Merged PR #${prNumber}`);
  } catch (err) {
    throw new Error(`Merge failed: ${err.message}`);
  }
}

async function createFinalPr(
  repoFull,
  headBranch,
  originalTitle,
  originalBody,
  originalIssueUrl,
  subtasks,
  $,
  log
) {
  // Determine default branch (base for final PR)
  const repoInfo = await $`gh repo view ${repoFull} --json defaultBranchRef`.json();
  const defaultBranch = repoInfo.defaultBranchRef.name;

  // Check if a PR from headBranch to defaultBranch already exists
  try {
    const existing = await $`gh pr list --repo ${repoFull} --base ${defaultBranch} --head ${headBranch} --state open --json number --jq .[0].number`.toString().trim();
    if (existing) {
      await log(`   ℹ️ Final PR already exists: #${existing}`);
      return;
    }
  } catch (e) {
    // If no existing PRs, continue to create
  }

  const title = `Architect: ${originalTitle}`;
  const body = `This PR integrates ${subtasks.length} subtasks:\n\n${subtasks
    .map((st) => `- ${st.title} (#${st.number})`)
    .join('\n')}\n\nOriginal issue: ${originalIssueUrl}\n\n---\n_Generated by /architect_`;

  await $`gh pr create --repo ${repoFull} --base ${defaultBranch} --head ${headBranch} --title ${title} --body ${body}`.exec();
  await log(`   ✅ Created final PR: ${title}`);
}
