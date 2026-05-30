export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, cuisine, budget } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Address is required.' });
  }

  const YELP_API_KEY = process.env.YELP_API_KEY;
  if (!YELP_API_KEY) {
    return res.status(500).json({
      error: 'YELP_API_KEY is not set. Add it in Vercel → Settings → Environment Variables.'
    });
  }

  try {
    // 1. Geocode the address via Nominatim (free, no key needed)
    const geoUrl =
      'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(address) +
      '&format=json&limit=1&addressdetails=1';

    const geoRes = await fetch(geoUrl, {
      headers: {
        'User-Agent': 'TheHearthRestaurantFinder/1.0',
        'Accept-Language': 'en'
      }
    });

    if (!geoRes.ok) {
      return res.status(502).json({ error: 'Geocoding service unavailable. Try again.' });
    }

    const geoData = await geoRes.json();

    if (!geoData || geoData.length === 0) {
      return res.status(404).json({
        error: 'Address not found. Try a more specific location (include city and state).'
      });
    }

    const { lat, lon, display_name } = geoData[0];

    // 2. Map budget to Yelp price filter (cumulative: $$ shows $ and $$ results)
    const budgetMap = {
      '1': '1',
      '2': '1,2',
      '3': '1,2,3',
      '4': '1,2,3,4',
      any: '1,2,3,4'
    };
    const priceFilter = budgetMap[budget] || '1,2,3,4';
    const categoryFilter = cuisine || 'restaurants';

    // 3. Search Yelp Fusion API
    const yelpParams = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      categories: categoryFilter,
      price: priceFilter,
      sort_by: 'distance',
      limit: '12',
      radius: '8000' // ~5 miles
    });

    const yelpRes = await fetch(
      'https://api.yelp.com/v3/businesses/search?' + yelpParams.toString(),
      {
        headers: { Authorization: 'Bearer ' + YELP_API_KEY }
      }
    );

    if (!yelpRes.ok) {
      const errBody = await yelpRes.text().catch(() => '');
      console.error('Yelp error', yelpRes.status, errBody);
      if (yelpRes.status === 401) {
        return res.status(502).json({ error: 'Invalid Yelp API key. Check your YELP_API_KEY env variable.' });
      }
      return res.status(502).json({ error: 'Restaurant data unavailable right now. Try again shortly.' });
    }

    const yelpData = await yelpRes.json();
    const businesses = yelpData.businesses || [];

    // 4. Enrich first 6 results with actual website URL from the details endpoint
    //    (search endpoint only returns the Yelp listing URL, not the restaurant's own site)
    const toEnrich = businesses.slice(0, 6);
    const enriched = await Promise.allSettled(
      toEnrich.map(async (b) => {
        try {
          const detRes = await fetch('https://api.yelp.com/v3/businesses/' + b.id, {
            headers: { Authorization: 'Bearer ' + YELP_API_KEY }
          });
          if (detRes.ok) {
            const det = await detRes.json();
            return { ...b, website: det.website || null };
          }
        } catch (_) { /* fall through */ }
        return { ...b, website: null };
      })
    );

    const enrichedMap = {};
    enriched.forEach((r, i) => {
      if (r.status === 'fulfilled') enrichedMap[toEnrich[i].id] = r.value;
    });

    const restaurants = businesses.map((b) => enrichedMap[b.id] || b);

    return res.status(200).json({
      restaurants,
      total: yelpData.total || businesses.length,
      geocoded: display_name
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
}