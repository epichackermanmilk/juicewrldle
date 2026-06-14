/**
 * build-daily.js
 * Run from your repo root: node build-daily.js
 *
 * Phase 1 — probes the API to find where audio paths live.
 * Phase 2 — if paths exist on /songs/, rebuilds songs.json with them included.
 * Phase 3 — if /songs/ has no paths, collects them via /radio/random/ over many calls.
 *
 * Output: an updated songs.json where every entry has a `path` field.
 * Once that file is committed, getDailySong() becomes pure deterministic math.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const API        = 'https://juicewrldapi.com';
const SONGS_FILE = path.join(__dirname, 'songs.json');
const OUT_FILE   = path.join(__dirname, 'songs.json'); // overwrite in-place

// ── HTTP helper ──────────────────────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'JuiceWRLDLE-builder/1.0' } }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${raw.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalize(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== JuiceWRLDLE build-daily.js ===\n');

  // ── PHASE 1: probe API structure ──────────────────────────────────────────
  console.log('PHASE 1 — probing API structure\n');

  let randomSample;
  try {
    randomSample = await get(`${API}/radio/random/`);
    console.log('[/radio/random/] top-level keys:', Object.keys(randomSample).join(', '));
    console.log('[/radio/random/] path value    :', randomSample.path);
    console.log('[/radio/random/] song keys     :', randomSample.song ? Object.keys(randomSample.song).join(', ') : 'no .song field');
    console.log('[/radio/random/] song.name     :', randomSample.song && randomSample.song.name);
    console.log('');
  } catch (e) {
    console.error('ERROR fetching /radio/random/:', e.message);
    process.exit(1);
  }

  let songsSample;
  try {
    const r = await get(`${API}/songs/?page_size=1`);
    const results = Array.isArray(r) ? r : (r.results || []);
    songsSample = results[0] || null;
    if (songsSample) {
      console.log('[/songs/] top-level keys:', Object.keys(songsSample).join(', '));
      console.log('[/songs/] .path value   :', songsSample.path);
      console.log('[/songs/] .file_names   :', JSON.stringify(songsSample.file_names));
      console.log('[/songs/] .audio_url    :', songsSample.audio_url);
      console.log('[/songs/] .media_url    :', songsSample.media_url);
      console.log('[/songs/] .download_url :', songsSample.download_url);
      console.log('[/songs/] COUNT total   :', r.count || '(array, no count)');
    } else {
      console.log('[/songs/] returned empty results');
    }
  } catch (e) {
    console.error('ERROR fetching /songs/:', e.message);
  }
  console.log('');

  // ── PHASE 2: if /songs/ has paths, rebuild songs.json from it ─────────────
  const songsHasPath = songsSample && (songsSample.path || songsSample.audio_url || songsSample.media_url);
  if (songsHasPath) {
    console.log('PHASE 2 — /songs/ has a path field! Rebuilding songs.json via pagination.\n');

    const pathField = songsSample.path ? 'path'
                    : songsSample.audio_url ? 'audio_url'
                    : 'media_url';
    console.log('Using field:', pathField, '\n');

    const collected = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
      try {
        const r = await get(`${API}/songs/?page_size=${pageSize}&page=${page}`);
        const results = Array.isArray(r) ? r : (r.results || []);
        if (!results.length) break;
        for (const s of results) {
          collected.push({
            name:     s.name || '',
            path:     s[pathField] || null,
            era:      (s.era && s.era.name) || s.era || '',
            category: s.category || '',
            titles:   s.track_titles || [],
          });
        }
        process.stdout.write(`  page ${page}: ${results.length} songs (total so far: ${collected.length})\r`);
        if (Array.isArray(r) || !r.next) break;
        page++;
        await sleep(200);
      } catch (e) {
        console.error(`\nError on page ${page}:`, e.message);
        break;
      }
    }

    console.log(`\nCollected ${collected.length} songs with paths.`);
    fs.writeFileSync(OUT_FILE, JSON.stringify(collected, null, 2));
    console.log('Saved to', OUT_FILE);
    return;
  }

  // ── PHASE 3: /songs/ has no paths — collect via /radio/random/ ────────────
  console.log('PHASE 3 — /songs/ has no path field. Collecting via /radio/random/.\n');
  console.log('Loading existing songs.json...');

  let existingSongs = [];
  try {
    existingSongs = JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read songs.json:', e.message);
    process.exit(1);
  }
  console.log(`Loaded ${existingSongs.length} songs.\n`);

  // Build a lookup by normalized name
  const nameToSong = new Map();
  for (const s of existingSongs) {
    nameToSong.set(normalize(s.name), s);
    for (const t of (s.titles || [])) nameToSong.set(normalize(t), s);
  }

  let found   = existingSongs.filter(s => s.path).length;
  let total   = existingSongs.length;
  const CALLS = 2000; // adjust higher for better coverage, lower to be faster

  console.log(`Starting ${CALLS} /radio/random/ calls to collect paths.`);
  console.log(`Songs already with paths: ${found}/${total}\n`);

  for (let i = 0; i < CALLS; i++) {
    try {
      const r   = await get(`${API}/radio/random/`);
      const p   = r.path;
      const n   = (r.song && r.song.name) || r.name || r.title || '';
      if (!p || !n) continue;

      const key  = normalize(n);
      const song = nameToSong.get(key);
      if (song && !song.path) {
        song.path = p;
        // also enrich metadata if missing
        if (!song.era && r.song && r.song.era) song.era = (r.song.era.name || r.song.era);
        if (!song.category && r.song && r.song.category) song.category = r.song.category;
        found++;
      }
    } catch (e) {
      // ignore individual failures
    }

    if (i % 50 === 0) {
      process.stdout.write(`  call ${i+1}/${CALLS} — paths found: ${found}/${total} (${Math.round(found/total*100)}%)\r`);
      await sleep(50); // gentle rate-limit
    }
  }

  console.log(`\n\nDone! Paths found: ${found}/${total} (${Math.round(found/total*100)}%)`);
  fs.writeFileSync(OUT_FILE, JSON.stringify(existingSongs, null, 2));
  console.log('Saved updated songs.json to', OUT_FILE);
  console.log('\nNext step: git add songs.json && git commit -m "feat: add audio paths to songs.json" && git push');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
