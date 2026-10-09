import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { configFromEnv, loadAuth, Clubhouse, multipart, assess, photoIdentity, saveJson,
  uploadRun, verifyRun, withUploadLock, assertNoUncertainUpload } from '../avatar.mjs';

const auth = { token: 'synthetic-token', userId: 123, deviceId: 'test-device', locale: 'en_US', language: 'en-US', languages: 'en-US', timezone: 'UTC' };
const url = 'https://example.test/123_image';
const thumbnail = `${url}_thumbnail_250x250`;
const current = { url, items: [{ photo_key: '123#1000000', thumbnail_url: thumbnail }] };

async function fixture(t) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clubdeck-avatar-test-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  const runDir = path.join(outputDir, 'run-test');
  await fs.mkdir(runDir);
  await fs.writeFile(path.join(runDir, 'avatar.jpg'), 'crop');
  await fs.writeFile(path.join(runDir, 'full.jpg'), 'full');
  await saveJson(path.join(runDir, 'receipt.json'), { phase: 'prepared' });
  return { config: { ...configFromEnv({}), outputDir, attempts: 2, delay: 0 }, runDir };
}

test('environment configuration supports custom paths and rejects invalid settings', () => {
  const config = configFromEnv({ CLUBDECK_PROFILE_PATH: '~/custom profile.json', CLUBDECK_OUTPUT_DIR: '/tmp/avatar state', CLUBDECK_FFMPEG_BIN: '/custom/bin/ffmpeg', CLUBDECK_CROP_MODE: 'cover' });
  assert.equal(config.profilePath, path.join(os.homedir(), 'custom profile.json'));
  assert.equal(config.outputDir, '/tmp/avatar state');
  assert.equal(config.ffmpeg, '/custom/bin/ffmpeg');
  assert.equal(config.cropMode, 'cover');
  assert.throws(() => configFromEnv({ CLUBDECK_VERIFY_ATTEMPTS: '0' }));
  assert.throws(() => configFromEnv({ CLUBDECK_CROP_MODE: 'stretch' }));
});

test('credentials can come from a relocated profile or a complete environment tuple', async t => {
  const { config } = await fixture(t);
  config.profilePath = path.join(config.outputDir, 'profile.json');
  await fs.writeFile(config.profilePath, JSON.stringify({ _debug: { auth_token: 'saved-test-token' }, userId: 123, deviceId: 'device' }));
  assert.equal((await loadAuth(config, {})).token, 'saved-test-token');
  const env = { CLUBHOUSE_TOKEN: 'env-test-token', CLUBHOUSE_USER_ID: '456', CLUBHOUSE_DEVICE_ID: 'other-device' };
  assert.equal((await loadAuth(config, env)).userId, 456);
  await assert.rejects(loadAuth(config, { CLUBHOUSE_TOKEN: 'partial' }), /together/);
});

test('multipart preserves both binary images and declares individual lengths', () => {
  const crop = Buffer.from([0xff, 0xd8, 0x00, 0x0a, 0xff, 0xd9]);
  const full = Buffer.from([0xff, 0xd8, 0x22, 0xff, 0xd9]);
  const result = multipart(crop, full, 'test-boundary');
  assert.match(result.contentType, /boundary=test-boundary$/);
  assert.equal(result.body.includes(crop), true);
  assert.equal(result.body.includes(full), true);
  assert.match(result.body.toString('latin1'), /name="file"; filename="avatar.jpg"\r\nContent-Type: image\/jpeg\r\nContent-Length: 6/);
  assert.match(result.body.toString('latin1'), /name="full_file"; filename="full.jpg"\r\nContent-Type: image\/jpeg\r\nContent-Length: 5/);
  assert.equal(result.body.subarray(-19).toString(), '--test-boundary--\r\n');
});

test('startup and upload use the same session while CDN downloads omit credentials', async () => {
  const calls = [];
  const client = new Clubhouse(configFromEnv({}), auth, async (url, options) => {
    calls.push({ url, options });
    return { status: 200, data: { success: true, feature_flags: ['ENABLE_PROFILE_PHOTO_HISTORY'] }, headers: { 'content-type': 'image/jpeg' }, bytes: Buffer.from('photo') };
  });
  await client.startup(); await client.upload(Buffer.from('a'), Buffer.from('b')); await client.download(url);
  assert.equal(calls[0].options.headers['CH-Session-Id'], calls[1].options.headers['CH-Session-Id']);
  assert.equal(calls[0].options.headers.Authorization, 'Token synthetic-token');
  assert.equal(calls[2].options.headers, undefined);
});

test('missing history capability prevents the workflow from proceeding', async () => {
  const client = new Clubhouse(configFromEnv({}), auth, async () => ({ status: 200, data: { success: true, feature_flags: [] } }));
  await assert.rejects(client.startup(), /did not enable/);
});

