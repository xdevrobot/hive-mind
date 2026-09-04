// CLI configuration module for architect command
import { getLinoYargsFactory, hideBin, parseCliArgumentsWithLino } from './cli-arguments.lib.mjs';
import { enhanceErrorMessage, detectMalformedFlags } from './option-suggestions.lib.mjs';
import { SOLVE_OPTION_DEFINITIONS } from './solve.config.lib.mjs';

// Architect-specific options that are NOT forwarded to solve
const ARCHITECT_OPTION_NAMES = new Set([
  'depth',
  'split-by',
  'label',
  'minimum-approvals',
  'orchestrate',
]);

export const initializeConfig = async () => ({ yargs: getLinoYargsFactory(), hideBin });

export const ARCHITECT_OPTION_DEFINITIONS = {
  depth: {
    type: 'number',
    description: 'Depth of recursive decomposition (1 = one level of subtasks)',
    default: 1,
    min: 1,
  },
  'split-by': {
    type: 'number',
    description: 'Number of subtasks to create for each task at each level',
    alias: 's',
    default: 2,
    min: 1,
  },
  label: {
    type: 'string',
    description: 'Label to assign to automatically created subtasks',
    default: 'help wanted',
  },
  'minimum-approvals': {
    type: 'number',
    description: 'Minimum number of approvals for automatic merging of sub-PRs',
    default: 1,
    min: 0,
  },
  orchestrate: {
    type: 'boolean',
    description: 'Orchestration mode: automatically run /solve for each subtask without depending on /hive',
    default: false,
  },
};

export const createYargsConfig = (yargsInstance) => {
  let config = yargsInstance
    .usage('Usage: architect.mjs <issue-url> [options]')
    .command(
      '$0 <issue-url>',
      'Architect agent: decompose and orchestrate issue solving',
      (yargs) => {
        yargs.positional('issue-url', {
          type: 'string',
          description: 'The GitHub issue URL to architect',
        });
      }
    )
    .fail((msg, err) => {
      if (err) throw err;
      const error = new Error(msg);
      error.name = 'YargsValidationError';
      throw error;
    });

  // Register architect-specific options
  for (const [name, def] of Object.entries(ARCHITECT_OPTION_DEFINITIONS)) {
    config = config.option(name, def);
  }

  // Auto-register solve options as passthrough (excluding architect-specific ones)
  for (const [name, def] of Object.entries(SOLVE_OPTION_DEFINITIONS)) {
    if (!ARCHITECT_OPTION_NAMES.has(name)) {
      config = config.option(name, def);
    }
  }

  return config.help('h').alias('h', 'help').strict();
};

export const parseArguments = async (yargs = getLinoYargsFactory(), hideBinFn = hideBin) => {
  const rawArgs = hideBinFn(process.argv);

  // Detect malformed flags early
  const malformedResult = detectMalformedFlags(rawArgs);
  if (malformedResult.malformed.length > 0) {
    const error = new Error(malformedResult.errors.join('\n'));
    error.name = 'MalformedArgumentError';
    throw error;
  }

  let argv;
  try {
    argv = await parseCliArgumentsWithLino({
      argv: process.argv,
      commandName: 'architect',
      createYargsConfig,
      positionalAliases: ['issue-url'],
    });
  } catch (error) {
    // Enhance unknown argument errors
    if (error.message && /Unknown argument/.test(error.message) && !error._enhanced) {
      try {
        const yargsInstance = createYargsConfig(yargs());
        const enhancedMessage = enhanceErrorMessage(error.message, yargsInstance);
        const enhancedError = new Error(enhancedMessage);
        enhancedError.name = error.name;
        enhancedError._enhanced = true;
        throw enhancedError;
      } catch (enhanceErr) {
        if (global.verboseMode) {
          console.error('[VERBOSE] Failed to enhance error message:', enhanceErr.message);
        }
        throw error;
      }
    }
    throw error;
  }

  // Validate numeric ranges
  if (argv.depth !== undefined && argv.depth < 1) {
    throw new Error('--depth must be at least 1');
  }
  if (argv.splitBy !== undefined && argv.splitBy < 1) {
    throw new Error('--split-by must be at least 1');
  }

  return argv;
};
