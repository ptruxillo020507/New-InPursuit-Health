// Netlify Serverless Function: CMS Medicare Data Proxy
// Bypasses browser CORS restrictions on data.cms.gov
// Deploy: netlify/functions/cms-lookup.js

const DATASETS = {
  aggregate: '8889d81e-2ee7-448f-8713-f071038289b5',  // By Provider
  byService: '92396110-2aed-4d63-a6a2-5d6207d46a29'   // By Provider & Service (HCPCS)
};

// Use global fetch (Node 18+) or fall back to node-fetch
const doFetch = typeof fetch === 'function'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

exports.handler = async (event) => {
  const npi = event.queryStringParameters?.npi;

  if (!npi || !/^\d{10}$/.test(npi)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid NPI. Must be 10 digits.' }) };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400'
  };

  try {
    // Fetch both datasets in parallel
    const [aggRes, svcRes] = await Promise.all([
      doFetch(`https://data.cms.gov/data-api/v1/dataset/${DATASETS.aggregate}/data?filter[Rndrng_NPI]=${npi}&size=1`),
      doFetch(`https://data.cms.gov/data-api/v1/dataset/${DATASETS.byService}/data?filter[Rndrng_NPI]=${npi}&size=500`)
    ]);

    const agg = aggRes.ok ? await aggRes.json() : [];
    const svc = svcRes.ok ? await svcRes.json() : [];

    if (!agg.length && !svc.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No CMS data found for this NPI', npi }) };
    }

    // Parse aggregate data
    const d = agg.length ? agg[0] : {};
    const result = {
      npi,
      year: 2023,
      total_medicare_payment: parseFloat(d.Tot_Mdcr_Plymt_Amt || d.tot_mdcr_plymt_amt || 0),
      total_beneficiaries: parseInt(d.Tot_Benes || d.tot_benes || 0),
      total_services: parseInt(d.Tot_Srvcs || d.tot_srvcs || 0),
      hcpcs: {}
    };

    // Parse HCPCS service-level data
    const vbcCodes = ['99490','99491','99453','99454','99457','99458','G0438','G0439','99495','99496','99484'];
    const codeNames = {
      '99490':'CCM','99491':'CCM Complex','99453':'RPM Setup','99454':'RPM Device',
      '99457':'RPM Mgmt','99458':'RPM Addl','G0438':'AWV Initial','G0439':'AWV Subsequent',
      '99495':'TCM 14-day','99496':'TCM 7-day','99484':'BHI'
    };

    vbcCodes.forEach(code => {
      result.hcpcs[code] = { name: codeNames[code], services: 0, beneficiaries: 0, payment: 0 };
    });

    if (svc.length) {
      svc.forEach(row => {
        const code = row.HCPCS_Cd || row.hcpcs_cd || '';
        if (result.hcpcs[code]) {
          const avgPay = parseFloat(row.Avg_Mdcr_Pymt_Amt || row.avg_mdcr_pymt_amt || 0);
          const services = parseInt(row.Tot_Srvcs || row.tot_srvcs || 0);
          const benes = parseInt(row.Tot_Benes || row.tot_benes || 0);
          result.hcpcs[code].services += services;
          result.hcpcs[code].beneficiaries += benes;
          result.hcpcs[code].payment += Math.round(avgPay * services);
        }
      });
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'CMS API request failed', detail: err.message }) };
  }
};
