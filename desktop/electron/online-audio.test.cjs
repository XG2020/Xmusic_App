'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {OnlineAudioService} = require('./online-audio.cjs');

const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(4092, 7)]);
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4093, 9)]);
const input = {mid: 'test_mid', quality: 'flac'};
const payload = url => ({code: 0, data: {test_mid: url}});

async function fixture(t) {
  const requests = [];
  const expiredPaths = new Map();
  const server = http.createServer((req, res) => {
    requests.push({url: req.url, range: req.headers.range, method: req.method});
    if (expiredPaths.has(req.url)) {res.writeHead(expiredPaths.get(req.url)); res.end('expired'); return;}
    if (req.url === '/redirect') {res.writeHead(302, {Location: '/flac'}); res.end(); return;}
    if (req.url === '/bad-redirect') {res.writeHead(302, {Location: 'file:///private/audio.flac'}); res.end(); return;}
    if (req.url === '/loop') {res.writeHead(302, {Location: '/loop'}); res.end(); return;}
    if (req.url === '/forbidden') {res.writeHead(403); res.end('no'); return;}
    if (req.url === '/expired') {res.writeHead(410); res.end('expired'); return;}
    if (req.url === '/html') {res.writeHead(200, {'Content-Type': 'audio/mpeg'}); res.end('<html>please login</html>'); return;}
    const bytes = req.url === '/mp3' ? mp3 : flac;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2])) : 0;
    const end = range?.[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    const chunk = bytes.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, {'Content-Type': 'audio/x-ogg', 'Content-Length': chunk.length,
      ...(range ? {'Content-Range': `bytes ${start}-${end}/${bytes.length}`} : {}),
      'Accept-Ranges': 'bytes', 'Set-Cookie': 'upstream=secret', 'X-Upstream': 'private'});
    res.end(chunk);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {server.closeAllConnections(); server.close();});
  return {base: `http://127.0.0.1:${server.address().port}`, requests, expiredPaths};
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function mediaResponse(range) {
  const [start, end] = range.slice(6).split('-').map(Number);
  return new Response(flac.subarray(start, end + 1), {status: 206, headers: {
    'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${flac.length}`,
  }});
}

test('expired signed links are freshly resolved at the same quality during initial preparation', async t => {
  const {base, requests, expiredPaths} = await fixture(t);
  for (const status of [401, 403, 404, 410]) {
    expiredPaths.set('/old', status);
    const apiCalls = [];
    const service = new OnlineAudioService({requestApi: async request => {
      apiCalls.push(request); return payload(`${base}/${apiCalls.length === 1 ? 'old' : 'flac'}`);
    }});
    try {
      assert.match(await service.resolve(input), /^xmusic-online:/);
      assert.deepEqual(apiCalls.map(request => request.params), [input, input]);
      assert.deepEqual(requests.slice(-2).map(request => request.url), ['/old', '/flac']);
    } finally {service.dispose();}
  }
});

test('a late 403 refreshes the cached URL and retries the original seek without changing the stream token', async t => {
  const {base, requests, expiredPaths} = await fixture(t);
  const apiCalls = [];
  const service = new OnlineAudioService({requestApi: async request => {
    apiCalls.push(request); return payload(`${base}/${apiCalls.length === 1 ? 'old' : 'flac'}`);
  }});
  t.after(() => service.dispose());
  const url = await service.resolve(input);
  expiredPaths.set('/old', 403);
  const response = await service.respond(new Request(url, {headers: {Range: 'bytes=108-140'}}));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 108-140/4096');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), flac.subarray(108, 141));
  assert.deepEqual(requests.slice(-3).map(({url, range}) => ({url, range})), [
    {url: '/old', range: 'bytes=108-140'}, {url: '/flac', range: 'bytes=0-511'}, {url: '/flac', range: 'bytes=108-140'},
  ]);
  assert.deepEqual(apiCalls.map(request => request.params), [input, input]);
  assert.equal(service.entries.size, 1);
  assert.equal(service.failure(url), undefined);
});

