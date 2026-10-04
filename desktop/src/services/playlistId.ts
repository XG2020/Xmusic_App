const ID_PATTERN = /^\d{1,20}$/;

function cleanId(value: string | null): string | undefined {
  if (!value || !ID_PATTERN.test(value)) return undefined;
  const id = value.replace(/^0+/, '');
  return id || undefined;
}

/** Accept QQ playlist links and complete share text, without rounding long numeric IDs. */
export function parsePlaylistId(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 4096) return undefined;
  const direct = cleanId(input.trim());
  if (direct) return direct;
  for (const match of input.matchAll(/https?:\/\/[^\s，。"'<>【】]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[)\]）}、；;！!]+$/, '').replace(/&amp;/gi, '&'));
      if (!(url.hostname === 'y.qq.com' || url.hostname.endsWith('.y.qq.com')) || url.username || url.password || url.port) continue;
      const search = new URLSearchParams(url.search);
      const hashSearch = new URLSearchParams(url.hash.split('?')[1]);
      for (const key of ['id', 'disstid', 'dissid', 'playlistid']) {
        const id = cleanId(search.get(key) ?? hashSearch.get(key));
        if (id) return id;
      }
      const path = `${url.pathname}${url.hash}`.match(/\/(?:playlist|taoge)\/(\d{1,20})(?:[/?#]|$)/i);
      const id = cleanId(path?.[1] ?? null);
      if (id) return id;
    } catch { /* Continue to another link in the pasted share text. */ }
  }
  return undefined;
}