test('verification handles thumbnail suffixes, signed query strings and rounded history keys', () => {
  const result = assess({ photoKey: '123#1000999', photoUrl: `${thumbnail}?signed=example` }, current);
  assert.equal(result.verified, true);
  assert.equal(photoIdentity(url), photoIdentity(thumbnail));
  assert.equal(assess({ photoUrl: `${url}_other` }, current).verified, false);
  assert.equal(assess({ photoUrl: thumbnail }, { url, items: [] }).verified, false);
  assert.equal(assess({}, current).verified, false);
});

test('a lost response is persisted as uncertain and cannot trigger a duplicate upload', async t => {
  const { config, runDir } = await fixture(t);
  let uploads = 0;
  const client = { auth, state: async () => current, upload: async () => { uploads++; throw new Error('connection lost'); } };
  await assert.rejects(uploadRun(config, client, runDir), /response was lost/);
  await assert.rejects(uploadRun(config, client, runDir), /already attempted/);
  await assert.rejects(assertNoUncertainUpload(config), /outcome is unknown/);
  assert.equal(uploads, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDir, 'receipt.json'))).phase, 'uncertain');
});

test('server rejection is recorded, and an accepted upload persists before verification', async t => {
  const { config, runDir } = await fixture(t);
  const client = { auth, state: async () => current, upload: async () => ({ status: 400, data: { success: false } }) };
  await assert.rejects(uploadRun(config, client, runDir), /HTTP 400/);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDir, 'receipt.json'))).phase, 'rejected');
  await saveJson(path.join(runDir, 'receipt.json'), { phase: 'prepared' });
  client.upload = async () => ({ status: 200, data: { success: true, photo_key: '123#1000999', photo_url: thumbnail } });
  await uploadRun(config, client, runDir);
  const receipt = JSON.parse(await fs.readFile(path.join(runDir, 'receipt.json')));
  assert.equal(receipt.phase, 'accepted');
  assert.equal(receipt.userId, auth.userId);
  assert.equal(JSON.stringify(receipt).includes(auth.token), false);
});

test('verification waits out stale reads without sending another upload', async t => {
  const { config, runDir } = await fixture(t);
  await saveJson(path.join(runDir, 'receipt.json'), { phase: 'accepted', attemptedAt: 'test', userId: auth.userId, photoUrl: thumbnail });
  let reads = 0, waits = 0;
  const client = { auth, state: async () => ++reads === 1 ? { ...current, url: `${url}_old` } : current, download: async () => Buffer.from('server-image') };
  const result = await verifyRun(config, client, runDir, async () => waits++);
  assert.equal(result.verified, true); assert.equal(reads, 2); assert.equal(waits, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(runDir, 'receipt.json'))).phase, 'verified');
  assert.equal(await fs.readFile(path.join(runDir, 'server-avatar.jpg'), 'utf8'), 'server-image');
});

test('verification does not claim success on a different account or unrelated image', async t => {
  const { config, runDir } = await fixture(t);
  await saveJson(path.join(runDir, 'receipt.json'), { phase: 'accepted', attemptedAt: 'test', userId: 999, photoUrl: thumbnail });
  const client = { auth, state: async () => current, download: async () => Buffer.from('server-image') };
  await assert.rejects(verifyRun(config, client, runDir), /different account/);
  await saveJson(path.join(runDir, 'receipt.json'), { phase: 'accepted', attemptedAt: 'test', userId: auth.userId, photoUrl: `${url}_other` });
  const result = await verifyRun(config, client, runDir, async () => {});
  assert.equal(result.verified, false);
});

test('lost-response recovery requires both an identical JPEG and new history', async t => {
  const { config, runDir } = await fixture(t);
  const image = Buffer.from('exact-uploaded-jpeg');
  const receipt = { phase: 'uncertain', attemptedAt: 'test', userId: auth.userId, beforeCount: 0, cropSha256: crypto.createHash('sha256').update(image).digest('hex') };
  await saveJson(path.join(runDir, 'receipt.json'), receipt);
  const client = { auth, state: async () => current, download: async () => image };
  assert.equal((await verifyRun(config, client, runDir)).verified, true);
  await saveJson(path.join(runDir, 'receipt.json'), { ...receipt, beforeCount: 1 });
  assert.equal((await verifyRun(config, client, runDir)).verified, false);
});

test('upload lock blocks concurrent invocations and is released after errors', async t => {
  const { config } = await fixture(t);
  await assert.rejects(withUploadLock(config, async () => {
    await assert.rejects(withUploadLock(config, async () => {}), /upload lock exists/);
    throw new Error('test failure');
  }), /test failure/);
  await withUploadLock(config, async () => {});
  await assert.rejects(fs.stat(path.join(config.outputDir, 'upload.lock')), { code: 'ENOENT' });
});
