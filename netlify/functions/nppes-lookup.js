// Netlify Serverless Function: NPPES Registry Proxy
// Bypasses browser CORS restrictions on npiregistry.cms.hhs.gov
// Deploy: netlify/functions/nppes-lookup.js

// Use global fetch (Node 18+) or fall back to node-fetch
const doFetch = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

exports.handler = async (event) => {
  const npi = event.queryStringParameters?.npi;

  if (!npi || !/^\d{10}$/.test(npi)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid NPI. Must be 10 digits.' })
    };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400'
  };

  try {
    const res = await doFetch(
      `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${npi}`
    );

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: 'NPPES API returned ' + res.status })
      };
    }

    const data = await res.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'NPPES API request failed', detail: err.message })
    };
  }
};