test('a refreshed link which remains forbidden stops after one refresh and reports a safe terminal expiry', async t => {
  const {base, expiredPaths} = await fixture(t);
  let calls = 0;
  const service = new OnlineAudioService({requestApi: async () => {calls++; return payload(`${base}/old`);}});
  t.after(() => service.dispose());
  const url = await service.resolve(input);
  expiredPaths.set('/old', 403);
  assert.equal((await service.respond(new Request(url))).status, 502);
  assert.equal(calls, 2);
  assert.equal(service.failure(url).code, 'AUDIO_URL_EXPIRED');
  assert.match(service.failure(url).message, /重新解析同音质/);
  assert.ok(!service.failure(url).message.includes(base));
  assert.equal((await service.respond(new Request(url))).status, 502);
  assert.equal(calls, 2, 'repeated Chromium error requests must not begin a refresh loop');
});

test('initial expiry recovery stops after two lookups even if the fresh API lookup itself fails', async t => {
  const {base} = await fixture(t);
  for (const failApi of [false, true]) {
    let calls = 0;
    const service = new OnlineAudioService({requestApi: async () => {
      if (++calls === 2 && failApi) throw new Error('private signed URL must not leak');
      return payload(`${base}/forbidden`);
    }});
    try {
      await assert.rejects(service.resolve(input), error => error.code === 'AUDIO_URL_EXPIRED' && !error.message.includes('private'));
      assert.equal(calls, 2);
      assert.equal(service.entries.size, 0);
      assert.equal(service.controllers.size, 0);
    } finally {service.dispose();}
  }
});

test('same-quality refresh deadlines remain terminal expiry failures rather than permitting a quality fallback', async () => {
  for (const stage of ['preparation', 'range']) {
    let calls = 0;
    let expired = stage === 'preparation';
    const service = new OnlineAudioService({timeoutMs: 20, requestApi: async (_request, {signal}) => {
      if (++calls === 1) return payload('https://media.example/old');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
    }, fetcher: async (_url, {headers}) => expired ? new Response(null, {status: 403}) : mediaResponse(headers.Range)});
    try {
      if (stage === 'preparation') {
        await assert.rejects(service.resolve(input), error => error.code === 'AUDIO_URL_EXPIRED' && /超时/.test(error.message));
      } else {
        const url = await service.resolve(input);
        expired = true;
        assert.equal((await service.respond(new Request(url, {headers: {Range: 'bytes=10-19'}}))).status, 502);
        assert.equal(service.failure(url).code, 'AUDIO_URL_EXPIRED');
        assert.match(service.failure(url).message, /超时/);
      }
      assert.equal(calls, 2);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(service.controllers.size, 0);
    } finally {service.dispose();}
  }
});

test('simultaneous expired seek requests share one refresh and preserve their separate ranges', async t => {
  let expired = false;
  let calls = 0;
  const started = deferred();
  const refreshed = deferred();
  const service = new OnlineAudioService({requestApi: async () => {
    if (++calls === 1) return payload('https://media.example/old');
    started.resolve(); return refreshed.promise;
  }, fetcher: async (url, {headers}) => url.endsWith('/old') && expired ? new Response(null, {status: 403}) : mediaResponse(headers.Range)});
  t.after(() => service.dispose());
  const url = await service.resolve(input);
  expired = true;
  const first = service.respond(new Request(url, {headers: {Range: 'bytes=10-19'}}));
  const second = service.respond(new Request(url, {headers: {Range: 'bytes=20-39'}}));
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  refreshed.resolve(payload('https://media.example/fresh'));
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.headers.get('Content-Range')), ['bytes 10-19/4096', 'bytes 20-39/4096']);
  for (const response of responses) await response.arrayBuffer();
  assert.equal(calls, 2);
  assert.equal(service.controllers.size, 0);
});

test('one expired range timing out does not poison a shared refresh that another range completes', async t => {
  let expired = false;
  let calls = 0;
  const started = deferred();
  const service = new OnlineAudioService({timeoutMs: 150, requestApi: async () => {
    if (++calls === 1) return payload('https://media.example/old');
    started.resolve();
    await new Promise(resolve => setTimeout(resolve, 100));
    return payload('https://media.example/fresh');
  }, fetcher: async (url, {headers}) => {
    if (url.endsWith('/old') && expired) {
      if (headers.Range === 'bytes=10-19') await new Promise(resolve => setTimeout(resolve, 90));
      return new Response(null, {status: 403});
    }
    return mediaResponse(headers.Range);
  }});
  t.after(() => service.dispose());
  const url = await service.resolve(input);
  expired = true;
  const first = service.respond(new Request(url, {headers: {Range: 'bytes=10-19'}}));
  await started.promise;
  const second = service.respond(new Request(url, {headers: {Range: 'bytes=20-39'}}));
  assert.equal((await first).status, 502);
  assert.equal(service.failure(url).code, 'AUDIO_URL_EXPIRED', 'renderer diagnostics must prevent downgrade while another range is refreshing');
  const recovered = await second;
  assert.equal(recovered.status, 206);
  await recovered.arrayBuffer();
  assert.equal(service.failure(url), undefined);
  const continued = await service.respond(new Request(url, {headers: {Range: 'bytes=40-59'}}));
  assert.equal(continued.status, 206);
  await continued.arrayBuffer();
  assert.equal(calls, 2);
});

