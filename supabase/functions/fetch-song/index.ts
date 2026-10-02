import { parseCifraHtml } from './_parser.js';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceKey = Deno.env.get('SERVICE_ROLE_KEY') || '';
const REST_URL = `${supabaseUrl}/rest/v1`;
function sbHeaders(extra) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...(extra || {})
  };
}
async function dbSelectSongs(qs) {
  const res = await fetch(`${REST_URL}/songs?${qs}`, {
    headers: sbHeaders()
  });
  if (!res.ok) return [];
  const rows = await res.json().catch(()=>[]);
  return Array.isArray(rows) ? rows : [];
}
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CC_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml'
};
// Palavras de ligação — não fazem parte do nome do artista nem do título da música.
const STOP = new Set([
  'a',
  'o',
  'as',
  'os',
  'um',
  'uma',
  'uns',
  'umas',
  'de',
  'do',
  'da',
  'dos',
  'das',
  'no',
  'na',
  'nos',
  'nas',
  'em',
  'e',
  'ou',
  'para',
  'pra',
  'pro',
  'pras',
  'pelo',
  'pela',
  'pelos',
  'pelas',
  'the',
  'an',
  'of',
  'to',
  'for',
  'and',
  'in',
  'on',
  'at',
  'my',
  'me',
  'your',
  'you',
  'minha',
  'meu',
  'sua',
  'seu',
  'essa',
  'esse',
  'com',
  'sem',
  'que',
  'tem',
  'voce',
  'quero',
  'cifra',
  'letra',
  'tocar',
  'musica',
  'part',
  'feat',
  'ft',
  'ao',
  'aos'
]);
function slugify(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// Se já veio um slug (ex.: "me-ama-"), não corta o hífen final.
function asSlug(text) {
  const raw = String(text || '').trim();
  if (/^[a-z0-9]+(?:-+[a-z0-9]+)*-?$/.test(raw)) return raw;
  return slugify(raw);
}
function slugArtistVariants(text) {
  const raw = asSlug(text);
  const base = slugify(raw);
  return [
    ...new Set([
      raw,
      base
    ].filter(Boolean))
  ];
}
function slugTitleVariants(text) {
  const raw = asSlug(text);
  const base = slugify(raw);
  return [
    ...new Set([
      raw,
      base,
      base ? `${base}-` : ''
    ].filter(Boolean))
  ];
}
function escReg(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function tokenize(q) {
  return String(q || '').split(/\s+/).filter(Boolean).map((w)=>w.toLowerCase());
}
function sleep(ms) {
  return new Promise((resolve)=>setTimeout(resolve, ms));
}
// Extrai [artista, música] do path de uma URL final do Cifra Club.
function slugPairFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts[parts.length - 1]?.endsWith('.html')) parts.pop();
    if (parts.length >= 2) return [
      parts[0],
      parts[1]
    ];
  } catch  {}
  return null;
}
function firstSegFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[0] || null;
  } catch  {
    return null;
  }
}
async function fetchCc(path) {
  // Pequena pausa entre requisições ao Cifra Club para não levar bloqueio.
  await sleep(180);
  const res = await fetch(`https://www.cifraclub.com.br/${path}`, {
    headers: CC_HEADERS,
    redirect: 'follow'
  });
  if (res.status === 404) return {
    ok: false,
    status: 404
  };
  if (!res.ok) return {
    ok: false,
    status: res.status
  };
  return {
    ok: true,
    html: await res.text(),
    finalUrl: res.url || ''
  };
}
function hasCifraContent(html) {
  return String(html || '').includes('data-chord-content="true"') || /<pre[^>]*>[\s\S]*?<b>[A-G]/.test(html);
}
async function waybackAvailable(target) {
  try {
    const avail = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, {
      headers: {
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!avail.ok) return null;
    const j = await avail.json().catch(()=>({}));
    return j?.archived_snapshots?.closest?.timestamp || null;
  } catch  {
    return null;
  }
}
async function waybackCdx(target) {
  try {
    const url = `https://web.archive.org/cdx/search/cdx?url=${target}&output=json&fl=timestamp&filter=statuscode:200&filter=mimetype:text/html&collapse=digest&limit=25&from=2016`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA
      },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return null;
    const rows = await r.json().catch(()=>[]);
    if (!Array.isArray(rows) || rows.length < 2) return null;
    // última captura disponível
    return rows[rows.length - 1]?.[0] || null;
  } catch  {
    return null;
  }
}
async function fetchSnapshot(target, ts) {
  const raw = `https://web.archive.org/web/${ts}id_/http://${target}`;
  for(let attempt = 0; attempt < 3; attempt++){
    try {
      const r = await fetch(raw, {
        headers: {
          'User-Agent': UA
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000)
      });
      if (r.status === 429) {
        await sleep(1200);
        continue;
      }
      if (!r.ok) return null;
      return await r.text();
    } catch  {
      return null;
    }
  }
  return null;
}
// Quando o Cifra Club bloqueia o nosso IP (403), tenta o snapshot público do
// Wayback Machine. Não é evasão de bloqueio: é um arquivo público e legítimo.
// Modo "deep" (2ª passada): consulta também a API CDX e o host sem "www".
async function fetchWayback(path, deep) {
  const targets = deep ? [
    `www.cifraclub.com.br/${path}`,
    `cifraclub.com.br/${path}`
  ] : [
    `www.cifraclub.com.br/${path}`
  ];
  for (const target of targets){
    const stamps = [];
    const av = await waybackAvailable(target);
    if (av) stamps.push(av);
    if (deep) {
      const cd = await waybackCdx(target);
      if (cd && !stamps.includes(cd)) stamps.push(cd);
    }
    for (const ts of stamps){
      const html = await fetchSnapshot(target, ts);
      if (html && hasCifraContent(html)) {
        return {
          ok: true,
          html,
          finalUrl: `https://www.cifraclub.com.br/${path}`
        };
      }
    }
  }
  return {
    ok: false,
    status: 404
  };
}
function youtubeIdsFrom(html) {
  const ids = [];
  const re = /youtubeID\\*":\\*"([A-Za-z0-9_-]{6,})/g;
  let m;
  while(m = re.exec(html))ids.push(m[1]);
  return [
    ...new Set(ids)
  ];
}
async function upsertSong(song) {
  const res = await fetch(`${REST_URL}/songs?on_conflict=slug_artist,slug_title,version`, {
    method: 'POST',
    headers: sbHeaders({
      Prefer: 'resolution=merge-duplicates,return=representation'
    }),
    body: JSON.stringify(song)
  });
  if (!res.ok) throw new Error(`Falha ao salvar a cifra (${res.status}).`);
  const rows = await res.json().catch(()=>[]);
  return Array.isArray(rows) ? rows[0] : rows;
}
function decodeRow(row) {
  if (!row) return row;
  try {
    return {
      ...row,
      content: JSON.parse(row.content)
    };
  } catch  {
    return row;
  }
}
function cifraUrls(slugArtist, slugTitle, version) {
  const isSimplificada = version === 'simplificada';
  const artists = slugArtistVariants(slugArtist);
  const titles = slugTitleVariants(slugTitle);
  const urls = [];
  const seen = new Set();
  for (const a of artists){
    for (const t of titles){
      const url = isSimplificada ? `https://www.cifraclub.com.br/${a}/${t}/simplificada.html` : `https://www.cifraclub.com.br/${a}/${t}/`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}
function prettifySlug(slug) {
  const small = new Set([
    'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'as', 'os',
    'em', 'no', 'na', 'nos', 'nas', 'com', 'que', 'para', 'por', 'ao', 'aos'
  ]);
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w, i) => {
      const low = w.toLowerCase();
      if (i > 0 && small.has(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(' ');
}
async function scrapeSong({ slugArtist, slugTitle, version, resolved, deep }) {
  const isSimplificada = version === 'simplificada';
  const urls = cifraUrls(slugArtist, slugTitle, version);
  let found = null;
  let url = urls[0];
  for (const candidate of urls){
    url = candidate;
    const path = candidate.replace(/^https?:\/\/www\.cifraclub\.com\.br\//, '');
    try {
      const r = await fetch(candidate, {
        headers: CC_HEADERS,
        redirect: 'follow'
      });
      if (r.ok) {
        const h = await r.text();
        if (hasCifraContent(h)) {
          found = {
            html: h,
            url: r.url || candidate
          };
          break;
        }
      }
    } catch  {
    }
    const wb = await fetchWayback(path, deep);
    if (wb.ok && hasCifraContent(wb.html)) {
      found = {
        html: wb.html,
        url: `https://www.cifraclub.com.br/${path}`
      };
      break;
    }
  }
  if (!found) {
    if (resolved) {
      const err = new Error(isSimplificada ? 'Esta música não tem versão simplificada no Cifra Club.' : 'Não encontramos essa música no Cifra Club. Confira o artista e o título.');
      err.status = 404;
      throw err;
    }
    const artistSlug = asSlug(slugArtist);
    const page = await fetchCc(`${artistSlug}/`);
    if (page.ok) {
      const realArtist = firstSegFromUrl(page.finalUrl) || artistSlug;
      const tokens = tokenize(String(slugTitle).replace(/-/g, ' '));
      let foundSlug = matchSongSlug(page.html, realArtist, tokens);
      if (!foundSlug) {
        const all = await fetchCc(`${realArtist}/musicas.html`);
        if (all.ok) foundSlug = matchSongSlug(all.html, realArtist, tokens);
      }
      if (foundSlug) {
        return scrapeSong({
          slugArtist: realArtist,
          slugTitle: foundSlug,
          version,
          resolved: true,
          deep
        });
      }
    }
    const err = new Error(isSimplificada ? 'Esta música não tem versão simplificada no Cifra Club.' : 'Não encontramos essa música no Cifra Club. Confira o artista e o título.');
    err.status = 404;
    throw err;
  }
  const html = found.html;
  const res = {
    url: found.url
  };
  // Usa o slug canônico da URL final (o Cifra Club pode redirecionar,
  // ex.: "/diante-do-trono/me-ama" -> "/diante-do-trono/me-ama-/").
  const canon = slugPairFromUrl(res.url);
  if (canon) {
    slugArtist = canon[0];
    slugTitle = canon[1];
  }
  const { lines, tuning, toneRoot } = parseCifraHtml(html);
  // título/artista a partir dos metadados da página
  const nameMatch = html.match(/"name":"([^"]+) - ([^"]+)"/);
  let artist = nameMatch?.[1] || null;
  let title = nameMatch?.[2] || null;
  const imgMatch = html.match(/"image":"([^"]+\.jpg)"/);
  const imageUrl = imgMatch?.[1] || null;
  // vídeo: prefere o clipe "oficial" (fora da seção videoLesson)
  const allIds = youtubeIdsFrom(html);
  let youtubeId = null;
  if (allIds.length) {
    const lessonPos = html.indexOf('videoLesson');
    const isLesson = (id)=>{
      if (lessonPos === -1) return false;
      const pos = html.indexOf(id, lessonPos);
      return pos !== -1 && pos - lessonPos < 1200;
    };
    youtubeId = allIds.find((id)=>!isLesson(id)) || allIds[0];
  }
  const chordRootRe = /^[A-Ga-g][#b]?/;
  let toneRootName = toneRoot || null;
  for(let k = lines.length - 1; k >= 0; k--){
    const l = lines[k];
    let name = null;
    if (l.kind === 'verse' && l.chordAt.length) {
      const top = l.chordAt[l.chordAt.length - 1];
      name = top.names[top.names.length - 1];
    } else if (l.kind === 'chords' && l.chords.length) {
      name = l.chords[l.chords.length - 1];
    }
    if (name) {
      toneRootName = (name.match(chordRootRe) || [
        null
      ])[0];
      break;
    }
  }
  return {
    artist: artist || prettifySlug(slugArtist),
    title: title || prettifySlug(slugTitle),
    slug_artist: slugArtist,
    slug_title: slugTitle,
    version,
    cifraclub_url: url,
    youtube_url: youtubeId ? `https://www.youtube.com/watch?v=${youtubeId}` : null,
    image_url: imageUrl,
    tuning,
    tone_root: toneRootName,
    content: JSON.stringify(lines)
  };
}
// Procura no HTML da página do artista o slug da música que mais combina com o
// título digitado. Retorna o slug cru encontrado (ex.: "me-ama-") ou null.
function matchSongSlug(html, artistSlug, titleTokens) {
  const words = (titleTokens || []).map((w)=>w.toLowerCase());
  const core = words.filter((w)=>!STOP.has(w));
  if (!core.length) return null;
  const coreJoinSlug = core.map(slugify).filter(Boolean).join('-');
  if (!coreJoinSlug || coreJoinSlug.length < 2) return null;
  const coreSlugSet = new Set(core.map(slugify).filter(Boolean));
  const re = new RegExp(`href="/${escReg(artistSlug)}/([a-z0-9-]+)/`, 'g');
  let m;
  let best = null;
  let bestScore = -1;
  while(m = re.exec(html)){
    const raw = m[1];
    if (!raw || raw.includes('.') || raw.length < 2) continue;
    const slug = raw.replace(/-+$/, '');
    let score = -1;
    if (slug === coreJoinSlug) {
      score = 100;
    } else if (slug.startsWith(coreJoinSlug + '-')) {
      score = 85;
    } else {
      const st = slug.split('-').filter(Boolean);
      let overlap = 0;
      for (const tok of st)if (coreSlugSet.has(tok)) overlap++;
      const ratio = overlap / core.length;
      if (ratio >= 0.6) {
        score = 50 + Math.round(ratio * 30) - Math.round(Math.abs(slug.length - coreJoinSlug.length) / 8);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = raw;
    }
  }
  return best;
}
function notFoundError() {
  const err = new Error('Não encontramos essa música no Cifra Club. Confira o nome do artista e da música — ex.: "diante do trono me ama".');
  err.status = 404;
  return err;
}
function cleanTrackName(name) {
  return String(name || '').replace(/\s*\((?:live|ao vivo|acoustic|ac[uú]stico|remix|radio edit|oficial|espont[aâ]neo|playback)[^)]*\)/gi, '').replace(/\s*\[(?:live|ao vivo|playback|oficial|espont[aâ]neo)[^\]]*\]/gi, '').replace(/\s+\(feat\.?[^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();
}
function parseJsonp(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch  {
      return null;
    }
  }
  const start = raw.indexOf('(');
  const end = raw.lastIndexOf(')');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start + 1, end));
  } catch  {
    return null;
  }
}
function mapCifraDoc(d) {
  if (!d || String(d.t) !== '2') return null;
  if (Number(d.block) === 1) return null;
  const artist = String(d.art || '').trim();
  const title = String(d.txt || '').trim();
  const slug_artist = String(d.dns || '').trim();
  const slug_title = String(d.url || '').trim();
  if (!artist || !title || !slug_artist || !slug_title) return null;
  return {
    artist,
    title,
    slug_artist,
    slug_title,
    image_url: d.imgm || null
  };
}
function remoteHitKey(h) {
  const sa = String(h.slug_artist || '').toLowerCase();
  const st = String(h.slug_title || '').toLowerCase().replace(/-+$/, '');
  if (sa && st) return `s:${sa}|${st}`;
  return `n:${String(h.artist || '').toLowerCase()}|${String(h.title || '').toLowerCase()}`;
}
async function searchCifraClubHits(q, limit = 10) {
  const query = String(q || '').trim();
  if (!query) return [];
  const url = `https://solr.sscdn.co/cc/ac-mini?q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = parseJsonp(await res.text());
  const docs = data?.response?.docs || [];
  const out = [];
  const seen = new Set();
  for (const d of docs){
    const hit = mapCifraDoc(d);
    if (!hit) continue;
    const key = remoteHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}
async function searchItunesHits(q) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=10&country=BR`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!res.ok) return [];
  const data = await res.json().catch(()=>({}));
  const out = [];
  const seen = new Set();
  for (const r of data.results || []){
    const artist = String(r.artistName || '').split(',')[0].trim();
    const title = cleanTrackName(r.trackName);
    if (!artist || !title) continue;
    const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      artist,
      title,
      image_url: r.artworkUrl100 ? String(r.artworkUrl100).replace('100x100', '200x200') : null
    });
  }
  return out;
}
function scoreResolvedHit(hit, artist, title) {
  const a = slugify(artist);
  const t = slugify(cleanTrackName(title) || title);
  if (!a || !t) return -1;
  const ha = slugify(hit.artist);
  const ht = slugify(hit.title);
  const sa = slugify(hit.slug_artist);
  const st = slugify(hit.slug_title);
  let score = 0;
  if (st === t || ht === t) score += 50;
  else if (st.startsWith(t) || t.startsWith(st) || ht.startsWith(t) || t.startsWith(ht)) score += 20;
  else return -1;
  if (sa === a || ha === a) score += 40;
  const aliases = String(hit.artist).match(/\(([^)]+)\)/g) || [];
  for (const raw of aliases){
    const inner = slugify(raw.slice(1, -1));
    if (!inner) continue;
    if (inner === a || inner.includes(a) || a.includes(inner)) score += 40;
  }
  if (ha.includes(a) || a.includes(ha) || sa.includes(a) || a.includes(sa)) score += 25;
  return score;
}
async function resolveCifraSlugs(artist, title) {
  const queries = [
    `${artist} ${title}`,
    `${title} ${artist}`,
    title
  ];
  let best = null;
  let bestScore = 59;
  for (const q of queries){
    let hits = [];
    try {
      hits = await searchCifraClubHits(q, 12);
    } catch  {
      continue;
    }
    for (const hit of hits){
      const score = scoreResolvedHit(hit, artist, title);
      if (score > bestScore) {
        bestScore = score;
        best = hit;
      }
    }
    if (best && bestScore >= 90) break;
  }
  return best;
}
async function searchHits(client, q) {
  const query = String(q || '').trim();
  if (query.length < 2) {
    const err = new Error('Digite pelo menos 2 letras para buscar.');
    err.status = 400;
    throw err;
  }
  const term = query.replace(/[\\%_*(),]/g, ' ');
  const orFilter = `or=(artist.ilike.*${encodeURIComponent(term)}*,title.ilike.*${encodeURIComponent(term)}*)`;
  const local = await dbSelectSongs('select=id,artist,title,slug_artist,slug_title,youtube_url,image_url,tone_root,version&version=eq.original&' + orFilter + '&order=created_at.desc&limit=10');
  const merged = [];
  const seen = new Set();
  for (const row of local || []){
    const key = remoteHitKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  try {
    for (const hit of (await searchCifraClubHits(query, 10))){
      const key = remoteHitKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
      if (merged.length >= 10) break;
    }
  } catch  {
  // índice do Cifra Club indisponível: cai no iTunes
  }
  if (merged.length < 10) {
    try {
      for (const hit of (await searchItunesHits(query))){
        const resolved = await resolveCifraSlugs(hit.artist, hit.title);
        if (!resolved) continue;
        const key = remoteHitKey(resolved);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(resolved);
        if (merged.length >= 10) break;
      }
    } catch  {
    // iTunes indisponível: devolve o que já tem
    }
  }
  return {
    hits: merged.slice(0, 10),
    source: merged.length ? 'search' : 'empty'
  };
}
function blockedError() {
  const err = new Error('O Cifra Club bloqueou a busca por enquanto. Tente de novo em alguns instantes.');
  err.status = 429;
  return err;
}
// Busca em texto livre: testa as combinações possíveis de artista (1–3 palavras
// no começo ou no fim) contra as páginas reais do Cifra Club até achar a cifra.
async function discoverSong(client, q) {
  const tokens = tokenize(q);
  if (tokens.length < 2) {
    const err = new Error('Inclua o artista na busca — ex.: "diante do trono me ama".');
    err.status = 404;
    throw err;
  }
  // Palpites de artista: do começo para o fim e do fim para o começo.
  const maxK = Math.min(3, tokens.length - 1);
  const guesses = [];
  const seen = new Set();
  const consider = (artistTokens, titleTokens)=>{
    const lead = artistTokens[0];
    if (!lead || STOP.has(lead)) return;
    const slug = slugify(artistTokens.join(' '));
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    guesses.push({
      artistSlug: slug,
      titleTokens
    });
  };
  for(let k = 1; k <= maxK; k++)consider(tokens.slice(0, k), tokens.slice(k));
  for(let k = 1; k <= maxK; k++)consider(tokens.slice(tokens.length - k), tokens.slice(0, tokens.length - k));
  let homeFetches = 0;
  let listFetches = 0;
  for (const guess of guesses){
    const guessTitleSlug = slugify(guess.titleTokens.join(' '));
    const coreSlug = guess.titleTokens.filter((w)=>!STOP.has(w)).map(slugify).filter(Boolean).join('-');
    // Caminho rápido: música já está no catálogo?
    if (guessTitleSlug) {
      const { data: exact } = await client.from('songs').select('*').eq('slug_artist', guess.artistSlug).eq('slug_title', guessTitleSlug).eq('version', 'original').maybeSingle();
      if (exact) return {
        source: 'cache',
        song: decodeRow(exact)
      };
    }
    if (coreSlug && coreSlug !== guessTitleSlug) {
      const { data: prefixRows } = await client.from('songs').select('*').eq('slug_artist', guess.artistSlug).eq('version', 'original').like('slug_title', `${coreSlug}%`).limit(5);
      const prefixed = (prefixRows || []).find((r)=>r.slug_title === coreSlug || r.slug_title.startsWith(`${coreSlug}-`) || r.slug_title.startsWith(`${coreSlug} `));
      if (prefixed) return {
        source: 'cache',
        song: decodeRow(prefixed)
      };
    }
    if (homeFetches >= 6) break;
    homeFetches++;
    const page = await fetchCc(`${guess.artistSlug}/`);
    if (!page.ok) {
      if (page.status === 429 || page.status === 403 || page.status >= 500 && page.status <= 599) {
        throw blockedError();
      }
      continue;
    }
    const realArtistSlug = firstSegFromUrl(page.finalUrl) || guess.artistSlug;
    let songSlug = matchSongSlug(page.html, realArtistSlug, guess.titleTokens);
    if (!songSlug && listFetches < 2) {
      listFetches++;
      const all = await fetchCc(`${realArtistSlug}/musicas.html`);
      if (all.ok) songSlug = matchSongSlug(all.html, realArtistSlug, guess.titleTokens);
    }
    if (songSlug) {
      const scraped = await scrapeSong({
        slugArtist: realArtistSlug,
        slugTitle: songSlug,
        version: 'original'
      });
      const row = await upsertSong(client, scraped);
      return {
        source: 'scraped',
        song: decodeRow(row)
      };
    }
  }
  throw notFoundError();
}
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({
        error: {
          message: 'Use POST.'
        }
      }), {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const body = await req.json().catch(()=>({}));
    const q = String(body.q || '').trim();
    const artist = String(body.artist || '').trim();
    const title = String(body.title || '').trim();
    const requestedArtistSlug = String(body.slug_artist || '').trim();
    const requestedTitleSlug = String(body.slug_title || '').trim();
    const version = [
      'original',
      'simplificada'
    ].includes(body.version) ? body.version : 'original';
    const deep = body.deep === true;
    if (!serviceKey) {
      return new Response(JSON.stringify({
        error: {
          message: 'Edge Function sem SERVICE_ROLE_KEY. Defina o secret no Supabase (veja o README).'
        }
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Modo busca: devolve até 10 cifras próximas (catálogo + Cifra Club)
    if (q) {
      const result = await searchHits(null, q);
      return new Response(JSON.stringify({
        mode: 'search',
        source: result.source,
        hits: result.hits
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (!artist || !title) {
      return new Response(JSON.stringify({
        error: {
          message: 'Informe artista e música.'
        }
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    const slugArtist = asSlug(requestedArtistSlug || artist);
    const slugTitle = asSlug(requestedTitleSlug || cleanTrackName(title) || title);
    async function findCached(artistSlug, titleSlug) {
      for (const a of slugArtistVariants(artistSlug)){
        for (const t of slugTitleVariants(titleSlug)){
          const rows = await dbSelectSongs(`select=*&slug_artist=eq.${encodeURIComponent(a)}&slug_title=eq.${encodeURIComponent(t)}&version=eq.${encodeURIComponent(version)}&limit=1`);
          if (rows && rows[0]) return rows[0];
        }
      }
      return null;
    }
    // 1. já temos no catálogo? (tenta variantes: me-ama e me-ama-)
    const cached = await findCached(slugArtist, slugTitle);
    if (cached) {
      return new Response(JSON.stringify({
        source: 'cache',
        song: decodeRow(cached)
      }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // 2. raspa; se o slug do iTunes não existir no Cifra Club, resolve pelo índice
    let scraped;
    try {
      scraped = await scrapeSong({
        slugArtist,
        slugTitle,
        version,
        deep
      });
    } catch (err) {
      if (err.status !== 404) throw err;
      const resolved = await resolveCifraSlugs(artist, title);
      if (!resolved) throw err;
      const resolvedCache = await findCached(resolved.slug_artist, resolved.slug_title);
      if (resolvedCache) {
        return new Response(JSON.stringify({
          source: 'cache',
          song: decodeRow(resolvedCache)
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      scraped = await scrapeSong({
        slugArtist: resolved.slug_artist,
        slugTitle: resolved.slug_title,
        version,
        resolved: true,
        deep
      });
    }
    const song = await upsertSong(scraped);
    return new Response(JSON.stringify({
      source: 'scraped',
      song: decodeRow(song)
    }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: {
        message: err.message || 'Erro inesperado.'
      }
    }), {
      status: err.status || 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
