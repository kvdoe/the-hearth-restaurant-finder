// Server-side autocomplete: Photon (Komoot) → Nominatim
// Photon has much better US residential address coverage than plain Nominatim.
// Running this server-side avoids browser CORS limits and lets us merge sources.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);

  const results = [];
  const seen    = new Set();

  function add(lat, lon, primary, secondary, icon = 'pin') {
    const key = `${primary}|${secondary}`;
    if (!primary || seen.has(key)) return;
    seen.add(key);
    results.push({
      lat: String(lat),
      lon: String(lon),
      primary,
      secondary,
      icon,
      displayName: [primary, secondary].filter(Boolean).join(', ')
    });
  }

  // ── Source 1: Photon by Komoot ─────────────────────────────────────────
  // Uses an enhanced version of OpenStreetMap with significantly better
  // US residential address coverage than standard Nominatim.
  try {
    const photonRes = await fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q.trim())}&limit=8&lang=en`,
      {
        headers: { 'User-Agent': 'TheHearthApp/1.0' },
        signal: AbortSignal.timeout(5000)
      }
    );
    if (photonRes.ok) {
      const data = await photonRes.json();
      for (const f of (data.features || [])) {
        const p   = f.properties || {};
        const cc  = (p.countrycode || '').toUpperCase();
        if (cc && cc !== 'US') continue; // US only

        const [lon, lat] = f.geometry.coordinates;
        let primary = '', secondary = '';

        if (p.housenumber && p.street) {
          primary   = `${p.housenumber} ${p.street}`;
          secondary = [p.city || p.town || p.village, p.state, p.postcode].filter(Boolean).join(', ');
          add(lat, lon, primary, secondary, 'house');
        } else if (p.name && p.type === 'street') {
          primary   = p.name;
          secondary = [p.city || p.town, p.state].filter(Boolean).join(', ');
          add(lat, lon, primary, secondary, 'road');
        } else if (p.name || p.city) {
          primary   = p.name || p.city || p.town || '';
          secondary = [p.state, p.postcode].filter(Boolean).join(', ');
          add(lat, lon, primary, secondary, 'city');
        }
      }
    }
  } catch (e) {
    console.error('Photon error:', e.message);
  }

  // ── Source 2: Nominatim (OSM) — fills gaps Photon misses ──────────────
  if (results.length < 5) {
    try {
      const params = new URLSearchParams({
        q:                q.trim(),
        format:           'json',
        limit:            '6',
        countrycodes:     'us',
        addressdetails:   '1',
        'accept-language':'en',
        dedupe:           '1'
      });
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        {
          headers: { 'User-Agent': 'TheHearthApp/1.0', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (nomRes.ok) {
        const data = await nomRes.json();
        for (const n of data) {
          const addr = n.address || {};
          let primary = '', secondary = '';

          if (addr.house_number && addr.road) {
            primary   = `${addr.house_number} ${addr.road}`;
            secondary = [addr.city || addr.town || addr.village, addr.state, addr.postcode].filter(Boolean).join(', ');
            add(n.lat, n.lon, primary, secondary, 'house');
          } else if (addr.road) {
            primary   = addr.road;
            secondary = [addr.city || addr.town, addr.state].filter(Boolean).join(', ');
            add(n.lat, n.lon, primary, secondary, 'road');
          } else if (addr.neighbourhood || addr.suburb) {
            primary   = addr.neighbourhood || addr.suburb;
            secondary = [addr.city || addr.town, addr.state].filter(Boolean).join(', ');
            add(n.lat, n.lon, primary, secondary, 'city');
          } else {
            const pts = n.display_name.split(', ');
            primary   = pts[0];
            secondary = pts.slice(1, 4).join(', ');
            add(n.lat, n.lon, primary, secondary, 'pin');
          }
        }
      }
    } catch (e) {
      console.error('Nominatim error:', e.message);
    }
  }

  // Cache suggestions for 60s to avoid hammering upstream APIs
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.json(results.slice(0, 7));
}