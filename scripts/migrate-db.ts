// 用法：npm run migrate
//
// 生产环境跑数据库迁移的入口，部署脚本里 npm run build 之后、pm2 restart 之前调用一次
// （见 .github/workflows/main.yml）。迁移文件本身在 db/migrations/，见 V1 那份文件顶部
// 注释了解从旧的手写累积 SQL 脚本（已删除的 src/adapter/out/db/migrations.ts）迁移过来
// 的背景。
//
// 不用 Docker 镜像跑 Flyway：生产 droplet 只有 1GB 内存 + 2GB swap，已经有过一次真实 OOM
// 事故（见 CLAUDE.md「部署环境与当前进度」一节），Docker daemon 是常驻后台服务，装上之后
// 一直占内存跟 cicada 主进程/Postgres/Redis 抢，划不来只为了偶尔跑一下迁移命令就常驻一个
// 新服务。改用 Flyway 官方 command-line 发行版——自带 JRE、纯静态文件，装好之后不运行时
// 零内存占用，只有真正执行 migrate 那几秒才吃资源，跑完立刻释放。这个二进制装一次之后
// 常驻磁盘（默认 ~/.flyway/），不会每次部署都重新下载。
//
// DATABASE_URL 是 postgresql://user:pass@host:port/db 这种连接串格式（见 .env），Flyway
// 要的是 JDBC URL + 单独的 user/password 参数，这里用 Node 内置的 URL 类解析，不手写
// 正则/bash 字符串拼接去处理——密码里可能出现的特殊字符（$、空格、引号等）交给 URL 类
// 处理更可靠，调用 Flyway 二进制时也是用参数数组传给 execFileSync（不经过 shell），
// 不存在拼接注入/转义的问题。
import 'dotenv/config';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// 编译产物跑在 dist/scripts/ 下（见 scrape-terms.ts 同样的注释），锚定 process.cwd()
// （npm script 固定从项目根目录调用）比按 __dirname 手算相对路径更稳。
const projectRoot = process.cwd();
const MIGRATIONS_DIR = path.join(projectRoot, 'db/migrations');

const FLYWAY_VERSION = '13.4.0';
const INSTALL_ROOT = process.env.FLYWAY_INSTALL_DIR || path.join(process.env.HOME || projectRoot, '.flyway');
const FLYWAY_HOME = path.join(INSTALL_ROOT, `flyway-${FLYWAY_VERSION}`);

function flywayBinName(): string {
  return process.platform === 'win32' ? 'flyway.cmd' : 'flyway';
}

// 只覆盖生产环境实际会用到的 Linux，以及顺手支持一下 macOS 本地开发。Windows 本地开发
// 不在这里处理——本机已经有 Docker Desktop（见 README.md「本地 Redis」一节），想在
// Windows 本地跑迁移直接用官方 Docker 镜像更省事：
//   docker run --rm -v <项目路径>/db/migrations:/flyway/sql --network host \
//     flyway/flyway -url=jdbc:postgresql://127.0.0.1:5432/cicada -user=cicada -password=... migrate
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
      // 生产库上 cicada 角色的 search_path 解析行为不正常——不带 schema 前缀的
      // CREATE 语句（不管是 CREATE EXTENSION 还是普通 CREATE TABLE）统一报
      // "no schema has been selected to create in"，唯独显式指定 schema 才成功
      // （见 V1 迁移文件里 pgcrypto 那一行的注释）。本地 Docker 测试没复现，因为
      // 本地 cicada 角色是超级用户，search_path 解析路径不一样。与其把 V1 里每一
      // 条 create table/index 语句都手动加 public. 前缀，不如让 Flyway 直接把
      // 这次连接的 schema 钉死在 public——Flyway 会在执行迁移前对连接设置
      // search_path 为这里列出的 schema，绕开这个连接默认 search_path 本身的问题。
      '-schemas=public',
      'migrate',
    ],
    { stdio: 'inherit' },
  );
}

main();
