import fs from 'fs';
import path from 'path';

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

export function loadConfig(root) {
  loadDotEnv(path.join(root, '.env'));

  const secretsPath = path.join(root, 'data', 'secrets.json');
  let secrets = {};
  if (fs.existsSync(secretsPath)) {
    secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  }

  const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8'));
  const botToken = process.env.TELEGRAM_BOT_TOKEN || secrets.telegram?.botToken || null;

  config.telegram = {
    ...config.telegram,
    ...(botToken ? { botToken } : {})
  };

  return config;
}

export function requireBotToken(config) {
  const token = config.telegram?.botToken;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not set. Copy .env.example to .env or set GitHub secret TELEGRAM_BOT_TOKEN.');
  }
  return token;
}
