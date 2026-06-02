// =============================================================================
// GOOGLE PLACES PROVIDER
// To activate: set RESTAURANT_PROVIDER=google + GOOGLE_PLACES_API_KEY in Vercel.
// To revert to Yelp: set RESTAURANT_PROVIDER=yelp (or remove the variable).
// =============================================================================

const YELP_TO_GOOGLE = {
  // American
  newamerican:      'american_restaurant',
  tradamerican:     'american_restaurant',
  pizza:            'pizza_restaurant',
  burgers:          'hamburger_restaurant',
  sandwiches:       'sandwich_shop',
  bbq:              'barbecue_restaurant',
  steak:            'steak_house',
  seafood:          'seafood_restaurant',
  // Asian
  chinese:          'chinese_restaurant',
  japanese:         'japanese_restaurant',
  sushi:            'sushi_restaurant',
  thai:             'thai_restaurant',
  korean:           'korean_restaurant',
  vietnamese:       'vietnamese_restaurant',
  ramen:            'ramen_restaurant',
  indpak:           'indian_restaurant',
  // Latin
  mexican:          'mexican_restaurant',
  tacos:            'mexican_restaurant',
  spanish:          'spanish_restaurant',
  caribbean:        'caribbean_restaurant',
  // European
  italian:          'italian_restaurant',
  french:           'french_restaurant',
  mediterranean:    'mediterranean_restaurant',
  greek:            'greek_restaurant',
  mideastern:       'middle_eastern_restaurant',
  // Healthy
  healthfood:       'health_food_store',
  acaibowls:        'health_food_store',
  poke:             'sushi_restaurant',
  vegetarian:       'vegetarian_restaurant',
  vegan:            'vegan_restaurant',
  // Breakfast / café
  breakfast_brunch: 'breakfast_restaurant',
  cafes:            'cafe',
  coffee:           'coffee_shop',
  bakeries:         'bakery',
  // Dessert
  desserts:         'dessert_shop',
  icecream:         'ice_cream_shop',
  donuts:           'donut_shop',
  cupcakes:         'bakery',
  // Generic
  restaurants:      'restaurant',
};

const GOOGLE_PRICE_DISPLAY = {
  PRICE_LEVEL_FREE:          null,
  PRICE_LEVEL_INEXPENSIVE:  '$',
  PRICE_LEVEL_MODERATE:     '$$',
  PRICE_LEVEL_EXPENSIVE:    '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE:'$$$$',
};

const BUDGET_TO_GOOGLE = {
  '1':  new Set(['PRICE_LEVEL_INEXPENSIVE']),
  '2':  new Set(['PRICE_LEVEL_MODERATE']),
  '3':  new Set(['PRICE_LEVEL_EXPENSIVE']),
  '4':  new Set(['PRICE_LEVEL_VERY_EXPENSIVE']),
  'any': null, // null = no price filter
};