test('cancels shared expired-link work when all seek requests are abandoned, without poisoning future playback', async t => {
  let expired = false;
  let calls = 0;
  let refreshSignal;
  const started = deferred();
  const service = new OnlineAudioService({requestApi: async (_request, {signal}) => {
    if (++calls === 1) return payload('https://media.example/old');
    refreshSignal = signal;
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
  }, fetcher: async (_url, {headers}) => expired ? new Response(null, {status: 403}) : mediaResponse(headers.Range)});
  t.after(() => service.dispose());
  const url = await service.resolve(input);
  expired = true;
  const first = new AbortController();
  const second = new AbortController();
  const responses = [first, second].map(controller => service.respond(new Request(url, {signal: controller.signal, headers: {Range: 'bytes=10-19'}})));
  await started.promise;
  await new Promise(resolve => setImmediate(resolve));
  first.abort();
  await responses[0];
  assert.equal(refreshSignal.aborted, false);
  second.abort();
  await responses[1];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshSignal.aborted, true);
  assert.equal(service.controllers.size, 0);
  assert.equal(service.failure(url), undefined);
});

test('registers only a fixed song/quality API request and corrects FLAC MIME while preserving real byte ranges', async t => {
  const {base, requests} = await fixture(t);
  const apiCalls = [];
  const service = new OnlineAudioService({requestApi: async request => {apiCalls.push(request); return payload(`${base}/flac`);}});
  t.after(() => service.dispose());
  const url = await service.resolve({...input, baseUrl: `${base}/api-service`});
  assert.match(url, /^xmusic-online:\/\/stream\/[0-9a-f-]+$/);
  assert.deepEqual(apiCalls, [{path: '/api/song/url', params: {mid: 'test_mid', quality: 'flac'}, baseUrl: `${base}/api-service`}]);
  assert.deepEqual(requests, [{url: '/flac', range: 'bytes=0-511', method: 'GET'}]);
  const response = await service.respond(new Request(url, {headers: {Range: 'bytes=19-41', Cookie: 'not-forwarded=1'}}));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Type'), 'audio/flac');
  assert.equal(response.headers.get('Content-Length'), '23');
  assert.equal(response.headers.get('Content-Range'), 'bytes 19-41/4096');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('X-Upstream'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), flac.subarray(19, 42));
  const tail = await service.respond(new Request(url, {headers: {Range: 'bytes=-16'}}));
  assert.equal(tail.headers.get('Content-Range'), 'bytes 4080-4095/4096');
  assert.equal((await tail.arrayBuffer()).byteLength, 16);
  const head = await service.respond(new Request(url, {method: 'HEAD'}));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Type'), 'audio/flac');
  assert.equal(head.headers.get('Content-Length'), '4096');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('sniffs MP3 despite incorrect MIME and follows validated redirects without leaking signed URLs', async t => {
  const {base} = await fixture(t);
  let media = `${base}/mp3`;
  const service = new OnlineAudioService({requestApi: async () => payload(media)});
  t.after(() => service.dispose());
  const mp3Url = await service.resolve({...input, quality: '320'});
  const audio = await service.respond(new Request(mp3Url));
  assert.equal(audio.headers.get('Content-Type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), mp3);
  media = `${base}/redirect`;
  const redirected = await service.respond(new Request(await service.resolve(input), {headers: {Range: 'bytes=0-3'}}));
  assert.equal(redirected.headers.get('Content-Type'), 'audio/flac');
  assert.equal(Buffer.from(await redirected.arrayBuffer()).toString(), 'fLaC');
  for (const path of ['/bad-redirect', '/loop', '/html', '/forbidden', '/expired']) {
    media = `${base}${path}`;
    await assert.rejects(service.resolve(input), error => {
      assert.ok(!error.message.includes(base));
      if (path === '/forbidden') assert.match(error.message, /拒绝访问.*403/);
      if (path === '/expired') assert.match(error.message, /已失效.*410/);
      return true;
    });
  }
});

test('rejects arbitrary URL/header inputs, invalid songs and qualities, unregistered tokens and malformed ranges', async t => {
  const {base, requests} = await fixture(t);
  let calls = 0;
  const service = new OnlineAudioService({requestApi: async () => {calls++; return payload(`${base}/flac`);}});
  t.after(() => service.dispose());
  for (const value of [null, [], {...input, url: `${base}/private`}, {...input, headers: {}}, {...input, quality: '960'},
    {...input, mid: 'a,b'}, {...input, mid: '../a'}, {...input, baseUrl: 'file:///tmp'}, {...input, baseUrl: 'http://user:secret@example.com'}]) {
    await assert.rejects(service.resolve(value));
  }
  assert.equal(calls, 0);
  const url = await service.resolve(input);
  for (const value of [`${url}?url=${encodeURIComponent(base)}`, url.replace('stream', 'other'), 'xmusic-online://stream/00000000-0000-0000-0000-000000000000']) {
    assert.equal((await service.respond(new Request(value))).status, 404);
  }
  for (const range of ['bytes=0-1,3-4', 'items=0-1', 'bytes=99-1', 'bytes=9007199254740992-', 'bytes=-0', 'bytes=9000-']) {
    assert.equal((await service.respond(new Request(url, {headers: {Range: range}}))).status, 416);
  }
  assert.equal((await service.respond(new Request(url, {method: 'POST'}))).status, 405);
  assert.equal(requests.length, 1);
});

test('does not register unsafe resolved URLs, missing quality results, or service failure envelopes', async () => {
  let result;
  const service = new OnlineAudioService({requestApi: async () => result, fetcher: async () => {throw new Error('must not fetch');}});
  try {
    for (result of [payload('javascript:alert(1)'), payload('file:///private.flac'), payload('http://user:secret@example.com/song.mp3'),
      payload('https://example.com/song.mp3#private'), payload(''), {code: 403, data: {test_mid: 'https://example.com/a'}}, {data: {other: 'https://example.com/a'}}]) {
      await assert.rejects(service.resolve(input));
    }
    assert.equal(service.entries.size, 0);
  } finally {service.dispose();}
});

test('caps token registrations and expires unused tokens without persisting remote URLs', async t => {
  const {base} = await fixture(t);
  let time = 1;
  const service = new OnlineAudioService({requestApi: async () => payload(`${base}/flac`), now: () => time, ttlMs: 50, maxEntries: 2});
  t.after(() => service.dispose());
  const urls = [];
  for (let index = 0; index < 3; index++) urls.push(await service.resolve(input));
  assert.equal(service.entries.size, 2);
  assert.equal((await service.respond(new Request(urls[0]))).status, 404);
  assert.equal(service.failure(urls[0]).code, 'AUDIO_TOKEN_EXPIRED');
  time += 51;
  assert.equal((await service.respond(new Request(urls[2]))).status, 404);
  assert.equal(service.failure(urls[2]).code, 'AUDIO_TOKEN_EXPIRED');
  assert.equal(service.entries.size, 0);
});

test('probes only a bounded prefix and streams with backpressure and upstream cancellation', async () => {
  let fetched = 0;
  let pulls = 0;
  let cancelled = 0;
  const signals = [];
  const service = new OnlineAudioService({requestApi: async () => payload('https://media.example/audio.flac'), fetcher: async (_url, options) => {
    signals.push(options.signal);
    if (++fetched === 1) return new Response(new ReadableStream({
      pull(controller) {controller.enqueue(flac);}, cancel() {cancelled++;},
    }), {headers: {'Content-Length': '100000000'}});
    return new Response(new ReadableStream({
      pull(controller) {pulls++; controller.enqueue(flac);}, cancel() {cancelled++;},
    }), {headers: {'Content-Length': '100000000'}});
  }});
  try {
    const url = await service.resolve(input);
    assert.equal(cancelled, 1);
    const response = await service.respond(new Request(url));
    const reader = response.body.getReader();
    assert.equal((await reader.read()).value.byteLength, flac.length);
    assert.ok(pulls < 10, 'must not buffer the whole media source before playback');
    await reader.cancel();
    assert.equal(cancelled, 2);
    assert.ok(signals[1].aborted);
    assert.equal(service.controllers.size, 0);
  } finally {service.dispose();}
});

test('times out media requests with a useful safe message and disposes in-flight requests', async () => {
  let activeSignal;
  const service = new OnlineAudioService({requestApi: async () => payload('https://media.example/?token=private'), timeoutMs: 10,
    fetcher: async (_url, {signal}) => {activeSignal = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('https://media.example/?token=private')), {once: true}));}});
  await assert.rejects(service.resolve(input), /音频网络请求超时/);
  assert.equal(service.controllers.size, 0);
  const pending = service.resolve(input);
  await new Promise(resolve => setImmediate(resolve));
  service.dispose();
  await assert.rejects(pending, /已取消/);
  assert.ok(activeSignal.aborted);
  assert.equal(service.entries.size, 0);
});

