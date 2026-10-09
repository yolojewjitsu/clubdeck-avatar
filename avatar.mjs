#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const API = 'https://www.clubhouseapi.com/api/';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const expandPath = value => path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);

function integer(env, name, fallback, min, max) {
  const n = Number(env[name] || fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export function configFromEnv(env = process.env) {
  const cropMode = env.CLUBDECK_CROP_MODE || 'contain';
  if (!['contain', 'cover'].includes(cropMode)) throw new Error('CLUBDECK_CROP_MODE must be contain or cover');
  const ffmpeg = env.CLUBDECK_FFMPEG_BIN || 'ffmpeg';
  return {
    profilePath: env.CLUBDECK_PROFILE_PATH ? expandPath(env.CLUBDECK_PROFILE_PATH) : null,
    imagePath: env.CLUBDECK_IMAGE_PATH || null,
    outputDir: expandPath(env.CLUBDECK_OUTPUT_DIR || path.join(os.homedir(), '.local', 'state', 'clubdeck-avatar')),
    ffmpeg: ffmpeg.includes('/') || ffmpeg.includes('\\') ? expandPath(ffmpeg) : ffmpeg,
    cropMode, appVersion: env.CLUBHOUSE_APP_VERSION || '26.09.16', appBuild: env.CLUBHOUSE_APP_BUILD || '1038456',
    manufacturer: env.CLUBHOUSE_DEVICE_MANUFACTURER || 'Google', model: env.CLUBHOUSE_DEVICE_MODEL || 'Pixel 9',
    country: env.CLUBHOUSE_COUNTRY || 'US',
    timeout: integer(env, 'CLUBDECK_REQUEST_TIMEOUT_MS', 35000, 1000, 300000),
    attempts: integer(env, 'CLUBDECK_VERIFY_ATTEMPTS', 6, 1, 60),
    delay: integer(env, 'CLUBDECK_VERIFY_DELAY_MS', 3000, 0, 60000),
  };
}

export async function loadAuth(config, env = process.env) {
  const provided = ['CLUBHOUSE_TOKEN', 'CLUBHOUSE_USER_ID', 'CLUBHOUSE_DEVICE_ID'].filter(key => env[key]);
  let p = {};
  if (provided.length) {
    if (provided.length !== 3) throw new Error('Set CLUBHOUSE_TOKEN, CLUBHOUSE_USER_ID and CLUBHOUSE_DEVICE_ID together');
    p = { token: env.CLUBHOUSE_TOKEN, userId: env.CLUBHOUSE_USER_ID, deviceId: env.CLUBHOUSE_DEVICE_ID };
  } else {
    if (!config.profilePath) throw new Error('Set CLUBDECK_PROFILE_PATH or the three CLUBHOUSE credential variables');
    p = JSON.parse(await fs.readFile(config.profilePath, 'utf8'));
  }
  const token = String(p.token || p._debug?.auth_token || '');
  const userId = Number(p.userId);
  if (!token || !Number.isSafeInteger(userId) || userId <= 0 || !p.deviceId) throw new Error('Incomplete Clubdeck login: token, userId and deviceId are required');
  return { token, userId, deviceId: String(p.deviceId), locale: p.locale || 'en_US',
    language: p.acceptLanguages || 'en-US', languages: p.languages || p.locale || 'en-US', timezone: p.timezone || 'UTC' };
}

export function httpRequest(url, { method = 'GET', headers = {}, body, timeout = 35000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) res.destroy(new Error('Response exceeds 32 MiB'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          let bytes = Buffer.concat(chunks);
          if (String(res.headers['content-encoding'] || '').includes('gzip')) bytes = zlib.gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
          let data;
          try { data = JSON.parse(bytes.toString('utf8')); } catch { /* Images are not JSON. */ }
          resolve({ status: res.statusCode, headers: res.headers, bytes, data });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Request timed out')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}

function expect(response, name, successRequired = true) {
  if (response.status !== 200 || !response.data || response.data.success === false || (successRequired && response.data.success !== true)) {
    throw new Error(`${name}: HTTP ${response.status}, success=${response.data?.success ?? 'missing'}`);
  }
  return response.data;
}

export function multipart(crop, full, boundary = crypto.randomUUID()) {
  const parts = [];
  for (const [name, filename, bytes] of [['file', 'avatar.jpg', crop], ['full_file', 'full.jpg', full]]) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`), bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export class Clubhouse {
  constructor(config, auth, transport = httpRequest) {
    this.config = config; this.auth = auth; this.transport = transport;
    this.headers = {
      Accept: 'application/json', 'Accept-Encoding': 'gzip',
      'User-Agent': `clubhouse/android/${config.appBuild}`, 'CH-AppBuild': config.appBuild, 'CH-AppVersion': config.appVersion,
      'CH-DeviceId': auth.deviceId, 'CH-DeviceMfr': config.manufacturer, 'CH-DeviceModel': config.model,
      'CH-Locale': auth.locale, 'CH-Keyboards': 'en-US', 'CH-Session-Id': crypto.randomUUID(),
      'CH-Storefront-Country-Code': config.country, 'Accept-Language': auth.language,
      'CH-UserID': String(auth.userId), Authorization: auth.token.startsWith('Token ') ? auth.token : `Token ${auth.token}`,
    };
  }
  send(endpoint, body, contentType) {
    return this.transport(`${API}${endpoint}`, { method: 'POST', body, timeout: this.config.timeout,
      headers: { ...this.headers, 'Content-Type': contentType, 'Content-Length': body.length } });
  }
  json(endpoint, body) { return this.send(endpoint, Buffer.from(JSON.stringify(body)), 'application/json'); }
  async startup() {
    const data = expect(await this.json('me', { return_blocked_ids: true, timezone_identifier: this.auth.timezone,
      return_following_ids: true, return_requested_following_ids: true, keyboard_languages: this.auth.languages,
      is_cold_start: true, return_explore_segments_set: true }), 'me');
    if (!data.feature_flags?.includes('ENABLE_PROFILE_PHOTO_HISTORY')) throw new Error('Server did not enable profile photo history');
  }
  async state() {
    const body = { user_id: this.auth.userId };
    const profile = expect(await this.json('get_profile', body), 'get_profile');
    const history = expect(await this.json('get_user_photo_history', body), 'get_user_photo_history', false);
    if (!Array.isArray(history.photo_history)) throw new Error('Unexpected photo history format');
    return { url: String(profile.user_profile?.photo_url || ''), items: history.photo_history };
  }
  upload(crop, full) {
    const part = multipart(crop, full);
    return this.send('update_photo', part.body, part.contentType);
  }
  async download(url, redirects = 0) {
    if (new URL(url).protocol !== 'https:') throw new Error('Photo URL must use HTTPS');
    // CDN requests deliberately receive no account headers.
    const response = await this.transport(url, { timeout: this.config.timeout });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && redirects < 3) {
      return this.download(new URL(response.headers.location, url).href, redirects + 1);
    }
    if (response.status !== 200 || !String(response.headers['content-type']).startsWith('image/')) throw new Error('Could not download the profile photo');
    return response.bytes;
  }
}

export function photoIdentity(value) {
  try {
    const url = new URL(value);
    // get_profile omits this suffix; update_photo returns the thumbnail URL.
    return `${url.origin}${url.pathname.replace(/_thumbnail_\d+x\d+(?=\.[a-z]+$|$)/i, '')}`;
  } catch { return ''; }
}

export function assess(receipt, current) {
  const expected = photoIdentity(receipt.photoUrl);
  const profileMatches = !!expected && photoIdentity(current.url) === expected;
  // History keys may round the upload timestamp. Compare image identities too.
  const historyMatches = current.items.some(item =>
    (!!receipt.photoKey && item.photo_key === receipt.photoKey) ||
    (!!expected && [item.thumbnail_url, item.photo_url, item.full_photo_url].some(url => photoIdentity(url) === expected)));
  return { verified: profileMatches && historyMatches, profileMatches, historyMatches, historyCount: current.items.length };
}

export async function saveJson(filename, value) {
  const tmp = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, filename);
}
const readJson = async filename => JSON.parse(await fs.readFile(filename, 'utf8'));

export async function prepare(config, image) {
  if (!image) throw new Error('Pass an image path or set CLUBDECK_IMAGE_PATH');
  const source = expandPath(image);
  if (!(await fs.stat(source)).isFile()) throw new Error('Image path must be a file');
  await fs.mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  const runDir = await fs.mkdtemp(path.join(config.outputDir, 'run-'));
  const full = path.join(runDir, 'full.jpg'), crop = path.join(runDir, 'avatar.jpg');
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe'];
  await execute(config.ffmpeg, [...common, '-i', source, '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', full]);
  const filter = config.cropMode === 'contain'
    ? '[0:v]split=2[bg][fg];[bg]scale=512:512:force_original_aspect_ratio=increase,crop=512:512,gblur=sigma=24[back];[fg]scale=512:512:force_original_aspect_ratio=decrease[front];[back][front]overlay=(W-w)/2:(H-h)/2,format=yuvj420p'
    : '[0:v]scale=512:512:force_original_aspect_ratio=increase,crop=512:512,format=yuvj420p';
  await execute(config.ffmpeg, [...common, '-i', full, '-filter_complex', filter, '-frames:v', '1', '-q:v', '2', crop]);
  const receipt = { schemaVersion: 1, phase: 'prepared', createdAt: new Date().toISOString(),
    cropMode: config.cropMode, sourceSha256: digest(await fs.readFile(source)), cropSha256: digest(await fs.readFile(crop)) };
  await saveJson(path.join(runDir, 'receipt.json'), receipt);
  return runDir;
}

export async function withUploadLock(config, fn) {
  await fs.mkdir(config.outputDir, { recursive: true, mode: 0o700 });
  const filename = path.join(config.outputDir, 'upload.lock');
  let handle;
  try { handle = await fs.open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`An upload lock exists: ${filename}. After a crash, stop any running uploader, run verify, then remove the stale lock.`);
    throw error;
  }
  try { await handle.writeFile(String(process.pid)); return await fn(); }
  finally { await handle.close(); await fs.unlink(filename); }
}

export async function assertNoUncertainUpload(config) {
  let latest;
  try { latest = await readJson(path.join(config.outputDir, 'latest.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const receipt = await readJson(path.join(latest.runDir, 'receipt.json'));
  if (['submitting', 'uncertain'].includes(receipt.phase)) throw new Error(`Previous upload outcome is unknown. Run verify for ${latest.runDir} before uploading again.`);
}

export async function uploadRun(config, client, runDir) {
  const filename = path.join(runDir, 'receipt.json');
  const receipt = await readJson(filename);
  if (receipt.phase !== 'prepared') throw new Error('This run already attempted an upload; use verify');
  const before = await client.state();
  const crop = await fs.readFile(path.join(runDir, 'avatar.jpg')), full = await fs.readFile(path.join(runDir, 'full.jpg'));
  Object.assign(receipt, { phase: 'submitting', userId: client.auth.userId, attemptedAt: new Date().toISOString(), beforeCount: before.items.length, beforeUrl: before.url });
  await saveJson(filename, receipt);
  await saveJson(path.join(config.outputDir, 'latest.json'), { runDir });
  let response;
  try { response = await client.upload(crop, full); }
  catch (error) {
    receipt.phase = 'uncertain'; await saveJson(filename, receipt);
    throw new Error(`Upload response was lost (${error.code || 'network error'}). Do not repeat it; run verify for ${runDir}`);
  }
  receipt.status = response.status;
  receipt.phase = response.status === 200 && response.data?.success === true ? 'accepted'
    : response.data?.success === false && response.status < 500 ? 'rejected' : 'uncertain';
  receipt.photoKey = response.data?.photo_key;
  receipt.photoUrl = response.data?.photo_url;
  await saveJson(filename, receipt);
  expect(response, 'update_photo');
  return receipt;
}

export async function verifyRun(config, client, runDir, wait = pause) {
  const filename = path.join(runDir, 'receipt.json');
  const receipt = await readJson(filename);
  if (receipt.userId != null && Number(receipt.userId) !== client.auth.userId) throw new Error('Receipt belongs to a different account');
  if (!receipt.attemptedAt) throw new Error('This run has not uploaded an image');
  let current, result;
  for (let i = 0; i < config.attempts; i++) {
    if (i) await wait(config.delay);
    current = await client.state(); result = assess(receipt, current);
    if (result.verified || !receipt.photoUrl) break;
  }
  result.checkedAt = new Date().toISOString();
  result.previewSaved = false;
  if (current.url) {
    try {
      const image = await client.download(current.url);
      await fs.writeFile(path.join(runDir, 'server-avatar.jpg'), image, { mode: 0o600 });
      result.previewSaved = true;
      if (!receipt.photoUrl && current.items.length > receipt.beforeCount && digest(image) === receipt.cropSha256) {
        // A lost upload response can be recovered when the CDN serves the exact submitted JPEG.
        receipt.photoUrl = current.url;
        Object.assign(result, assess(receipt, current), { recoveredByImageHash: true });
      }
    }
    catch { /* API verification remains valid if the CDN download is unavailable. */ }
  }
  receipt.verification = result;
  if (result.verified) receipt.phase = 'verified';
  await saveJson(filename, receipt);
  return { runDir, ...result };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command = 'help', argument, ...extra] = args;
  if (['help', '--help', '-h'].includes(command)) {
    console.log('Usage: node --env-file=.env avatar.mjs <prepare [image] | upload [image] | verify [run-directory] | status>\nAll computer-specific paths are configured through environment variables. See README.md and .env.example.');
    return 0;
  }
  if (!['prepare', 'upload', 'verify', 'status'].includes(command) || extra.length || (command === 'status' && argument)) throw new Error('Invalid command or arguments; use --help');
  const config = configFromEnv(env);
  if (command === 'prepare') {
    console.log(JSON.stringify({ runDir: await prepare(config, argument || config.imagePath), uploaded: false }, null, 2)); return 0;
  }
  const auth = await loadAuth(config, env), client = new Clubhouse(config, auth);
  await client.startup();
  if (command === 'status') {
    const current = await client.state();
    console.log(JSON.stringify({ authenticated: true, userId: auth.userId, historyCount: current.items.length }, null, 2)); return 0;
  }
  let result;
  if (command === 'upload') {
    result = await withUploadLock(config, async () => {
      await assertNoUncertainUpload(config);
      const runDir = await prepare(config, argument || config.imagePath);
      await uploadRun(config, client, runDir);
      return verifyRun(config, client, runDir);
    });
  } else {
    const runDir = argument ? expandPath(argument) : (await readJson(path.join(config.outputDir, 'latest.json'))).runDir;
    result = await verifyRun(config, client, runDir);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) console.error('Upload is not yet verified. Use verify again; do not repeat upload to refresh a cached profile.');
  return result.verified ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
