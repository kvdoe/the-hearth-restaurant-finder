// Smart autocomplete: detects query type and routes to the right source.
// Street addresses → Census Bureau (official US government data, ~100% coverage).
// City / neighborhood / ZIP → Photon then Nominatim.
// No API keys required.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);
  const query = q.trim();

  const results = [];
  const seen    = new Set();

  function push(lat, lon, primary, secondary, icon = 'pin', displayName) {
    const key = `${String(lat).slice(0,8)}|${String(lon).slice(0,8)}`;
    if (!primary || seen.has(key)) return;
    seen.add(key);
    results.push({
      lat:         String(lat),
      lon:         String(lon),
      primary,
      secondary,
      icon,
      displayName: displayName || [primary, secondary].filter(Boolean).join(', ')
    });
  }

  // Detect query type
  const isStreetAddress = /^\d/.test(query);             // starts with a number
  const isZip           = /^\d{5}$/.test(query.trim());  // exactly 5 digits

  // ── Census Bureau: street addresses ────────────────────────────────────────
  // Uses the TIGER/Line database — the official US address registry.
  // Only fires when the user has typed enough to resemble a real address.
  if (isStreetAddress && query.length >= 8) {
    try {
      const cp = new URLSearchParams({ address: query, benchmark: 'Public_AR_Current', format: 'json' });
      const cr = await fetch(
        `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${cp}`,
        { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(5500) }
      );
      if (cr.ok) {
        const cd = await cr.json();
        for (const m of (cd?.result?.addressMatches || [])) {
          const parts = m.matchedAddress.split(', ');
          push(
            m.coordinates.y, m.coordinates.x,
            parts.slice(0, 2).join(', '),   // e.g. "7818 Ravenden Rd, Frisco"
            parts.slice(2).join(', '),        // e.g. "TX, 75035"
            'house',
            m.matchedAddress
          );
        }
      }
    } catch (e) { console.error('Census autocomplete:', e.message); }
  }

  // ── Photon (Komoot): cities, neighborhoods, partial addresses ──────────────
  if (results.length < 6) {
    try {
      const photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=8&lang=en`;
      const pr = await fetch(photonUrl, {
        headers: { 'User-Agent': 'TheHearthApp/1.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (pr.ok) {
        const pd = await pr.json();
        for (const f of (pd.features || [])) {
          const p  = f.properties || {};
          const cc = (p.countrycode || '').toUpperCase();
          if (cc && cc !== 'US') continue;
          const [lon, lat] = f.geometry.coordinates;
          let primary = '', secondary = '', icon = 'pin';

          if (p.housenumber && p.street) {
            primary   = `${p.housenumber} ${p.street}`;
            secondary = [p.city || p.town || p.village, p.state, p.postcode].filter(Boolean).join(', ');
            icon      = 'house';
          } else if (p.name || p.city || p.town) {
            primary   = p.name || p.city || p.town || '';
            secondary = [p.state, p.postcode].filter(Boolean).join(', ');
            icon      = 'city';
          }
          if (primary) push(lat, lon, primary, secondary, icon);
        }
      }
    } catch (e) { console.error('Photon:', e.message); }
  }

  // ── Nominatim: fills remaining gaps ────────────────────────────────────────
  if (results.length < 4) {
    try {
      const np = new URLSearchParams({
        q: query, format: 'json', limit: '5',
        countrycodes: 'us', addressdetails: '1',
        'accept-language': 'en', dedupe: '1'
      });
      const nr = await fetch(`https://nominatim.openstreetmap.org/search?${np}`, {
        headers: { 'User-Agent': 'TheHearthApp/1.0', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(4500)
      });
      if (nr.ok) {
        const nd = await nr.json();
        for (const n of nd) {
          const addr = n.address || {};
          const primary = addr.house_number && addr.road
            ? `${addr.house_number} ${addr.road}`
            : (addr.road || addr.city || addr.town || n.display_name.split(',')[0]);
          const secondary = [addr.city || addr.town || addr.village, addr.state, addr.postcode].filter(Boolean).join(', ');
          push(n.lat, n.lon, primary, secondary, addr.house_number ? 'house' : 'city', n.display_name);
        }
      }
    } catch (e) { console.error('Nominatim:', e.message); }
  }

  return res.json(results.slice(0, 7));
}
