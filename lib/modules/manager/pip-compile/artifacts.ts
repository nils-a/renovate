import { quote } from 'shlex';
import { TEMPORARY_ERROR } from '../../../constants/error-messages';
import { logger } from '../../../logger';
import { exec } from '../../../util/exec';
import {
  deleteLocalFile,
  readLocalFile,
  writeLocalFile,
} from '../../../util/fs';
import { getRepoStatus } from '../../../util/git';
import * as pipRequirements from '../pip_requirements';
import type { UpdateArtifact, UpdateArtifactsResult, Upgrade } from '../types';
import {
  extractHeaderCommand,
  getExecOptions,
  getRegistryUrlVarsFromPackageFile,
} from './common';
import type { PipCompileArgs } from './types';
import { inferCommandExecDir } from './utils';

export function constructPipCompileCmd(
  compileArgs: PipCompileArgs,
  haveCredentials: boolean,
  upgradePackages: Upgrade[] = [],
): string {
  if (compileArgs.isCustomCommand) {
    throw new Error(
      'Detected custom command, header modified or set by CUSTOM_COMPILE_COMMAND',
    );
  }

  if (!compileArgs.outputFile) {
    logger.debug(`pip-compile: implicit output file`);
  }
  // safeguard against index url leak if not explicitly set by an option
  if (
    (!compileArgs.noEmitIndexUrl && !compileArgs.emitIndexUrl) ||
    (!compileArgs.noEmitIndexUrl && haveCredentials)
  ) {
    compileArgs.argv.splice(1, 0, '--no-emit-index-url');
  }
  for (const dep of upgradePackages) {
    compileArgs.argv.push(
      `--upgrade-package=${quote(dep.depName + '==' + dep.newVersion)}`,
    );
  }
  return compileArgs.argv.map(quote).join(' ');
}

export async function updateArtifacts({
  packageFileName: inputFileName,
  newPackageFileContent: newInputContent,
  updatedDeps,
  config,
}: UpdateArtifact): Promise<UpdateArtifactsResult[] | null> {
  if (!config.lockFiles) {
    logger.warn(
      { packageFileName: inputFileName },
      'pip-compile: No lock files associated with a package file',
    );
    return null;
  }
  logger.debug(
    `pipCompile.updateArtifacts(${inputFileName}->${JSON.stringify(
      config.lockFiles,
    )})`,
  );
  const result: UpdateArtifactsResult[] = [];
  for (const outputFileName of config.lockFiles) {
    const existingOutput = await readLocalFile(outputFileName, 'utf8');
    if (!existingOutput) {
      logger.debug('pip-compile: No output file found');
      return null;
    }
    try {
      await writeLocalFile(inputFileName, newInputContent);
      // TODO(not7cd): use --upgrade option instead deleting
      if (config.isLockFileMaintenance) {
        await deleteLocalFile(outputFileName);
      }
      const compileArgs = extractHeaderCommand(existingOutput, outputFileName);
      const cwd = inferCommandExecDir(outputFileName, compileArgs.outputFile);
      const upgradePackages = updatedDeps.filter((dep) => dep.isLockfileUpdate);
      const packageFile = pipRequirements.extractPackageFile(newInputContent);
      const registryUrlVars = getRegistryUrlVarsFromPackageFile(packageFile);
      const cmd = constructPipCompileCmd(
        compileArgs,
        registryUrlVars.haveCredentials,
        upgradePackages,
      );
      const execOptions = await getExecOptions(
        config,
        cwd,
        registryUrlVars.environmentVars,
      );
      logger.trace({ cwd, cmd }, 'pip-compile command');
      logger.trace({ env: execOptions.extraEnv }, 'pip-compile extra env vars');
      await exec(cmd, execOptions);
      const status = await getRepoStatus();
      if (!status?.modified.includes(outputFileName)) {
        return null;
      }
      result.push({
        file: {
          type: 'addition',
          path: outputFileName,
          contents: await readLocalFile(outputFileName, 'utf8'),
        },
      });
    } catch (err) {
      // istanbul ignore if
      if (err.message === TEMPORARY_ERROR) {
        throw err;
      }
      logger.debug({ err }, 'pip-compile: Failed to run command');
      result.push({
        artifactError: {
          lockFile: outputFileName,
          stderr: err.message,
        },
      });
    }
  }
  logger.debug('pip-compile: Returning updated output file(s)');
  return result;
}
