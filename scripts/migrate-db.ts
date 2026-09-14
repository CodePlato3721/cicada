import 'dotenv/config';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = process.cwd();
const MIGRATIONS_DIR = path.join(projectRoot, 'db/migrations');

const FLYWAY_VERSION = '13.4.0';
const INSTALL_ROOT = process.env.FLYWAY_INSTALL_DIR || path.join(process.env.HOME || projectRoot, '.flyway');
const FLYWAY_HOME = path.join(INSTALL_ROOT, `flyway-${FLYWAY_VERSION}`);

function flywayBinName(): string {
  return process.platform === 'win32' ? 'flyway.cmd' : 'flyway';
}

function platformArchiveSuffix(): string {
  if (process.platform === 'linux') return 'linux-x64';
  if (process.platform === 'darwin') return 'macosx';
  throw new Error(
    `[migrate-db] 不支持在 ${process.platform} 上自动安装 Flyway CLI（这个脚本是给生产 Linux droplet 和 macOS 本地开发用的）。` +
      'Windows 本地开发请改用 Docker 镜像 flyway/flyway，见脚本内注释。',
  );
}

function ensureFlywayInstalled(): string {
  const flywayBin = path.join(FLYWAY_HOME, flywayBinName());
  if (existsSync(flywayBin)) {
    console.log(`[migrate-db] Flyway ${FLYWAY_VERSION} already installed at ${flywayBin}, skipping download.`);
    return flywayBin;
  }

  console.log(`[migrate-db] Flyway ${FLYWAY_VERSION} not found, downloading...`);
  mkdirSync(INSTALL_ROOT, { recursive: true });

  const suffix = platformArchiveSuffix();
  const tarballUrl = `https://github.com/flyway/flyway/releases/download/flyway-${FLYWAY_VERSION}/flyway-commandline-${FLYWAY_VERSION}-${suffix}.tar.gz`;
  const tarballPath = path.join(INSTALL_ROOT, 'flyway.tar.gz');

  execFileSync('curl', ['-fsSL', tarballUrl, '-o', tarballPath], { stdio: 'inherit' });
  execFileSync('tar', ['-xzf', tarballPath, '-C', INSTALL_ROOT], { stdio: 'inherit' });
  rmSync(tarballPath);

  if (!existsSync(flywayBin)) {
    throw new Error(`[migrate-db] 下载/解压完成，但没找到预期的可执行文件：${flywayBin}`);
  }
  return flywayBin;
}

function parseDatabaseUrl(databaseUrl: string): { jdbcUrl: string; user: string; password: string } {
  const parsed = new URL(databaseUrl);
  return {
    jdbcUrl: `jdbc:postgresql://${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set — check your .env file');

  const flywayBin = ensureFlywayInstalled();
  const { jdbcUrl, user, password } = parseDatabaseUrl(databaseUrl);

  execFileSync(
    flywayBin,
    [
      `-url=${jdbcUrl}`,
      `-user=${user}`,
      `-password=${password}`,
      `-locations=filesystem:${MIGRATIONS_DIR}`,
      '-schemas=public',
      'migrate',
    ],
    { stdio: 'inherit' },
  );
}

main();