function haversineM(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGoogleAddress(components) {
  const get = (type, long = true) =>
    (components || []).find(c => (c.types || []).includes(type))?.[long ? 'longText' : 'shortText'] || '';
  return {
    address1: [get('street_number'), get('route')].filter(Boolean).join(' '),
    city:     get('locality') || get('sublocality') || get('administrative_area_level_2'),
    state:    get('administrative_area_level_1', false),
    zip_code: get('postal_code'),
  };
}

function yelpCuisineToGoogleTypes(cuisineStr) {
  if (!cuisineStr || cuisineStr === 'restaurants') return ['restaurant'];
  const mapped = [...new Set(
    cuisineStr.split(',').map(s => YELP_TO_GOOGLE[s.trim()] || 'restaurant')
  )];
  return mapped.length ? mapped : ['restaurant'];
}

const GENERIC_TYPES = new Set([
  'restaurant', 'food', 'point_of_interest', 'establishment',
  'store', 'food_store', 'premise', 'political',
]);

const BASE_URL = 'https://thefoodquest.vercel.app';

async function handleGoogleSearch(res, searchLat, searchLon, resolvedName, params) {
  const { cuisine, budget, miles, minRating, GOOGLE_API_KEY } = params;
  const radiusMeters  = Math.min(Math.round((parseFloat(miles) || 10) * 1609.344), 50000);
  const includedTypes = yelpCuisineToGoogleTypes(cuisine);
  const priceSet      = BUDGET_TO_GOOGLE[budget] ?? null;
  const minRatingVal  = parseFloat(minRating) || 0;

  const FIELD_MASK = [
    'places.id', 'places.displayName', 'places.location',
    'places.rating', 'places.userRatingCount', 'places.priceLevel',
    'places.photos', 'places.businessStatus', 'places.currentOpeningHours',
    'places.formattedAddress', 'places.addressComponents',
    'places.websiteUri', 'places.types',
  ].join(',');

  let gr;
  try {
    gr = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Goog-Api-Key':  GOOGLE_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes,
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: parseFloat(searchLat), longitude: parseFloat(searchLon) },
            radius: radiusMeters,
          },
        },
        rankPreference: 'DISTANCE',
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return res.status(502).json({ error: 'Could not reach Google Places API. Please try again.' });
  }

  if (!gr.ok) {
    const errBody = await gr.json().catch(() => ({}));
    console.error('Google Places error:', gr.status, errBody);
    if (gr.status === 403) return res.status(502).json({ error: 'Google API key invalid or quota exceeded.' });
    return res.status(502).json({ error: 'Could not fetch restaurants. Please try again.' });
  }

  const places = (await gr.json()).places || [];

  // ── Filters ────────────────────────────────────────────────────────────────
  const filtered = places.filter(p => {
    const dist = haversineM(
      parseFloat(searchLat), parseFloat(searchLon),
      p.location?.latitude, p.location?.longitude,
    );
    if (dist > radiusMeters) return false;
    if (priceSet && p.priceLevel && !priceSet.has(p.priceLevel)) return false;
    if (minRatingVal > 0 && (p.rating || 0) < minRatingVal) return false;
    return true;
  });

  // ── Shape into Restaurant format ───────────────────────────────────────────
  const restaurants = filtered.map(p => {
    const addr  = parseGoogleAddress(p.addressComponents);
    const dist  = haversineM(parseFloat(searchLat), parseFloat(searchLon), p.location?.latitude, p.location?.longitude);
    const photo = p.photos?.[0];
    // Photo URL routes through /api/photo so the API key never reaches the client
    const image_url = photo
      ? `${BASE_URL}/api/photo?ref=${encodeURIComponent(photo.name)}`
      : null;

    const categories = (p.types || [])
      .filter(t => !GENERIC_TYPES.has(t))
      .slice(0, 3)
      .map(t => ({ alias: t, title: t.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) }));

    const permClosed = p.businessStatus === 'CLOSED_PERMANENTLY';
    const isOpenNow  = p.currentOpeningHours?.openNow ?? null;

    return {
      id:           p.id,
      name:         p.displayName?.text || 'Unknown',
      image_url,
      url:          p.websiteUri || null,
      website:      p.websiteUri || null,
      rating:       p.rating    || 0,
      review_count: p.userRatingCount || 0,
      price:        GOOGLE_PRICE_DISPLAY[p.priceLevel] || null,
      categories:   categories.length ? categories : [{ alias: 'restaurant', title: 'Restaurant' }],
      distance:     dist,
      location:     addr,
      coordinates:  { latitude: p.location?.latitude, longitude: p.location?.longitude },
      is_open_now:  permClosed ? false : isOpenNow,
      is_closed:    permClosed,
    };
  });

  return res.status(200).json({
    restaurants,
    total:      restaurants.length,
    hasMore:    false,   // Google searchNearby doesn't support offset pagination
    nextOffset: 0,
    geocoded:   resolvedName,
  });
}