test('rapid track changes cancel superseded source preparation before it can exhaust the request limit', async t => {
  const lookups = [];
  const service = new OnlineAudioService({requestApi: async (_request, {signal}) => new Promise((resolve, reject) => {
    lookups.push({signal, resolve});
    signal.addEventListener('abort', () => reject(new Error('请求已取消')), {once: true});
  }), fetcher: async () => new Response(flac)});
  t.after(() => service.dispose());
  const attempts = Array.from({length: 40}, () => service.resolve(input).then(url => ({url}), error => ({error})));
  assert.equal(lookups.length, 40, 'the newest track must still reach resolution after more than 32 rapid changes');
  assert.ok(lookups.slice(0, -1).every(lookup => lookup.signal.aborted));
  assert.equal(lookups.at(-1).signal.aborted, false);
  assert.ok(service.controllers.size <= 1);
  lookups.at(-1).resolve(payload('https://media.example/audio.flac'));
  const results = await Promise.all(attempts);
  assert.ok(results.slice(0, -1).every(result => result.error && /已取消/.test(result.error.message)));
  assert.match(results.at(-1).url, /^xmusic-online:\/\/stream\//);
  assert.equal(service.controllers.size, 0);
  assert.equal(service.entries.size, 1);
});

test('preparing another track does not abort an existing playback or seek response', async t => {
  const streamingSignals = [];
  const service = new OnlineAudioService({requestApi: async () => payload('https://media.example/audio.flac'),
    fetcher: async (_url, {headers, signal}) => {
      if (headers.Range === 'bytes=0-511') return new Response(flac.subarray(0, 512));
      streamingSignals.push(signal);
      return new Response(new ReadableStream({pull(controller) {controller.enqueue(flac);}}));
    }});
  t.after(() => service.dispose());
  const first = await service.resolve(input);
  const response = await service.respond(new Request(first));
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, flac.length);
  await service.resolve(input);
  assert.equal(streamingSignals[0].aborted, false);
  assert.equal((await reader.read()).value.byteLength, flac.length);
  await reader.cancel();
  assert.equal(streamingSignals[0].aborted, true);
  assert.equal(service.controllers.size, 0);
});

test('rejects inconsistent upstream ranges and cancels their bodies instead of passing corrupted offsets to the decoder', async () => {
  let responseRange = 'bytes 100-103/4096';
  let cancelled = 0;
  let requests = 0;
  const service = new OnlineAudioService({requestApi: async () => payload('https://media.example/audio.flac'), fetcher: async () => {
    if (++requests === 1) return new Response(flac.subarray(0, 512), {status: 206,
      headers: {'Content-Range': 'bytes 0-511/4096', 'Content-Length': '512'}});
    return new Response(new ReadableStream({cancel() {cancelled++;}}), {status: 206,
      headers: {'Content-Range': responseRange, 'Content-Length': '4'}});
  }});
  try {
    const url = await service.resolve(input);
    for (responseRange of ['bytes 100-103/4096', 'bytes 0-3/8192', 'bytes 0-8/4096', 'not-a-range']) {
      assert.equal((await service.respond(new Request(url, {headers: {Range: 'bytes=0-3'}}))).status, 502);
    }
    assert.equal(cancelled, 4);
    assert.equal(service.controllers.size, 0);
  } finally {service.dispose();}
});
