'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {parsePlaylistId, resolvePlaylistId} = require('./playlist-import.cjs');

test('parses QQ share formats without rounding IDs or treating unrelated links as playlists', () => {
  for (const [input, expected] of [
    [' 0012345 ', '12345'], ['9007199254740993123', '9007199254740993123'],
    ['我分享了歌单 https://y.qq.com/n/ryqq/playlist/12345，来听听', '12345'],
    ['https://y.qq.com/n2/m/detail/taoge/index.html?ADTAG=copy&id=12345', '12345'],
    ['https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?disstid=12345', '12345'],
    ['（https://y.qq.com/#/playlist/12345）', '12345'],
    ['https://y.qq.com/playlist?x=1&amp;dissid=12345', '12345'],
  ]) assert.equal(parsePlaylistId(input), expected);
  for (const input of ['0', '-1', '1.1', '1e4', '1'.repeat(21), 'https://example.com/?id=12345',
    'https://y.qq.com.evil.example/playlist/12345', 'https://user:pass@y.qq.com/playlist/12345',
    'https://y.qq.com:4000/playlist/12345', 'file:///playlist/12345', 'https://y.qq.com/playlist/12345extra']) {
    assert.equal(parsePlaylistId(input), undefined, input);
  }
});

test('direct IDs need no network and share redirects resolve without fetching the landing page', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, options});
    return new Response(null, {status: 302, headers: {location: 'https://y.qq.com/n/ryqq/playlist/12345'}});
  };
  assert.equal(await resolvePlaylistId('12345', {fetchImpl}), '12345');
  assert.equal(calls.length, 0);
  assert.equal(await resolvePlaylistId('一起听歌 https://c6.y.qq.com/base/fcgi-bin/u?__=short', {fetchImpl}), '12345');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Referer, 'https://y.qq.com/');
});

test('reads embedded playlist IDs and escaped landing URLs from the share page', async () => {
  const link = 'https://c6.y.qq.com/base/fcgi-bin/u?__=short';
  for (const html of ['<script>window.DATA={"disstid": "12345"}</script>',
    '<script>window.DATA={dissid:12345}</script>',
    '<script>location="https:\\/\\/y.qq.com\\/n\\/ryqq\\/playlist\\/12345"</script>']) {
    assert.equal(await resolvePlaylistId(link, {fetchImpl: async () => new Response(html)}), '12345');
  }
  assert.equal(await resolvePlaylistId(link, {fetchImpl: async () => new Response('分享已失效')}), undefined);
});

test('validates every redirect and refuses loops, missing destinations and oversized responses', async () => {
  const link = 'https://c6.y.qq.com/base/fcgi-bin/u?__=short';
  for (const location of ['http://127.0.0.1/playlist/12345', 'https://example.com/?id=12345',
    'https://y.qq.com.evil.example/?id=12345', 'https://name:secret@y.qq.com/?id=12345', '']) {
    let requests = 0;
    await assert.rejects(resolvePlaylistId(link, {fetchImpl: async () => {
      requests += 1;
      return new Response(null, {status: 302, headers: {location}});
    }}), /没有跳转到 QQ 音乐/);
    assert.equal(requests, 1);
  }
  await assert.rejects(resolvePlaylistId(link, {fetchImpl: async () => new Response(null, {status: 302, headers: {location: link}})}), /重定向异常/);
  await assert.rejects(resolvePlaylistId(link, {fetchImpl: async () => new Response('', {headers: {'content-length': 3 * 1024 * 1024}})}), /页面过大/);
  await assert.rejects(resolvePlaylistId(link, {fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))}), /页面过大/);
});

test('reports HTTP errors and cancels a stalled share page when its time limit expires', async () => {
  const link = 'https://c6.y.qq.com/base/fcgi-bin/u?__=short';
  await assert.rejects(resolvePlaylistId(link, {fetchImpl: async () => new Response(null, {status: 403})}), /HTTP 403/);
  let cancelled = false;
  const body = new ReadableStream({cancel() {cancelled = true;}});
  await assert.rejects(resolvePlaylistId(link, {timeoutMs: 15, fetchImpl: async () => new Response(body)}), /解析超时/);
  assert.equal(cancelled, true);
});