// =============================================================================
// MAIN HANDLER — forks to Google or falls through to the original Yelp code
// =============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { lat, lon, address, displayName, cuisine, budget, miles, offset, minRating } = req.query;

  const YELP_API_KEY   = process.env.YELP_API_KEY;
  const MAPBOX_TOKEN   = process.env.MAPBOX_TOKEN;
  const useGoogle      = process.env.RESTAURANT_PROVIDER === 'google';

  if (!useGoogle && !YELP_API_KEY) return res.status(500).json({ error: 'Server misconfigured.' });

  // ── Resolve coordinates ────────────────────────────────────────────────────
  let searchLat    = lat;
  let searchLon    = lon;
  let resolvedName = displayName || address || '';

  if (!searchLat || !searchLon) {
    if (!address?.trim()) {
      return res.status(400).json({ error: 'Please enter a location.' });
    }
    const addr = address.trim();

    // Layer 1: Mapbox (best US coverage, Google Maps-level accuracy)
    if (MAPBOX_TOKEN) {
      try {
        const url =
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(addr)}.json` +
          `?access_token=${MAPBOX_TOKEN}&country=US&limit=1&language=en`;
        const r = await fetch(url, { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const d = await r.json();
          const f = d.features?.[0];
          if (f) {
            searchLat    = String(f.geometry.coordinates[1]);
            searchLon    = String(f.geometry.coordinates[0]);
            resolvedName = f.place_name;
          }
        }
      } catch (_) {}
    }

    // Layer 2: US Census Bureau (official TIGER address database)
    if (!searchLat || !searchLon) {
      try {
        const cp = new URLSearchParams({ address: addr, benchmark: 'Public_AR_Current', format: 'json' });
        const cr = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${cp}`, { signal: AbortSignal.timeout(6000) });
        if (cr.ok) {
          const cd = await cr.json();
          const m  = cd?.result?.addressMatches?.[0];
          if (m) { searchLat = String(m.coordinates.y); searchLon = String(m.coordinates.x); resolvedName = m.matchedAddress; }
        }
      } catch (_) {}
    }

    // Layer 3: Photon
    if (!searchLat || !searchLon) {
      try {
        const pr = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(addr)}&limit=1&lang=en`, { signal: AbortSignal.timeout(5000) });
        if (pr.ok) {
          const pd  = await pr.json();
          const hit = (pd.features || []).find(f => !f.properties?.countrycode || f.properties.countrycode.toUpperCase() === 'US');
          if (hit) {
            searchLat    = String(hit.geometry.coordinates[1]);
            searchLon    = String(hit.geometry.coordinates[0]);
            const p      = hit.properties;
            resolvedName = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.name || ''), p.city || p.town, p.state].filter(Boolean).join(', ');
          }
        }
      } catch (_) {}
    }

    // Layer 4: Nominatim (last resort)
    if (!searchLat || !searchLon) {
      try {
        const np = new URLSearchParams({ q: addr, format: 'json', limit: '1', countrycodes: 'us', 'accept-language': 'en' });
        const nr = await fetch(`https://nominatim.openstreetmap.org/search?${np}`, { headers: { 'User-Agent': 'TheHearthApp/1.0' }, signal: AbortSignal.timeout(5000) });
        if (nr.ok) { const nd = await nr.json(); if (nd?.length) { searchLat = nd[0].lat; searchLon = nd[0].lon; resolvedName = nd[0].display_name; } }
      } catch (_) {}
    }

    if (!searchLat || !searchLon) {
      return res.status(404).json({ error: `Could not locate "${addr}". Try selecting a suggestion from the dropdown, or add a city and state.` });
    }
  }

  // ── Provider fork ──────────────────────────────────────────────────────────
  if (useGoogle) {
    const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
    if (!GOOGLE_API_KEY) return res.status(500).json({ error: 'Server misconfigured (missing Google key).' });
    return handleGoogleSearch(res, searchLat, searchLon, resolvedName, {
      cuisine:  cuisine || 'restaurants',
      budget:   budget  || 'any',
      miles:    miles   || 10,
      minRating: minRating || 0,
      GOOGLE_API_KEY,
    });
  }

  // ==========================================================================
  // YELP PROVIDER — everything below this line is the original Yelp code,
  // completely unchanged. To revert, remove RESTAURANT_PROVIDER=google from
  // Vercel env vars (or set it back to 'yelp').
  // ==========================================================================

  // ── Filters ────────────────────────────────────────────────────────────────
  const priceMap       = { '1':'1', '2':'2', '3':'3', '4':'4', any:'1,2,3,4' };
  const priceFilter    = priceMap[budget] || '1,2,3,4';
  const categoryFilter = cuisine || 'restaurants';

  // Yelp hard-caps radius at 40 000 m (≈ 24.85 mi); clamp silently.
  const radiusMeters = Math.min(Math.round((parseFloat(miles) || 10) * 1609.344), 40000);

  // yelpOffset tracks position in Yelp's unfiltered result set so Show More
  // never re-fetches pages already processed.
  const yelpOffset = Math.max(0, parseInt(offset) || 0);

  // ── Yelp search ────────────────────────────────────────────────────────────
  const yp = new URLSearchParams({
    latitude:   searchLat,
    longitude:  searchLon,
    categories: categoryFilter,
    price:      priceFilter,
    sort_by:    'distance',
    limit:      '20',
    radius:     String(radiusMeters),
    offset:     String(yelpOffset),
  });
  const yr = await fetch(`https://api.yelp.com/v3/businesses/search?${yp}`, { headers: { Authorization: `Bearer ${YELP_API_KEY}` } });

  if (!yr.ok) {
    if (yr.status === 401) return res.status(502).json({ error: 'Yelp API key invalid.' });
    return res.status(502).json({ error: 'Could not fetch restaurants. Please try again.' });
  }

  const yd         = await yr.json();
  const businesses = yd.businesses || [];

  // Healthy blocklist: category aliases are food-type tags, not health indicators.
  const HEALTHY_BLOCKLIST = new Set(['icecream', 'chicken_wings', 'icecreameries', 'hotdog', 'hotdogs']);
  const afterHealthy = categoryFilter.includes('healthfood')
    ? businesses.filter(b => !(b.categories || []).some(c => HEALTHY_BLOCKLIST.has(c.alias)))
    : businesses;

  // Strict radius: exclude any result with no distance data or outside the radius.
  const afterRadius = afterHealthy.filter(b => b.distance != null && b.distance <= radiusMeters);

  // Minimum star rating (Yelp has no native filter for this).
  const minRatingVal = parseFloat(minRating) || 0;
  const results = minRatingVal > 0
    ? afterRadius.filter(b => (b.rating || 0) >= minRatingVal)
    : afterRadius;

  // nextOffset advances past the Yelp page we just fetched (pre-filter count),
  // so subsequent Show More calls don't overlap.
  const nextOffset = yelpOffset + businesses.length;
  const hasMore    = nextOffset < (yd.total || 0);

  // Enrich all results via detail endpoint to get website URL and live open/closed status.
  // All calls fire in parallel so latency is bounded by the slowest single call.
  const enriched = await Promise.allSettled(
    results.map(async b => {
      try {
        const dr = await fetch(`https://api.yelp.com/v3/businesses/${b.id}`, { headers: { Authorization: `Bearer ${YELP_API_KEY}` } });
        if (dr.ok) {
          const dd = await dr.json();
          return { ...b, website: dd.website || null, is_open_now: dd.hours?.[0]?.is_open_now ?? null };
        }
      } catch (_) {}
      return { ...b, website: null, is_open_now: null };
    })
  );
  const enrichedMap = {};
  enriched.forEach((r, i) => { if (r.status === 'fulfilled') enrichedMap[results[i].id] = r.value; });

  return res.status(200).json({
    restaurants: results.map(b => enrichedMap[b.id] || b),
    total:       yd.total || 0,
    hasMore,
    nextOffset,
    geocoded:    resolvedName,
  });
}